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
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
let textToSpeechClient;
try {
    textToSpeechClient = new TextToSpeechClient();
    console.log("Google Cloud TextToSpeechClient initialized successfully.");
} catch (e) {
    console.error("Failed to initialize Google Cloud TextToSpeechClient. Ensure GOOGLE_APPLICATION_CREDENTIALS is set correctly.", e);
    // If this fails, textToSpeechClient will be undefined, and the code will fallback to browser TTS.
}

// --- Configuration ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const openRouterApiKey = process.env.DEEPSEEK_API;

// --- Google Cloud Voice Mapping ---
// Note: You can customize these voices. For the most natural voices, use 'Studio' or 'Wavenet' types.
// e.g., 'en-US-Studio-O' for a premium female voice.
const francToGoogleVoiceConfig = {
  'eng': { languageCode: 'en-US', name: 'en-US-Studio-O', ssmlGender: 'FEMALE' },
  'hin': { languageCode: 'hi-IN', name: 'hi-IN-Wavenet-C', ssmlGender: 'FEMALE' },
  'und': { languageCode: 'en-US', name: 'en-US-Studio-O', ssmlGender: 'FEMALE' }
};
const defaultGoogleVoiceConfig = { languageCode: 'en-US', name: 'en-US-Studio-O', ssmlGender: 'FEMALE' };


const openRouterUrl = "https://openrouter.ai/api/v1/chat/completions";
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- Helper to send data chunks in [length][type][payload] format ---
const CHUNK_TYPE = { TEXT: 0, AUDIO: 1 };

function sendChunk(res, type, payload) {
    const payloadLength = Buffer.byteLength(payload);
    const header = Buffer.alloc(5);
    // Use Big-Endian format for network byte order
    header.writeUInt32BE(payloadLength, 0); 
    header.writeUInt8(type, 4);
    res.write(header);
    res.write(payload);
}

// --- Helper Function to Trim Trailing Silence ---
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

