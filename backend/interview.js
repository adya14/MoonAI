// No changes are needed in interview.js for Sarvam TTS integration.
// It already handles transcription and AI response generation.

const { getInterviewPrompt, getScoringPrompt } = require('./prompt'); // Assuming prompt.js exists and is correct
const { OpenAI } = require('openai');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

// Check if OpenAI key is available
if (!openai) {
    console.warn("Warning: OPENAI_API_KEY not found in environment. Transcription and potentially scoring will fail.");
}
// Check for DeepSeek/OpenRouter key
if (!process.env.DEEPSEEK_API) {
    console.warn("Warning: DEEPSEEK_API key not found in environment. AI response generation will fail.");
}


/**
 * Transcribes an audio buffer using OpenAI Whisper API.
 * @param {Buffer} audioBuffer - The WAV audio buffer to transcribe.
 * @param {string} callSid - For logging.
 * @returns {Promise<string>} Transcription text.
 */
async function transcribeBuffer(audioBuffer, callSid) {
  if (!openai) {
      console.error(`[${callSid}] Cannot transcribe: OpenAI API key not configured.`);
      throw new Error("OpenAI API key not configured.");
  }
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
       console.error(`[${callSid}] Invalid or empty buffer provided for transcription.`);
       throw new Error("Invalid audio buffer for transcription.");
  }

  console.log(`[${callSid}] Transcribing audio buffer (${audioBuffer.length} bytes) using Whisper...`);

  try {
    // Approach 2: Save buffer to temp file (More Reliable)
    const tempDir = path.join(__dirname, 'temp_transcribe');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, `${callSid}_${Date.now()}.wav`);

    fs.writeFileSync(tempFilePath, audioBuffer);

    let transcriptionResult = "";
    try {
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePath), // Provide a read stream
            model: "whisper-1",
            response_format: "text",
            language: "en"
        });
        transcriptionResult = transcription; // transcription is already the text string
    } finally {
        // Cleanup the temporary file immediately after transcription attempt
        fs.unlink(tempFilePath, (err) => {
            if (err) console.error(`[${callSid}] Error deleting transcription temp file ${tempFilePath}:`, err);
        });
    }

    console.log(`[${callSid}] Transcription successful.`);
    return transcriptionResult; // Return the text directly

  } catch (error) {
    console.error(`[${callSid}] Error during OpenAI transcription:`, error.response ? error.response.data : error.message);
    // Re-throwing for now to signal failure upstream.
    throw new Error(`Transcription failed: ${error.message}`);
  }
}


// Keep original transcribeRecording function (Mark as deprecated/unused)
async function transcribeRecording(recordingUrl, callSid, retries = 3, delayMs = 2000) {
   console.warn(`[${callSid}] DEPRECATED: transcribeRecording (URL-based) called. Should use transcribeBuffer instead.`);
    if (!openai) { /* ... */ throw new Error("OpenAI API key not configured."); }
   const tempDir = path.join(__dirname, 'call_recordings_legacy');
   try { /* ... Download logic ... */
     if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
     // ... axios download ...
     const tempFilePath = path.join(tempDir, `${callSid}_${Date.now()}.wav`);
     // ... save stream to file ...
     let transcriptionResult = "";
      try { /* ... openai.audio.transcriptions.create ... */ }
      finally { fs.unlink(tempFilePath, (err) => { /* handle error */ }); }
     return transcriptionResult;
   } catch (error) { console.error(`[${callSid}] Error in legacy transcribeRecording: ${error.message}`); throw error; }
}


async function getDeepSeekResponse(messages, requestRating = false) {
  if (!process.env.DEEPSEEK_API) { throw new Error("DeepSeek API key not configured."); }
  try {
    const response = await axios.post( 'https://openrouter.ai/api/v1/chat/completions', { /* ... payload ... */ }, { /* ... headers ... */ });
    return response.data.choices[0].message.content;
  } catch (error) { /* ... error handling ... */ throw error; }
}

async function getAiResponse(text, role, jobDescription, requestRating = false, conversationHistory = []) {
  try {
    const messages = getInterviewPrompt(role, jobDescription);
    if (Array.isArray(conversationHistory)) { messages.push(...conversationHistory); }
    // Note: The 'text' parameter might need adjustment based on how prompts are structured.
    // Assuming the history contains the latest user input.
    // messages.push({ role: "user", content: text }); // This might duplicate user input if history is up-to-date

    const response = await getDeepSeekResponse(messages, requestRating);
    return response;
  } catch (error) { console.error("Error generating AI response:", error.message); return "I encountered an issue processing that. Could you please repeat?"; }
}

async function getQnAResponse(question, conversationHistory = []) {
  try {
    const messages = [ { role: "system", content: "..." }, ...(Array.isArray(conversationHistory) ? conversationHistory : []), { role: "user", content: `My question is: ${question}` } ];
    const response = await getDeepSeekResponse(messages);
    return response?.trim() || "Thank you for your question. I'll note it down.";
  } catch (error) { console.error("Error generating Q&A response:", error.message); return "I had trouble processing your question."; }
}

async function generateFinalScore(conversationHistory, role, jobDescription) {
  if (!process.env.DEEPSEEK_API) { return JSON.stringify({ /* ... error state ... */ }); }
  try {
    const scoringPromptObject = getScoringPrompt(role, jobDescription);
    const messages = [ scoringPromptObject, ...(Array.isArray(conversationHistory) ? conversationHistory : []) ];
    const responseJsonString = await getDeepSeekResponse(messages, true);
    console.log("Raw Scoring Response:", responseJsonString); // Keep log for debugging score format
    return responseJsonString; // Return raw string
  } catch (error) { console.error("Error generating score:", error.message); return JSON.stringify({ /* ... error state ... */ }); }
}

module.exports = {
  transcribeBuffer,
  transcribeRecording, // Keep old one if needed elsewhere
  getAiResponse,
  generateFinalScore,
  getQnAResponse
};