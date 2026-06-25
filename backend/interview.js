// interview.js
// LLM layer for MoonAI, built on LangChain (v1) + LangSmith tracing.
//
// - Interviewer turns & Q&A  -> DeepSeek (via OpenRouter) through LangChain ChatOpenAI
// - Final scoring            -> same model with .withStructuredOutput(Zod) for reliable JSON
// - Audio transcription      -> OpenAI Whisper (kept on the OpenAI SDK; wrapped in a
//                               LangSmith `traceable` so it shows up in the same trace tree)
//
// Tracing is automatic for all LangChain calls when LANGSMITH_TRACING=true and
// LANGSMITH_API_KEY is set. No call-site changes are needed to get traces.
//
// IMPORTANT: every exported function keeps the exact same signature and return type
// as before, so server.js needs no changes for this phase.

const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { z } = require('zod');
const { traceable } = require('langsmith/traceable');
require('dotenv').config();

const { getInterviewPrompt, getScoringPrompt } = require('./prompt');
const { createChatModel, toLangChainMessages } = require('./llmConfig');

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

if (!openai) {
  console.warn('Warning: OPENAI_API_KEY not found in environment. Transcription will fail.');
}
if (!process.env.DEEPSEEK_API) {
  console.warn('Warning: DEEPSEEK_API key not found in environment. AI response generation will fail.');
}

// Single shared chat model for conversational turns (temperature 0.7, like the original).
const chatModel = createChatModel({ temperature: 0.7, timeout: 15000 });

// ---------------------------------------------------------------------------
// Scoring schema — this is the contract server.js (endInterview) parses.
// Returning a validated object guarantees the JSON.parse in server.js succeeds
// with numeric scores, fixing the old "invalid format" failure path.
// ---------------------------------------------------------------------------
const ScoreSchema = z.object({
  technicalScore: z.number().min(0).max(10).describe('Technical knowledge score, 0-10'),
  communicationScore: z.number().min(0).max(10).describe('Communication skills score, 0-10'),
  justification: z.string().describe('Brief overall justification for the scores'),
  completionStatus: z
    .enum(['complete', 'partial', 'abrupt'])
    .describe('Whether the interview ran to completion'),
  breakdown: z
    .array(z.string())
    .describe('3-5 short key observations about the candidate'),
});

const scoringModel = createChatModel({ temperature: 0, timeout: 25000 }).withStructuredOutput(
  ScoreSchema,
  { name: 'interview_score', method: 'jsonMode' }
);

// ===========================================================================
// Transcription (OpenAI Whisper) — unchanged behavior, now traced via LangSmith
// ===========================================================================

const _transcribeBuffer = async function transcribeBuffer(audioBuffer, callSid) {
  if (!openai) {
    console.error(`[${callSid}] Cannot transcribe: OpenAI API key not configured.`);
    throw new Error('OpenAI API key not configured.');
  }
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    console.error(`[${callSid}] Invalid or empty buffer provided for transcription.`);
    throw new Error('Invalid audio buffer for transcription.');
  }

  console.log(`[${callSid}] Transcribing audio buffer (${audioBuffer.length} bytes) using Whisper...`);

  const tempDir = path.join(__dirname, 'temp_transcribe');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const tempFilePath = path.join(tempDir, `${callSid}_${Date.now()}.wav`);
  fs.writeFileSync(tempFilePath, audioBuffer);

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: 'whisper-1',
      response_format: 'text',
      language: 'en',
    });
    console.log(`[${callSid}] Transcription successful.`);
    return transcription; // already the text string
  } catch (error) {
    console.error(
      `[${callSid}] Error during OpenAI transcription:`,
      error.response ? error.response.data : error.message
    );
    throw new Error(`Transcription failed: ${error.message}`);
  } finally {
    fs.unlink(tempFilePath, (err) => {
      if (err) console.error(`[${callSid}] Error deleting transcription temp file ${tempFilePath}:`, err);
    });
  }
};

// Wrap so Whisper calls appear in LangSmith traces alongside the LLM turns.
const transcribeBuffer = traceable(_transcribeBuffer, {
  name: 'whisper_transcribe',
  run_type: 'tool',
});

