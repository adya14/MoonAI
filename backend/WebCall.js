// Filename: WebCall.js

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { OpenAI } = require('openai');
const axios = require('axios'); // Still used for OpenRouter
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const router = express.Router();

// --- Audio Processing Library ---
const { WaveFile } = require('wavefile');

// --- Google Cloud Text-to-Speech Client ---
// We keep the client initialization code here in case you want to re-enable it later.
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
let textToSpeechClient;
try {
    textToSpeechClient = new TextToSpeechClient();
    console.log("Google Cloud TextToSpeechClient initialized successfully (but is currently disabled for TTS synthesis).");
} catch (e) {
    console.error("Failed to initialize Google Cloud TextToSpeechClient. Ensure GOOGLE_APPLICATION_CREDENTIALS is set correctly.", e);
    // If this fails, textToSpeechClient will be undefined, and the code will fallback to browser TTS.
}

// --- Configuration ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const openRouterApiKey = process.env.DEEPSEEK_API;

// --- Google Cloud Voice Mapping (kept for potential future use) ---
const francToGoogleVoiceConfig = {
  'eng': { languageCode: 'en-US', name: 'en-US-Standard-C', ssmlGender: 'FEMALE' },
  'hin': { languageCode: 'hi-IN', name: 'hi-IN-Standard-C', ssmlGender: 'FEMALE' },
  'und': { languageCode: 'en-US', name: 'en-US-Standard-C', ssmlGender: 'FEMALE' }
};
const defaultGoogleVoiceConfig = { languageCode: 'en-US', name: 'en-US-Standard-C', ssmlGender: 'FEMALE' };

const openRouterUrl = "https://openrouter.ai/api/v1/chat/completions";
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- Helper Function to Trim Trailing Silence ---
/**
 * Trims trailing silence from an audio buffer (PCM data).
 * @param {Int16Array} samples The PCM audio samples.
 * @param {number} sampleRate The sample rate of the audio.
 * @param {number} silenceThreshold RMS amplitude considered as silence (e.g., 0.01 for normalized -1 to 1).
 * @param {number} minSilenceDurationSec Minimum duration of silence at the end to trim (in seconds).
 * @returns {Int16Array} The trimmed PCM audio samples.
 */
function trimTrailingSilence(samples, sampleRate, silenceThreshold = 0.005, minSilenceDurationSec = 0.7) {
    if (!samples || samples.length === 0) {
        return samples;
    }

    const minSilenceSamples = Math.floor(minSilenceDurationSec * sampleRate);
    let lastNonSilentSampleIndex = samples.length - 1;

    for (let i = samples.length - 1; i >= 0; i--) {
        const normalizedSample = samples[i] / 32768;
        if (Math.abs(normalizedSample) > silenceThreshold) {
            lastNonSilentSampleIndex = i;
            break;
        }
    }

    const trailingSilenceSamples = samples.length - 1 - lastNonSilentSampleIndex;
    if (trailingSilenceSamples >= minSilenceSamples) {
        console.log(`Trimming ${trailingSilenceSamples / sampleRate}s of trailing silence.`);
        return samples.slice(0, lastNonSilentSampleIndex + 1);
    }

    console.log("No significant trailing silence to trim or speech ends at the very end.");
    return samples;
}

// --- Helper Function to call Google Cloud TTS API (kept for potential future use) ---
async function getGoogleCloudTTS(text, voiceConfig) {
    if (!textToSpeechClient) {
        const error = new Error("Google Cloud TextToSpeechClient not initialized.");
        error.status = 500;
        throw error;
    }
    const effectiveVoiceConfig = voiceConfig || defaultGoogleVoiceConfig;
    console.log(`Attempting Google Cloud TTS with Language: ${effectiveVoiceConfig.languageCode}, Voice: ${effectiveVoiceConfig.name}`);
    const request = {
        input: { text: text },
        voice: {
            languageCode: effectiveVoiceConfig.languageCode,
            name: effectiveVoiceConfig.name,
        },
        audioConfig: { audioEncoding: 'MP3' },
    };
    try {
        const [response] = await textToSpeechClient.synthesizeSpeech(request);
        const bufferStream = new Readable();
        bufferStream.push(response.audioContent);
        bufferStream.push(null);
        console.log('Google Cloud TTS successful.');
        return bufferStream;
    } catch (error) {
        console.error("Google Cloud TTS API Call Error:", error);
        const gcpError = new Error(`Google Cloud TTS failed: ${error.message}`);
        gcpError.isGoogleCloudError = true;
        gcpError.originalError = error;
        throw gcpError;
    }
}

