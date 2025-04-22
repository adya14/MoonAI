const { getInterviewPrompt, getScoringPrompt } = require('./prompt');
const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

/**
 * Downloads and transcribes audio from Twilio URL
 * @param {string} recordingUrl - Twilio recording URL
 * @param {string} callSid - For logging/temp files
 * @returns {Promise<string>} Transcription text
 */
async function transcribeRecording(recordingUrl, callSid, retries = 3, delayMs = 2000) {
  const tempDir = path.join(__dirname, 'call_recordings');
  
  try {
    // 1. Create temp directory if needed
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    // 2. Download with retry logic
    let response;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`[${callSid}] Download attempt ${attempt}/${retries}`);
        response = await axios({
          method: 'get',
          url: recordingUrl,
          responseType: 'stream',
          auth: {
            username: process.env.TWILIO_ACCOUNT_SID,
            password: process.env.TWILIO_AUTH_TOKEN
          },
          timeout: 30000
        });
        break; // Success - exit retry loop
      } catch (error) {
        if (attempt === retries) throw error;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // 3. Process the successful download
    const tempFilePath = path.join(tempDir, `${callSid}_${Date.now()}.wav`);
    await new Promise((resolve, reject) => {
      response.data.pipe(fs.createWriteStream(tempFilePath))
        .on('finish', resolve)
        .on('error', reject);
    });

    // 4. Transcribe (still using OpenAI Whisper)
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: "whisper-1",
      response_format: "text",
      language: "en"
    });

    // 5. Cleanup
    fs.unlink(tempFilePath, () => {});
    return transcription;

  } catch (error) {
    // Final cleanup if error occurred mid-process
    const files = fs.readdirSync(tempDir);
    files.forEach(file => {
      if (file.includes(callSid)) {
        fs.unlink(path.join(tempDir, file), () => {});
      }
    });
    throw error;
  }
}

async function getDeepSeekResponse(messages, requestRating = false) {
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
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('Error calling DeepSeek:', error.response?.data || error.message);
    throw error;
  }
}

async function getAiResponse(text, role, jobDescription, requestRating, conversationHistory = []) {
  try {
    const messages = getInterviewPrompt(role, jobDescription);

    if (conversationHistory) {
      messages.push(...conversationHistory);
    }

    messages.push({ role: "user", content: text });

    const response = await getDeepSeekResponse(messages, requestRating);
    return response;
  } catch (error) {
    console.error("Error generating AI response:", error);
    throw error;
  }
}

async function getQnAResponse(question, conversationHistory = []) {
  try {
    const messages = [
      {
        role: "system",
        content: "You are an interviewer. Answer the candidate's question directly and professionally without adding additional questions or prompts."
      },
      ...conversationHistory,
      { role: "user", content: question }
    ];

    const response = await getDeepSeekResponse(messages);
    return response;
  } catch (error) {
    console.error("Error generating Q&A response:", error);
    return "Thank you for your question. We'll follow up with more details later.";
  }
}

async function generateFinalScore(conversationHistory, role, jobDescription) {
  try {
    const messages = [
      {
        role: "system",
        content: `Evaluate this interview and strictly return ONLY a JSON object with these exact fields:
        {
          "technicalScore": number (1-10),
          "communicationScore": number (1-10),
          "justification": string,
          "completionStatus": "complete"|"partial"|"abrupt",
          "breakdown": [{"category":string,"score":number,"comment":string}]
        }
        Job Role: ${role}
        You STRICTLY cannot return anything other than the json`
      },
      ...conversationHistory
    ];

    const response = await getDeepSeekResponse(messages, true);
    
    // Extract JSON from the response text
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    return JSON.parse(jsonMatch[0]);
    
  } catch (error) {
    console.error("Error generating score:", error);
    return {
      technicalScore: 0,
      communicationScore: 0,
      justification: "Evaluation failed",
      completionStatus: "error"
    };
  }
}

module.exports = {
  transcribeRecording,
  getAiResponse,
  generateFinalScore,
  getQnAResponse
};