// Legacy URL-based transcription kept for compatibility (unchanged logic).
async function transcribeRecording(recordingUrl, callSid, retries = 3, delayMs = 2000) {
  console.warn(`[${callSid}] DEPRECATED: transcribeRecording (URL-based) called. Use transcribeBuffer instead.`);
  if (!openai) {
    console.error(`[${callSid}] Cannot transcribe URL: OpenAI API key not configured.`);
    throw new Error('OpenAI API key not configured.');
  }
  const tempDir = path.join(__dirname, 'call_recordings_legacy');
  try {
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    let response;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`[${callSid}] Legacy Download attempt ${attempt}/${retries}`);
        response = await axios({
          method: 'get',
          url: recordingUrl + '.wav',
          responseType: 'stream',
          auth: {
            username: process.env.TWILIO_ACCOUNT_SID,
            password: process.env.TWILIO_AUTH_TOKEN,
          },
          timeout: 30000,
        });
        break;
      } catch (error) {
        console.error(`[${callSid}] Legacy Download attempt ${attempt} failed: ${error.message}`);
        if (attempt === retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    const tempFilePath = path.join(tempDir, `${callSid}_${Date.now()}.wav`);
    await new Promise((resolve, reject) => {
      response.data
        .pipe(fs.createWriteStream(tempFilePath))
        .on('finish', resolve)
        .on('error', reject);
    });

    let transcriptionResult = '';
    try {
      transcriptionResult = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath),
        model: 'whisper-1',
        response_format: 'text',
        language: 'en',
      });
    } finally {
      fs.unlink(tempFilePath, (err) => {
        if (err) console.error(`[${callSid}] Error deleting legacy temp file ${tempFilePath}:`, err);
      });
    }
    return transcriptionResult;
  } catch (error) {
    console.error(`[${callSid}] Error in legacy transcribeRecording: ${error.message}`);
    throw error;
  }
}

// ===========================================================================
// Conversational turns (DeepSeek via LangChain)
// ===========================================================================

/**
 * Generate the interviewer's next turn.
 * Same signature/return (a plain string) as before.
 */
async function getAiResponse(text, role, jobDescription, requestRating = false, conversationHistory = []) {
  try {
    // getInterviewPrompt returns [{role:'system', content}] — keep using it as the system anchor.
    const systemMessages = getInterviewPrompt(role, jobDescription);
    const messages = [
      ...toLangChainMessages(systemMessages),
      ...toLangChainMessages(conversationHistory),
      ...toLangChainMessages([{ role: 'user', content: text }]),
    ];

    const result = await chatModel.invoke(messages);
    return typeof result.content === 'string' ? result.content : String(result.content ?? '');
  } catch (error) {
    console.error('Error generating AI response:', error.message);
    return 'I encountered an issue processing that. Could you please repeat?';
  }
}

/**
 * Answer a candidate's question concisely. Same signature/return as before.
 */
async function getQnAResponse(question, conversationHistory = []) {
  try {
    const messages = [
      ...toLangChainMessages([
        {
          role: 'system',
          content:
            "You are an interviewer. Provide a concise 1-2 sentence answer to the candidate's question based ONLY on the provided conversation history or general knowledge if the history doesn't contain the answer. If you cannot answer, politely state that.",
        },
      ]),
      ...toLangChainMessages(conversationHistory),
      ...toLangChainMessages([{ role: 'user', content: `My question is: ${question}` }]),
    ];

    const result = await chatModel.invoke(messages);
    const content = typeof result.content === 'string' ? result.content : String(result.content ?? '');
    return (
      content?.trim() ||
      "Thank you for your question. I don't have specific details on that right now, but we can follow up."
    );
  } catch (error) {
    console.error('Error generating Q&A response:', error.message);
    return 'I had trouble processing your question. We can discuss it further later.';
  }
}

// ===========================================================================
// Final scoring (structured output -> JSON string, matching server.js contract)
// ===========================================================================

/**
 * Generate the final candidate score.
 * Returns a JSON *string* (server.js does JSON.parse on it), shape:
 *   { technicalScore, communicationScore, justification, completionStatus, breakdown }
 */
async function generateFinalScore(conversationHistory, role, jobDescription) {
  if (!process.env.DEEPSEEK_API) {
    console.error('Cannot generate score: DEEPSEEK_API key not configured.');
    return JSON.stringify({
      technicalScore: 0,
      communicationScore: 0,
      justification: 'Scoring unavailable: API key missing.',
      completionStatus: 'error',
      breakdown: [],
    });
  }
  try {
    const scoringPromptObject = getScoringPrompt(role, jobDescription); // system prompt object
    const messages = [
      ...toLangChainMessages([scoringPromptObject]),
      ...toLangChainMessages(conversationHistory),
    ];

    // withStructuredOutput returns a validated JS object (already parsed).
    const scoreObject = await scoringModel.invoke(messages);
    console.log('Structured scoring result:', scoreObject);

    // server.js expects a JSON string it can JSON.parse.
    return JSON.stringify(scoreObject);
  } catch (error) {
    console.error('Error generating score:', error.message);
    return JSON.stringify({
      technicalScore: 0,
      communicationScore: 0,
      justification: `Evaluation failed: ${error.message}`,
      completionStatus: 'error',
      breakdown: [],
    });
  }
}

module.exports = {
  transcribeBuffer,
  transcribeRecording,
  getAiResponse,
  generateFinalScore,
  getQnAResponse,
};