// --- Main API Route ---
router.post('/process-web-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' });

    let tempFilePath;
    let conversationHistory = [];
    let userText = '';
    let aiResponseText = '';

    try {
        // --- Conversation History Management ---
        if (req.body.history) {
            try {
                conversationHistory = JSON.parse(req.body.history);
                if (!Array.isArray(conversationHistory) || !conversationHistory.every(msg => typeof msg === 'object' && 'role' in msg && 'content' in msg)) {
                     console.warn("Received invalid conversation history format, resetting.");
                     conversationHistory = [{ role: "system", content: "You are a helpful assistant and your name is Moon. Respond naturally in the language appropriate to the user's query or context, unless specifically asked otherwise. Keep responses concise. Keep responses short 5-6 lines maximum. Strictly do not include any emojis of special unecessary characters" }];
                }
                 const MAX_HISTORY_TURNS = 10; // Each turn is a user message + AI response
                 if (conversationHistory.length > (MAX_HISTORY_TURNS * 2) + 1) { // +1 for system message
                      conversationHistory = [
                          conversationHistory[0], // Keep system message
                          ...conversationHistory.slice(-(MAX_HISTORY_TURNS * 2)) // Keep last N turns
                      ];
                      console.log("Truncated conversation history.");
                 }
            } catch (parseError) {
                console.error("Error parsing conversation history:", parseError);
                 conversationHistory = [{ role: "system", content: "You are a helpful assistant and your name is Moon. Respond naturally in the language appropriate to the user's query or context, unless specifically asked otherwise. Keep responses concise. Keep responses short 5-6 lines maximum. Strictly do not include any emojis of special unecessary characters" }];
            }
        } else {
             conversationHistory = [{ role: "system", content: "You are a helpful assistant and your name is Moon. Respond naturally in the language appropriate to the user's query or context, unless specifically asked otherwise. Keep responses concise. Keep responses short 5-6 lines maximum. Strictly do not include any emojis of special unecessary characters" }];
        }

        // --- 1. Audio Pre-processing (Silence Trimming) & Transcription ---
        console.log("Received audio. Processing for silence trimming...");
        let audioBufferToTranscribe = req.file.buffer;

        try {
            const wav = new WaveFile(req.file.buffer);
            if (wav.fmt.sampleRate !== 16000 || wav.fmt.numChannels !== 1 || wav.bitDepth !== '16') {
                 console.warn(`Received audio with format: ${wav.fmt.sampleRate}Hz, ${wav.fmt.numChannels}ch, ${wav.bitDepth}bit. Silence trimming expects 16-bit mono @ 16kHz for best results with current settings.`);
            }

            if (wav.bitDepth === '16' && wav.fmt.numChannels === 1) { // Only process if it's 16-bit mono PCM
                const pcmSamples = wav.getSamples(false, Int16Array);
                const trimmedSamples = trimTrailingSilence(pcmSamples, wav.fmt.sampleRate, 0.005, 0.7);

                if (trimmedSamples.length < pcmSamples.length && trimmedSamples.length > 0) {
                    const trimmedWav = new WaveFile();
                    // Ensure the sample rate used here matches what Whisper expects (typically 16000)
                    trimmedWav.fromScratch(1, wav.fmt.sampleRate, '16', trimmedSamples);
                    audioBufferToTranscribe = trimmedWav.toBuffer();
                    console.log("Audio trimmed. Original size:", req.file.buffer.length, "Trimmed size:", audioBufferToTranscribe.length);
                } else if (trimmedSamples.length === 0) {
                    console.log("Audio fully trimmed (all silence or too short). Sending original to Whisper.");
                } else {
                    console.log("No significant trailing silence trimmed.");
                }
            } else {
                console.warn(`Audio is not 16-bit mono PCM (${wav.bitDepth}-bit, ${wav.fmt.numChannels}ch), skipping silence trimming. Ensure frontend sends 16-bit mono PCM WAV for trimming.`);
            }
        } catch (waveError) {
            console.error("Error processing WAV for silence trimming. Using original audio.", waveError);
        }

        console.log("Transcribing audio...");
        try {
            const tempFileName = `temp_audio_trimmed_${Date.now()}.wav`;
            tempFilePath = path.join(os.tmpdir(), tempFileName);
            fs.writeFileSync(tempFilePath, audioBufferToTranscribe);

            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(tempFilePath), model: 'whisper-1',
            });
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); tempFilePath = null;
            userText = transcription.text;
            console.log("Transcription:", userText);
            if (!userText || userText.trim().length === 0) {
                return res.status(200).json({
                    message: 'Silence or no speech detected by Whisper.',
                    aiResponseText: '', ttsFallback: true, userTranscription: ''
                });
            }
        } catch (transcriptionError) {
            console.error("Transcription Error:", transcriptionError);
            if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            throw new Error("Failed to transcribe audio.");
        }

        // --- 2. Get AI Response ---
        console.log("Getting AI response via OpenRouter...");
        if (!openRouterApiKey) throw new Error("AI API key (DEEPSEEK_API) not configured.");
        const openRouterHeaders = {
            "Content-Type": "application/json", "Authorization": `Bearer ${openRouterApiKey}`,
            "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:3000",
            "X-Title": "MoonAI Web Demo",
        };
        const messagesForAI = [...conversationHistory, { role: "user", content: userText }];
        const openRouterPayload = { model: "deepseek/deepseek-chat", messages: messagesForAI, max_tokens: 1000, temperature: 0.7 };
        try {
            const openRouterResponse = await axios.post(openRouterUrl, openRouterPayload, { headers: openRouterHeaders });
            aiResponseText = openRouterResponse.data.choices[0]?.message?.content?.trim();
            console.log("OpenRouter AI Response Text:", aiResponseText);
            if (!aiResponseText) throw new Error('AI response format invalid or empty.');
        } catch (error) {
            console.error("OpenRouter API Axios Error:", error.isAxiosError ? { status: error.response?.status, data: error.response?.data, message: error.message } : error);
            let errorMessage = "Failed to get response from AI via OpenRouter.";
            if (error.response?.status === 401) errorMessage = "OpenRouter authentication failed. Check your API key (DEEPSEEK_API).";
            else if (error.response?.status === 429) errorMessage = "OpenRouter rate limit hit or free tier exhausted.";
            throw new Error(errorMessage);
        }

        // --- 3. Synthesize AI Response ---
        // --- GOOGLE CLOUD TTS IS DISABLED FOR COST SAVING ---
        const ttsSuccessful = false; // <<< FORCE TTS TO FAIL for now
        let audioStream = null;
        // let ttsErrorDetails = new Error("Premium TTS (Google Cloud) is disabled for testing. Using browser TTS.");

        // --- 4. Send Response ---
        // Because `ttsSuccessful` is now always false, the code will always execute the `else` block.
        if (ttsSuccessful && audioStream) {
             // This block will NOT be reached as long as ttsSuccessful is false
             console.log("Streaming Google Cloud audio response to frontend.");
             res.setHeader('Content-Type', 'audio/mpeg');
             res.setHeader('X-AI-Response-Text', encodeURIComponent(aiResponseText));
             res.setHeader('X-User-Transcription', encodeURIComponent(userText));
             audioStream.pipe(res);
             audioStream.on('error', (streamError) => console.error("Google Cloud audio stream pipe error:", streamError));
             audioStream.on('end', () => console.log('Google Cloud audio stream finished piping.'));
             req.on('close', () => {
                 console.log("Client closed connection during Google Cloud streaming.");
                 if (audioStream.destroy) audioStream.destroy();
                 else if (audioStream.unpipe) audioStream.unpipe(res);
             });
        } else {
            // --- This block WILL ALWAYS be reached due to ttsSuccessful = false ---
            // Fallback: Send JSON response with AI text for browser TTS
            console.log("Premium TTS disabled. Using fallback: Sending JSON response for browser TTS.");
            res.status(200).json({
                message: "Premium TTS synthesis disabled. Using browser speech.", // Clearer message
                aiResponseText: aiResponseText,
                ttsFallback: true, // This tells the frontend to use its own TTS
                userTranscription: userText
            });
        }

    } catch (error) { // Main catch block for the entire route
        console.error("!! Caught Error in /process-web-audio:", error.message, error.stack);
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
            } catch (unlinkErr) {
                console.error("Error cleaning up temp audio file during error handling:", unlinkErr);
            }
        }
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || 'An internal server error occurred.' });
        } else {
            console.error("Headers already sent, cannot send error JSON to client for this error.");
        }
    }
});

module.exports = router;