// --- Helper Function to call Google Cloud TTS API ---
// --- Google Cloud TTS API Call (Now returns a stream) ---
async function getGoogleCloudTTSStream(text, voiceConfig) {
    if (!textToSpeechClient) throw new Error("Google TTS Client not initialized.");
    const effectiveVoiceConfig = voiceConfig || defaultGoogleVoiceConfig;
    const request = {
        input: { text },
        voice: { languageCode: effectiveVoiceConfig.languageCode, name: effectiveVoiceConfig.name },
        audioConfig: { audioEncoding: 'MP3' },
    };
    // The response contains the audio content buffer.
    const [response] = await textToSpeechClient.synthesizeSpeech(request);
    // Convert the buffer into a readable stream for piping.
    return Readable.from(response.audioContent);
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
                 const MAX_HISTORY_TURNS = 10;
                 if (conversationHistory.length > (MAX_HISTORY_TURNS * 2) + 1) {
                      conversationHistory = [
                          conversationHistory[0],
                          ...conversationHistory.slice(-(MAX_HISTORY_TURNS * 2))
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

        // --- 1. Audio Pre-processing & Transcription ---
        console.log("Received audio. Processing for silence trimming...");
        let audioBufferToTranscribe = req.file.buffer;

        try {
            const wav = new WaveFile(req.file.buffer);
            if (wav.fmt.sampleRate !== 16000 || wav.fmt.numChannels !== 1 || wav.bitDepth !== '16') {
                 console.warn(`Received audio with format: ${wav.fmt.sampleRate}Hz, ${wav.fmt.numChannels}ch, ${wav.bitDepth}bit. Silence trimming expects 16-bit mono @ 16kHz for best results with current settings.`);
            }
            if (wav.bitDepth === '16' && wav.fmt.numChannels === 1) {
                const pcmSamples = wav.getSamples(false, Int16Array);
                const trimmedSamples = trimTrailingSilence(pcmSamples, wav.fmt.sampleRate, 0.005, 0.7);
                if (trimmedSamples.length < pcmSamples.length && trimmedSamples.length > 0) {
                    const trimmedWav = new WaveFile();
                    trimmedWav.fromScratch(1, wav.fmt.sampleRate, '16', trimmedSamples);
                    audioBufferToTranscribe = trimmedWav.toBuffer();
                    console.log("Audio trimmed. Original size:", req.file.buffer.length, "Trimmed size:", audioBufferToTranscribe.length);
                } else if (trimmedSamples.length === 0) {
                    console.log("Audio fully trimmed (all silence or too short). Sending original to Whisper.");
                } else {
                    console.log("No significant trailing silence trimmed.");
                }
            } else {
                console.warn(`Audio is not 16-bit mono PCM (${wav.bitDepth}-bit, ${wav.fmt.numChannels}ch), skipping silence trimming.`);
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

        // --- 2. Start Streaming Response to Client ---
        // Set the headers for a chunked, binary stream.
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream', // Sending binary data
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache',
            'X-User-Transcription': encodeURIComponent(userText) // Send transcription once
        });

        // --- 3. Get AI Response (Streaming) and Pipe to TTS ---
        const messagesForAI = [...conversationHistory, { role: "user", content: userText }];
        
        const openRouterPayload = { 
            model: "deepseek/deepseek-chat", 
            messages: messagesForAI, 
            temperature: 0.7, 
            stream: true // Enable streaming
        };
        const openRouterHeaders = {
            "Authorization": `Bearer ${openRouterApiKey}`,
            "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:3000",
            "X-Title": "MoonAI Web Demo",
        };

        // Use axios to get a response stream
        const llmStreamResponse = await axios.post(openRouterUrl, openRouterPayload, {
            headers: openRouterHeaders,
            responseType: 'stream'
        });

        let sentenceBuffer = '';
        const llmStream = llmStreamResponse.data;

        // Process the stream from the LLM
        for await (const chunk of llmStream) {
            const lines = chunk.toString('utf8').split('\n').filter(line => line.trim().startsWith('data:'));
            
            for (const line of lines) {
                const data = line.replace(/^data: /, '').trim();
                
                // Check for the end-of-stream signal
                if (data === '[DONE]') {
                    // If any text remains in the buffer, process it as the final sentence
                    if (sentenceBuffer.trim()) {
                        const textToSpeak = sentenceBuffer.trim();
                        console.log(`AI Sentence (Terminal): "${textToSpeak}"`);
                        sendChunk(res, CHUNK_TYPE.TEXT, JSON.stringify({ text: textToSpeak }));
                        const audioStream = await getGoogleCloudTTSStream(textToSpeak);
                        for await (const audioChunk of audioStream) {
                            sendChunk(res, CHUNK_TYPE.AUDIO, audioChunk);
                        }
                    }
                    res.end(); // IMPORTANT: Close the connection to the client
                    return; // Exit the function
                }
                
                // Parse the JSON data from the stream
                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices[0]?.delta?.content || '';
                    if (delta) {
                        sentenceBuffer += delta;
                        // Use a regex to find sentences ending with . ? !
                        const sentenceEndRegex = /(?<=[.?!])\s+/;
                        let sentences = sentenceBuffer.split(sentenceEndRegex);

                        // If we have at least one complete sentence
                        if (sentences.length > 1) {
                            const completeSentences = sentences.slice(0, -1);
                            sentenceBuffer = sentences[sentences.length - 1]; // Keep the remainder
                            
                            for (const textToSpeak of completeSentences) {
                                if (textToSpeak.trim()) {
                                    console.log(`AI Sentence (Terminal): "${textToSpeak}"`);
                                    // 1. Send the text chunk to the frontend
                                    sendChunk(res, CHUNK_TYPE.TEXT, JSON.stringify({ text: textToSpeak }));
                                    // 2. Get the audio stream for that text
                                    const audioStream = await getGoogleCloudTTSStream(textToSpeak);
                                    // 3. Stream the audio chunks to the frontend
                                    for await (const audioChunk of audioStream) {
                                       sendChunk(res, CHUNK_TYPE.AUDIO, audioChunk);
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error("Error parsing LLM stream chunk:", e);
                }
            }
        }

        // --- 3. Synthesize AI Response ---
        let audioStream = null;
        let ttsErrorDetails = null;
        let ttsSuccessful = false;

        try {
             // Attempt to use Google Cloud TTS
             console.log("Attempting to synthesize audio with Google Cloud TTS...");
             audioStream = await getGoogleCloudTTS(aiResponseText, null); // Use default voice for now
             ttsSuccessful = true;
        } catch(ttsError) {
             console.error("Could not synthesize audio with Google Cloud TTS, falling back to browser.", ttsError);
             ttsErrorDetails = ttsError;
             ttsSuccessful = false;
        }

        // --- 4. Send Response ---
        if (ttsSuccessful && audioStream) {
             console.log("Streaming Google Cloud audio response to frontend.");
             res.setHeader('Content-Type', 'audio/mpeg'); // Changed to audio/mpeg for MP3
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
            // Fallback: Send JSON response with AI text for browser TTS
            console.log("TTS synthesis failed or disabled. Using fallback: Sending JSON response for browser TTS.");
            res.status(200).json({
                message: "Premium TTS synthesis failed. Using browser speech.", // Clearer message
                aiResponseText: aiResponseText,
                ttsFallback: true, // This tells the frontend to use its own TTS
                userTranscription: userText,
                error: ttsErrorDetails ? ttsErrorDetails.message : "TTS was disabled or failed."
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