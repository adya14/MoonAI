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
    // OpenAI SDK expects a file-like object. We need to simulate this from the buffer.
    // The SDK might handle Buffers directly or might need a stream simulation.
    // Let's try passing the buffer wrapped in an object simulating a file read stream.
    // IMPORTANT: The 'file' parameter in openai.audio.transcriptions.create expects a readable stream or similar.
    // Directly passing a buffer might not work. We might need to save to a temp file first,
    // or use a library like 'streamifier' to create a stream from the buffer.

    // Approach 1: Try passing buffer directly (might work with newer SDK versions) - LESS LIKELY
    // const transcription = await openai.audio.transcriptions.create({
    //     file: audioBuffer, // This is speculative
    //     model: "whisper-1",
    //     response_format: "text",
    //     language: "en"
    // });

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
    // Don't re-throw immediately, maybe return empty string or specific error indicator?
    // Re-throwing for now to signal failure upstream.
    throw new Error(`Transcription failed: ${error.message}`);
  }
}


// Keep original transcribeRecording function for potential compatibility or other uses,
// but clearly mark it as deprecated or URL-based.
async function transcribeRecording(recordingUrl, callSid, retries = 3, delayMs = 2000) {
   console.warn(`[${callSid}] DEPRECATED: transcribeRecording (URL-based) called. Should use transcribeBuffer instead.`);
    if (!openai) {
        console.error(`[${callSid}] Cannot transcribe URL: OpenAI API key not configured.`);
        throw new Error("OpenAI API key not configured.");
    }
   const tempDir = path.join(__dirname, 'call_recordings_legacy'); // Use a different dir

   try {
     if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

     let response;
     for (let attempt = 1; attempt <= retries; attempt++) {
       try {
         console.log(`[${callSid}] Legacy Download attempt ${attempt}/${retries}`);
         response = await axios({
           method: 'get',
           url: recordingUrl + ".wav", // Ensure .wav extension if needed
           responseType: 'stream',
           auth: {
             username: process.env.TWILIO_ACCOUNT_SID,
             password: process.env.TWILIO_AUTH_TOKEN
           },
           timeout: 30000
         });
         break;
       } catch (error) {
         console.error(`[${callSid}] Legacy Download attempt ${attempt} failed: ${error.message}`);
         if (attempt === retries) throw error;
         await new Promise(resolve => setTimeout(resolve, delayMs));
       }
     }

     const tempFilePath = path.join(tempDir, `${callSid}_${Date.now()}.wav`);
     await new Promise((resolve, reject) => {
       response.data.pipe(fs.createWriteStream(tempFilePath))
         .on('finish', resolve)
         .on('error', reject);
     });

     let transcriptionResult = "";
      try {
          const transcription = await openai.audio.transcriptions.create({
              file: fs.createReadStream(tempFilePath),
              model: "whisper-1",
              response_format: "text",
              language: "en"
          });
          transcriptionResult = transcription;
      } finally {
          fs.unlink(tempFilePath, (err) => {
             if (err) console.error(`[${callSid}] Error deleting legacy temp file ${tempFilePath}:`, err);
          });
      }
     return transcriptionResult;

   } catch (error) {
     console.error(`[${callSid}] Error in legacy transcribeRecording: ${error.message}`);
     throw error; // Re-throw
   }
}


async function getDeepSeekResponse(messages, requestRating = false) {
  if (!process.env.DEEPSEEK_API) {
    console.error('Cannot get DeepSeek response: DEEPSEEK_API key not configured.');
    throw new Error("DeepSeek API key not configured.");
  }
  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-chat',
        messages,
        temperature: 0.7,
        response_format: requestRating ? { type: "json_object" } : undefined
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://your-app-identifier', // Optional: Add referrer if required by OpenRouter
          'X-Title': 'AI Interview Bot' // Optional: Add title if required by OpenRouter
        },
         timeout: 15000 // 15 second timeout for AI response
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    const errorMessage = error.response?.data?.error?.message || error.message;
    console.error(`Error calling DeepSeek/OpenRouter (${error.response?.status}):`, errorMessage);
    // Provide a generic fallback or rethrow specific types of errors
     if (error.code === 'ETIMEDOUT' || error.response?.status === 408) {
         throw new Error("AI response generation timed out.");
     }
    throw new Error(`DeepSeek API request failed: ${errorMessage}`);
  }
}

async function getAiResponse(text, role, jobDescription, requestRating = false, conversationHistory = []) {
  try {
    const messages = getInterviewPrompt(role, jobDescription); // Assumes getInterviewPrompt structures messages correctly

    // Ensure conversation history is an array before spreading
    if (Array.isArray(conversationHistory)) {
      messages.push(...conversationHistory);
    }

    messages.push({ role: "user", content: text });

    const response = await getDeepSeekResponse(messages, requestRating);
    return response;
  } catch (error) {
    console.error("Error generating AI response:", error.message);
    // Provide a fallback response in case of error
    return "I encountered an issue processing that. Could you please repeat?";
  }
}

async function getQnAResponse(question, conversationHistory = []) {
  try {
    const messages = [
      {
        role: "system",
        content: "You are an interviewer. Provide a concise 1-2 sentence answer to the candidate's question based ONLY on the provided conversation history or general knowledge if the history doesn't contain the answer. If you cannot answer, politely state that."
      },
      // Ensure history is an array
      ...(Array.isArray(conversationHistory) ? conversationHistory : []),
      { role: "user", content: `My question is: ${question}` } // Clarify it's a question
    ];

    const response = await getDeepSeekResponse(messages);
    // Add fallback if response is empty
    return response?.trim() || "Thank you for your question. I don't have specific details on that right now, but we can follow up.";
  } catch (error) {
    console.error("Error generating Q&A response:", error.message);
    return "I had trouble processing your question. We can discuss it further later.";
  }
}

async function generateFinalScore(conversationHistory, role, jobDescription) {
  if (!process.env.DEEPSEEK_API) {
       console.error("Cannot generate score: DeepSeek/OpenRouter API key not configured.");
       // Return a JSON string representing the error state
       return JSON.stringify({
           technicalScore: 0, communicationScore: 0, justification: "Scoring unavailable: API key missing.", completionStatus: "error", breakdown: []
       });
   }
  try {
    const scoringPromptObject = getScoringPrompt(role, jobDescription); // Assume this returns the structured system prompt object
    const messages = [
      scoringPromptObject, // The system prompt object
      // Ensure history is an array before spreading
      ...(Array.isArray(conversationHistory) ? conversationHistory : [])
    ];

    // Request JSON object directly from DeepSeek/OpenRouter
    const responseJsonString = await getDeepSeekResponse(messages, true); // requestRating = true requests JSON

    console.log("Raw Scoring Response:", responseJsonString);

    // Return the raw JSON string as received. Parsing happens in server.js endInterview
    return responseJsonString;

  } catch (error) {
    console.error("Error generating score:", error.message);
    // Return a JSON string representing the error state
    return JSON.stringify({
      technicalScore: 0,
      communicationScore: 0,
      justification: `Evaluation failed: ${error.message}`,
      completionStatus: "error",
      breakdown: []
    });
  }
}

module.exports = {
  transcribeBuffer,   // Export the new buffer-based function
  transcribeRecording, // Keep the old one (marked deprecated)
  getAiResponse,
  generateFinalScore,
  getQnAResponse
};