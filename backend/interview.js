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

    // 4. Transcribe
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

async function getAiResponse(text, role, jobDescription, requestRating, conversationHistory = []) {
  try {
    const messages = getInterviewPrompt(role, jobDescription);

    if (conversationHistory) {
      messages.push(...conversationHistory);
    }

    messages.push({ role: "user", content: text });

    // if (requestRating) {
    //   messages.push({
    //     role: "system",
    //     content: `Generate a JSON rating object with these fields:
    //     - score (1-10)
    //     - justification (string)
    //     - breakdown (array of {category, score, comment})
        
    //     Example response:
    //     {
    //       "score": 7,
    //       "justification": "Candidate showed good technical skills but lacked depth in...",
    //       "breakdown": [
    //         {"score": 8, "comment": "Strong fundamentals..."},
    //       ]
    //     }`
    //   });
    // }

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages,
      response_format: requestRating ? { type: "json_object" } : undefined
    });

    return requestRating 
      ? response.choices[0].message.content
      : response.choices[0].message.content;
  } catch (error) {
    console.error("Error generating AI response:", error);
    throw error;
  }
}

// interview.js
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

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages,
      temperature: 0.3  // Lower temperature for more focused answers
    });

    return response.choices[0].message.content;
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
        content: `You are an interview scoring system. Evaluate the candidate based on:
        - Technical Knowledge (0-10)
        - Communication Skills (0-10)
        
        Return your evaluation in this EXACT JSON format:
        {
          "technicalScore": number,
          "communicationScore": number,
          "justification": string,
          "completionStatus": "complete"|"partial"|"abrupt"
        }
        
        Job Role: ${role}
        Job Description: ${jobDescription}`
      },
      ...conversationHistory
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4", // or "gpt-4-1106-preview" if you need JSON mode
      messages,
      temperature: 0.2 // Lower temperature for more consistent scoring
    });

    // Extract JSON from the response
    const jsonString = response.choices[0].message.content;
    return JSON.parse(jsonString);
    
  } catch (error) {
    console.error("Error generating final score:", error);
    return {
      technicalScore: 0,
      communicationScore: 0,
      justification: "Scoring failed due to system error",
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