// Filename: WebCall.js (Fixed franc import)

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { OpenAI } = require('openai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
// ** REMOVE the require('franc') from here **

const router = express.Router();

// --- Configuration ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const elevenLabsApiKey = process.env.ELEVENLABS_API;
const openRouterApiKey = process.env.DEEPSEEK_API; // Using this var for OpenRouter key

// --- Define Language to Voice ID Mapping ---
const languageToVoiceId = {
  'hin': process.env.ELEVENLABS_VOICE_ID_HINDI || 'gHu9GtaHOXcSqFTK06ux', // Hindi - User provided ID
  'eng': process.env.ELEVENLABS_VOICE_ID_ENGLISH || '21m00Tcm4TlvDq8ikWAM', // English - Rachel (Default)
  'und': process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM', // Undetermined language
  'default': process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM' // Default fallback
};
// --- End of Mapping ---

const openRouterUrl = "https://openrouter.ai/api/v1/chat/completions";

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- Helper Function to call ElevenLabs API ---
async function getElevenLabsTTS(text, voiceId) {
    // (Function remains the same as previous version)
    if (!elevenLabsApiKey) throw new Error("ElevenLabs API key not configured");
    if (!voiceId) {
        console.warn("No voice ID provided to TTS, using default.");
        voiceId = languageToVoiceId['default'];
    }
    const elevenLabsUrlForVoice = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
    console.log(`Using ElevenLabs Voice ID: ${voiceId} for TTS.`);
    const headers = {
        "Accept": "audio/mpeg", "Content-Type": "application/json", "xi-api-key": elevenLabsApiKey,
    };
    const data = {
        text: text, model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, optimize_streaming_latency: 3, },
    };
    try {
        const response = await axios.post(elevenLabsUrlForVoice, data, { headers: headers, responseType: 'stream' });
        return response.data;
    } catch (error) {
        console.error(`ElevenLabs API Error (Voice ID: ${voiceId}):`, error.response ? JSON.stringify(error.response.data) : error.message);
        let errorMessage = "Failed to synthesize speech.";
        if (error.response?.data?.detail?.message) { errorMessage += ` Reason: ${error.response.data.detail.message}`; }
        else if (error.response?.statusText) { errorMessage += ` Status: ${error.response.statusText}`; }
        else if (error.response?.data?.detail?.status === 'voice_not_found') { errorMessage = `Voice ID ${voiceId} not found or unavailable. Check configuration.`; }
        throw new Error(errorMessage);
    }
}


// --- Main API Route ---
router.post('/process-web-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' });
    let tempFilePath;
    try {
      // --- 1. Transcription ---
      console.log("Transcribing audio...");
      const tempFileName = `temp_audio_${Date.now()}.wav`;
      tempFilePath = path.join(os.tmpdir(), tempFileName);
      fs.writeFileSync(tempFilePath, req.file.buffer);
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath), model: 'whisper-1',
      });
      fs.unlinkSync(tempFilePath); tempFilePath = null;
      const userText = transcription.text;
      console.log("Transcription:", userText);
      if (!userText || userText.trim().length === 0) {
        return res.status(400).json({ error: 'Could not understand audio or silence detected.' });
      }

      // --- 2. Get AI Response ---
       console.log("Getting AI response via OpenRouter...");
        if (!openRouterApiKey) throw new Error("AI API key not configured.");
        const openRouterHeaders = { /* ... headers ... */
             "Content-Type": "application/json", "Authorization": `Bearer ${openRouterApiKey}`,
             "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:3000", // Use env var or default
             "X-Title": "MoonAI Web Demo",
        };
        const openRouterPayload = { /* ... payload ... */
             model: "deepseek/deepseek-chat",
             messages: [ { role: "system", content: "You are a helpful assistant and your name is Moon. Respond naturally in the language appropriate to the user's query or context, unless specifically asked otherwise. Keep responses concise." }, { role: "user", content: userText } ],
             max_tokens: 100, temperature: 0.7,
        };
        let aiResponseText;
        try {
            const openRouterResponse = await axios.post(openRouterUrl, openRouterPayload, { headers: openRouterHeaders });
            aiResponseText = openRouterResponse.data.choices[0]?.message?.content?.trim();
            console.log("OpenRouter AI Response Text:", aiResponseText);
            if (!aiResponseText) throw new Error('AI response format invalid or empty.');
        } catch (error) { /* ... error handling ... */
             console.error("OpenRouter API Axios Error:", error.isAxiosError ? { status: error.response?.status, data: error.response?.data, message: error.message } : error.message);
             if (error.response?.status === 401) throw new Error("OpenRouter authentication failed. Check your API key (DEEPSEEK_API_KEY env var).");
             else if (error.response?.status === 429) throw new Error("OpenRouter rate limit hit or free tier exhausted.");
             else throw new Error("Failed to get response from AI via OpenRouter.");
        }


      // --- 2.5 Detect Language of AI Response ---
      // ** USE DYNAMIC IMPORT HERE **
      const { franc } = await import('franc');
      // *****************************
      const detectedLangCode = franc(aiResponseText, { minLength: 3 });
      console.log(`Detected language code: ${detectedLangCode}`);

      // --- Determine Target Voice ID ---
      let targetVoiceId = languageToVoiceId[detectedLangCode] || languageToVoiceId['und'] || languageToVoiceId['default'];
      targetVoiceId = targetVoiceId || '21m00Tcm4TlvDq8ikWAM'; // Final fallback

      // --- 3. Synthesize AI Response using TTS ---
      console.log(`Synthesizing speech in lang '${detectedLangCode}' using voice ${targetVoiceId}...`);
      const audioStream = await getElevenLabsTTS(aiResponseText, targetVoiceId);

      // --- 4. Stream Audio Response ---
       console.log("Streaming audio response...");
        res.setHeader('Content-Type', 'audio/mpeg');
        audioStream.pipe(res);
        audioStream.on('error', (streamError) => { /* ... */ });
        req.on('close', () => { /* ... */ });

    } catch (error) {
        // ... (Error handling remains the same) ...
         console.error("!! Caught Error in /process-web-audio:", error.message);
        if (tempFilePath && fs.existsSync(tempFilePath)) { /* ... cleanup ... */ }
        if (!res.headersSent) {
             res.status(500).json({ error: error.message || 'An internal server error occurred.' });
        }
    }
});

module.exports = router;