// ... (keep all requires and initial setup the same) ...
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const pcmConvert = require('pcm-convert');
const fs = require('fs');
const path = require('path'); // Make sure path is required
const connectDB = require('./db'); // Assuming db.js handles mongoose connection
const mongoose = require('mongoose'); // Import mongoose for graceful shutdown
const passport = require('./config/passportConfig');
const authRoutes = require('./routes/authRoutes');
const cors = require('cors');
const User = require("./models/user");
const interviews = new Map();
const ScheduledCall = require("./models/ScheduledCall");
const nodemailer = require('nodemailer');
require('dotenv').config();
const { getAiResponse, transcribeBuffer, generateFinalScore, getQnAResponse } = require('./interview'); // Updated import
const { convertAudio } = require('./audioProcessor'); // Import conversion function
const app = express();
const server = http.createServer(app); // Use http server for WebSockets
const wss = new WebSocket.Server({ server }); // Attach WebSocket server
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const axios = require('axios');

const allowedOrigins = [
  "http://localhost:3000",
  "https://moon-ai-one.vercel.app"
];

// Silence Detection Constants (from test.js) - Adjust as needed
const SAMPLE_RATE = 8000;
const FRAME_DURATION_MS = 25;
const SILENCE_THRESHOLD_VALUE = 0.1; // Fixed threshold
const MIN_ENERGY = 1e-7;
const FRAME_SIZE = Math.floor(SAMPLE_RATE * (FRAME_DURATION_MS / 1000));
const SILENCE_DURATION_FRAMES = 25;
const BYTES_PER_PCM16_FRAME = FRAME_SIZE * 2;
const INITIAL_NOISE_FRAMES = 40; // ~1 second
const MAX_REASONABLE_INIT_ENERGY = 0.05;
const SMOOTHING_ALPHA = 0.1;
const RELATIVE_RISE_FACTOR = 3.0;


// Express Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Serve static files (for TTS audio)
const audioDir = path.join(__dirname, 'public', 'audio');
if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
    // console.log(`Created directory for temporary audio: ${audioDir}`); // Reduced log
}
app.use(express.static(path.join(__dirname, 'public'))); // Serve files from 'public' directory

// Connect to MongoDB
connectDB();

// Initialize Passport
app.use(passport.initialize());

// Routes
app.use('/', authRoutes);

app.get('/', (req, res) => {
  res.send('Backend/Twilio server with WebSocket is running!');
});

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});


// --- SARVAM TTS Integration ---
async function generateAndServeTTS(text, callSid) {
    if (!process.env.SARVAM_API) {
        console.error(`[${callSid}] SARVAM_API environment variable not set. Cannot generate TTS.`);
        throw new Error("TTS API key not configured.");
    }
    if (!process.env.BACKEND_URL) {
         console.error(`[${callSid}] BACKEND_URL environment variable not set. Cannot serve TTS audio.`);
         throw new Error("Backend URL not configured for TTS playback.");
    }

    let backendUrl = process.env.BACKEND_URL;
    if (!backendUrl.startsWith('http://') && !backendUrl.startsWith('https://')) {
        // console.warn(`[${callSid}] Warning: BACKEND_URL ('${backendUrl}') is missing scheme for TTS. Prepending 'https://'.`); // Reduced log
        backendUrl = `https://${backendUrl}`;
    }
     if (backendUrl.endsWith('/')) {
        backendUrl = backendUrl.slice(0, -1);
     }


    const apiUrl = 'https://api.sarvam.ai/text-to-speech';
    const apiKey = process.env.SARVAM_API;
    const payload = {
        inputs: [text],
        target_language_code: "en-IN",
        speaker: "anushka",
        model: "bulbul:v2",
        speech_sample_rate: 8000
    };

    // console.log(`[${callSid}] Requesting TTS from Sarvam for text: "${text.substring(0, 50)}..."`); // Reduced log

    try {
        const response = await axios.post(apiUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'api-subscription-key': apiKey
            },
            responseType: 'json',
            timeout: 10000
        });

        if (response.data && response.data.audios && response.data.audios.length > 0 && response.data.audios[0]) {
            const base64Audio = response.data.audios[0];
            const audioBuffer = Buffer.from(base64Audio, 'base64');

            const filename = `tts_${callSid}_${Date.now()}.wav`;
            const filePath = path.join(audioDir, filename);

            await fs.promises.writeFile(filePath, audioBuffer);
            // console.log(`[${callSid}] TTS audio saved locally to: ${filePath}`); // Reduced log

            const publicUrl = `${backendUrl}/audio/${filename}`;
            console.log(`[${callSid}] Generated TTS audio URL: ${publicUrl}`); // Keep this one

            return publicUrl;
        } else {
            console.error(`[${callSid}] Sarvam TTS API returned unexpected response:`, response.data);
            throw new Error("Invalid response format from TTS API.");
        }
    } catch (error) {
        const errorMsg = error.response ? `${error.response.status} ${error.response.statusText} - ${JSON.stringify(error.response.data)}` : error.message;
        console.error(`[${callSid}] Error calling Sarvam TTS API:`, errorMsg);
        throw new Error(`Failed to generate TTS audio: ${error.message}`);
    }
}
// --- END SARVAM TTS Integration ---


app.post("/make-call", async (req, res) => {
  const { jobRole, jobDescription, candidates, email } = req.body;

  try {
    if (!jobRole || !jobDescription || !candidates || !Array.isArray(candidates)) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (email) {
      const user = await User.findOneAndUpdate( { email }, { $inc: { usedCalls: candidates.length, totalCallsTillDate: candidates.length } }, { new: true } );
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.usedCalls > user.totalCalls) {
        await User.findOneAndUpdate( { email }, { $inc: { usedCalls: -candidates.length, totalCallsTillDate: -candidates.length } } );
        return res.status(400).json({ error: "Call limit exceeded" });
      }
    }

    const results = [];
    let backendUrl = process.env.BACKEND_URL;
    if (!backendUrl) {
         console.error("FATAL ERROR: BACKEND_URL environment variable is not set.");
         if (email && candidates.length > 0) {
             await User.findOneAndUpdate( { email }, { $inc: { usedCalls: -candidates.length, totalCallsTillDate: -candidates.length } } )
                 .catch(err => console.error("Error reverting usage count for BACKEND_URL error:", err));
         }
         return res.status(500).json({ error: "Server configuration error: Missing BACKEND_URL."});
    }
     if (!backendUrl.startsWith('http://') && !backendUrl.startsWith('https://')) {
         backendUrl = `https://${backendUrl}`;
     }
     if (backendUrl.endsWith('/')) {
        backendUrl = backendUrl.slice(0, -1);
     }

    for (const candidate of candidates) {
        if (!candidate || typeof candidate.phone !== 'string' || candidate.phone.trim() === '' || typeof candidate.name !== 'string' || candidate.name.trim() === '') {
            console.warn(`Skipping candidate due to missing or invalid name/phone:`, candidate);
            results.push({ success: false, phone: candidate?.phone || 'N/A', error: "Invalid candidate data (missing name or phone)"});
            if (email) {
                 await User.findOneAndUpdate( { email }, { $inc: { usedCalls: -1, totalCallsTillDate: -1 } } )
                     .catch(err => console.error("Error reverting usage count for skipped candidate:", err));
             }
            continue;
        }

      try {
        console.log(`Initiating call to ${candidate.name} (${candidate.phone}) for role "${jobRole}"`);

        const twimlUrl = `${backendUrl}/voice?jobRole=${encodeURIComponent(jobRole)}&jobDescription=${encodeURIComponent(jobDescription)}`;
        const statusCallbackUrl = `${backendUrl}/call-status`;
        const statusCallbackEvents = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];

        // console.log(`[DEBUG] Using TwiML URL: ${twimlUrl}`); // Reduced log
        // console.log(`[DEBUG] Using Status Callback URL: ${statusCallbackUrl}`); // Reduced log
        // console.log(`[DEBUG] Using Status Callback Events: ${JSON.stringify(statusCallbackEvents)}`); // Reduced log

        const call = await client.calls.create({
          to: candidate.phone,
          from: process.env.TWILIO_PHONE_NUMBER,
          url: twimlUrl,
          statusCallback: statusCallbackUrl,
          statusCallbackEvent: statusCallbackEvents,
          statusCallbackMethod: 'POST'
        });

        console.log(`[${call.sid}] Call initiated for ${candidate.name}. Storing initial state.`);
        interviews.set(call.sid, {
          jobRole, jobDescription, history: [], phase: 'introduction',
          candidatePhone: candidate.phone, candidateName: candidate.name,
          lastActivity: Date.now(), email, currentAudioBuffer: Buffer.alloc(0),
          vadState: null, callSid: call.sid, streamSid: null, startTime: new Date()
        });
        results.push({ success: true, callSid: call.sid, phone: candidate.phone, name: candidate.name });

      } catch (error) {
        console.error(`[Call Create Error] Failed to call ${candidate.name} (${candidate.phone}):`, error.message); // More specific error log
        if (email) {
            await User.findOneAndUpdate( { email }, { $inc: { usedCalls: -1, totalCallsTillDate: -1 } } )
                .catch(err => console.error("Error reverting usage count for failed call:", err));
        }
        results.push({ success: false, phone: candidate.phone, name: candidate.name, error: error.message });
      }
    }
    res.json({ success: true, results, message: `Initiated ${results.filter(r => r.success).length} of ${candidates.length} valid calls` });

  } catch (error) {
    console.error("Make Call Route Error:", error); // General error in route
    res.status(500).json({ error: "Call processing failed", details: process.env.NODE_ENV === 'development' ? error.message : null });
  }
});


// --- Cron Job and Scheduling (Reduced Logging) ---
const cron = require('node-cron');
app.post('/schedule-call', async (req, res) => {
  try {
    const { email, jobRole, jobDescription, candidates, scheduledTime } = req.body;
    if (!email || !jobRole || !jobDescription || !candidates || !Array.isArray(candidates) || candidates.length === 0 || !scheduledTime) {
         return res.status(400).json({ error: "Missing required fields for scheduling." });
    }
    const scheduleDate = new Date(scheduledTime);
    if (isNaN(scheduleDate.getTime()) || scheduleDate <= new Date()) {
        return res.status(400).json({ error: "Scheduled time must be a valid date in the future." });
    }
     if (!candidates.every(c => c && typeof c.phone === 'string' && c.phone.trim() !== '' && typeof c.name === 'string' && c.name.trim() !== '')) {
         return res.status(400).json({ error: "Invalid candidate data. Each candidate must have a non-empty 'name' and 'phone' property." });
     }
    const scheduledCall = new ScheduledCall({ email, jobRole, jobDescription, scheduledTime: scheduleDate, status: 'scheduled',
      candidates: candidates.map(c => ({ name: c.name, phone: c.phone, technicalScore: null, communicationScore: null, scoreJustification: null, scoreBreakdown: [], completionStatus: 'scheduled', transcript: null, status: 'scheduled', startedAt: null, endedAt: null }))
    });
    await scheduledCall.save();
    console.log(`Scheduled call saved for email: ${email} at ${scheduleDate}`);
    res.status(201).json(scheduledCall);
  } catch (error) {
    if (error.name === 'ValidationError') {
        const validationErrors = Object.values(error.errors).map(err => err.message).join(', ');
        console.error("Error scheduling call (Validation Failed):", validationErrors);
        res.status(400).json({ error: `Validation Failed: ${validationErrors}` });
    } else {
        console.error("Error scheduling call (General):", error);
        res.status(500).json({ error: "Failed to schedule call due to a server error." });
    }
  }
});

cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const callsToInitiate = await ScheduledCall.find({ scheduledTime: { $lte: now }, status: 'scheduled' }).limit(5);
    if (callsToInitiate.length > 0) console.log(`Found ${callsToInitiate.length} scheduled call(s) to initiate.`);

    for (const call of callsToInitiate) {
      // console.log(`Processing scheduled call ID: ${call._id}`); // Reduced log
      let processingStatus = 'processing';
      try {
        const updateResult = await ScheduledCall.updateOne( { _id: call._id, status: 'scheduled' }, { $set: { status: 'processing' } } );
        if (updateResult.modifiedCount === 0) { console.warn(`[${call._id}] Scheduled call was likely picked up by another process. Skipping.`); continue; }

        let backendUrl = process.env.BACKEND_URL;
         if (!backendUrl) {
             console.error(`[${call._id}] Cannot initiate scheduled call: BACKEND_URL not set.`);
             processingStatus = 'failed';
             await ScheduledCall.updateOne({ _id: call._id }, { $set: { status: processingStatus, scoreJustification: 'Server configuration error: BACKEND_URL missing.' } });
             continue;
         }
         if (!backendUrl.startsWith('http://') && !backendUrl.startsWith('https://')) backendUrl = `https://${backendUrl}`;
         if (backendUrl.endsWith('/')) backendUrl = backendUrl.slice(0, -1);
         const makeCallUrl = `${backendUrl}/make-call`;
         // console.log(`[${call._id}] Cron job triggering internal API at: ${makeCallUrl}`); // Reduced log

        const response = await axios.post( makeCallUrl, { jobRole: call.jobRole, jobDescription: call.jobDescription, candidates: call.candidates.map(c => ({ name: c.name, phone: c.phone })), email: call.email }, { timeout: 15000 } );
        console.log(`[${call._id}] Successfully triggered /make-call endpoint via cron. Response status: ${response.status}`);
        processingStatus = 'completed';
      } catch (error) {
        processingStatus = 'failed';
        const errorMessage = error.response?.data?.error || error.message;
        console.error(`[${call._id}] Failed to initiate scheduled call via internal API:`, errorMessage);
        await ScheduledCall.updateOne( { _id: call._id }, { $set: { status: processingStatus, scoreJustification: `Failed to trigger calls: ${errorMessage}` } } );
      } finally {
           if (processingStatus !== 'failed') {
                await ScheduledCall.updateOne( { _id: call._id }, { $set: { status: processingStatus } } );
                // console.log(`[${call._id}] Marked scheduled call cron processing as ${processingStatus}.`); // Reduced log
           }
      }
    }
  } catch (error) {
    console.error("Error in call initiation cron job:", error);
  }
});
// --- End Cron Job ---


app.post('/voice', async (req, res) => {
  const callSid = req.body.CallSid;
  const jobRole = req.query.jobRole;
  const jobDescription = req.query.jobDescription;
  const twiml = new twilio.twiml.VoiceResponse();

   if (!callSid) { console.error("'/voice' called without CallSid in body."); res.status(400).send("CallSid is required in request body."); return; }
    if (!jobRole || !jobDescription) { console.error(`[${callSid}] '/voice' called without jobRole/jobDescription query params.`); twiml.say("Configuration error."); twiml.hangup(); res.type('text/xml').send(twiml.toString()); return; }

   const state = interviews.get(callSid);
    if (!state) { console.warn(`[${callSid}] State not found in /voice. Call may have ended or is a retry.`); twiml.hangup(); res.type('text/xml').send(twiml.toString()); return; }
    state.jobRole = state.jobRole || jobRole;
    state.jobDescription = state.jobDescription || jobDescription;

  let backendUrl = process.env.BACKEND_URL;
  if (!backendUrl) { console.error(`[${callSid}] BACKEND_URL not set.`); twiml.say("Server error."); twiml.hangup(); res.type('text/xml').send(twiml.toString()); return; }
   if (!backendUrl.startsWith('http')) backendUrl = `https://${backendUrl}`;
   if (backendUrl.endsWith('/')) backendUrl = backendUrl.slice(0, -1);
  const websocketUrl = backendUrl.replace(/^http/, 'ws');

  const greeting = `Hello, this is Moon, your AI interviewer from [Your Company Name, if applicable] for the ${jobRole} role. Today, I'll ask a few questions to understand your technical and communication skills. Let's begin. Can you please start by introducing yourself?`;
  console.log(`[${callSid}] AI Intro: ${greeting.substring(0, 80)}...`); // Keep this
  if (!Array.isArray(state.history)) state.history = [];
  state.history.push({ role: 'assistant', content: greeting });

  try {
    const audioUrl = await generateAndServeTTS(greeting, callSid);
    twiml.play(audioUrl);
  } catch (ttsError) {
      console.error(`[${callSid}] TTS generation failed for greeting: ${ttsError.message}. Falling back to <Say>.`);
      twiml.say({ voice: 'Polly.Aditi', language: 'en-IN' }, greeting );
  }

  // console.log(`[${callSid}] Connecting to WebSocket: ${websocketUrl}`); // Reduced log
  const connect = twiml.connect();
  connect.stream({ url: websocketUrl, track: 'inbound_track' });
  twiml.pause({ length: 60 });

  console.log(`[${callSid}] Sent initial TwiML (<Play>/<Say>, <Stream>, <Pause>).`); // Keep this
  res.type('text/xml').send(twiml.toString());
});


app.post('/continue-interview/:callSid', async (req, res) => {
    const callSid = req.params.callSid;
    const state = interviews.get(callSid);
    const twiml = new twilio.twiml.VoiceResponse();

    if (!state) { console.error(`[${callSid}] /continue-interview: State not found. Hanging up.`); twiml.say("An error occurred."); twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }
    if (state.phase === 'ending' || state.phase === 'scored') { console.warn(`[${callSid}] /continue-interview: Called in terminal phase (${state.phase}). Hanging up.`); twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }

    // console.log(`[${callSid}] Continuing interview, current phase: ${state.phase}`); // Reduced log

    try {
        let aiResponse = "";
        let nextPhase = state.phase;
        let pauseDuration = 60;

        // --- Interview Logic Switch --- (Keep internal logic)
        switch (state.phase) {
            case 'introduction':
                aiResponse = await getAiResponse("Ask the first technical question, considering the user's introduction if relevant.", state.jobRole, state.jobDescription, false, state.history);
                nextPhase = 'question1';
                break;
            case 'question1':
                aiResponse = await getAiResponse("Ask the second technical question, considering the previous question and answer.", state.jobRole, state.jobDescription, false, state.history);
                nextPhase = 'question2';
                break;
            case 'question2':
                aiResponse = "Thank you for answering my questions. Now, do you have any questions for me about the role or the company? Feel free to ask, or you can say 'no questions'.";
                nextPhase = 'qna_listen';
                break;
            case 'qna_listen':
                 const lastUserMessage = state.history?.[state.history.length - 1];
                 const userContent = lastUserMessage?.content?.trim() ?? "";
                 const hasQuestion = lastUserMessage && lastUserMessage.role === 'user' && userContent !== "" && !/^(no|nope|no questions?|nothing|i'm good|i am good)$/i.test(userContent);
                 if (hasQuestion) {
                     console.log(`[${callSid}] User asked: "${userContent.substring(0,50)}..."`); // Keep log for user questions
                     const qnaAnswer = await Promise.race([ getQnAResponse(userContent, state.history.slice(0, -1)), new Promise((resolve) => setTimeout(() => resolve("That's a good question. I'll note it down."), 8000)) ]);
                     aiResponse = `${qnaAnswer} Was there anything else you wanted to ask?`;
                     nextPhase = 'qna_followup';
                 } else {
                     console.log(`[${callSid}] User has no questions. Ending interview.`); // Keep this log
                     aiResponse = "Okay, thank you for confirming. This concludes our initial interview. We appreciate your time today and will be in touch regarding the next steps. Goodbye!";
                     nextPhase = 'ending';
                 }
                 break;
             case 'qna_followup':
                 const lastFollowupMessage = state.history?.[state.history.length - 1];
                 const followupContent = lastFollowupMessage?.content?.trim() ?? "";
                 const hasFollowupQuestion = lastFollowupMessage && lastFollowupMessage.role === 'user' && followupContent !== "" && !/^(no|nope|no more|that's all|i'm good|i am good|that helps|thank you)$/i.test(followupContent);
                 if (hasFollowupQuestion) {
                      console.log(`[${callSid}] User asked followup: "${followupContent.substring(0,50)}..."`); // Keep log for user questions
                      const followupAnswer = await Promise.race([ getQnAResponse(followupContent, state.history.slice(0, -1)), new Promise((resolve) => setTimeout(() => resolve("Thanks, noted that question too."), 8000)) ]);
                      aiResponse = `${followupAnswer} Anything else?`;
                      nextPhase = 'qna_followup';
                 } else {
                      console.log(`[${callSid}] User finished Q&A. Ending interview.`); // Keep this log
                      aiResponse = "Great. Thank you again for your time and interest! We'll be in touch soon. Have a great day. Goodbye!";
                      nextPhase = 'ending';
                 }
                 break;
            default:
                console.warn(`[${callSid}] /continue-interview: Unexpected phase ${state.phase}. Ending.`);
                aiResponse = "It seems we've reached the end. Thank you. Goodbye.";
                nextPhase = 'ending';
        }
        // --- End Switch ---

        let audioUrl = null;
        if (aiResponse) {
             console.log(`[${callSid}] AI Response (${nextPhase}): ${aiResponse.substring(0, 80)}...`); // Keep this log
             if (!Array.isArray(state.history)) state.history = [];
             state.history.push({ role: 'assistant', content: aiResponse });
             try {
                 audioUrl = await generateAndServeTTS(aiResponse, callSid);
                 twiml.play(audioUrl);
             } catch (ttsError) {
                 console.error(`[${callSid}] TTS generation failed for phase ${nextPhase}: ${ttsError.message}. Falling back to <Say>.`);
                 twiml.say( { voice: 'Polly.Aditi', language: 'en-IN' }, aiResponse );
             }
        } else {
             // console.log(`[${callSid}] Phase changed to ${nextPhase} without explicit AI response.`); // Reduced log
        }

        state.phase = nextPhase;
        state.lastActivity = Date.now();

        if (state.phase === 'ending') {
            console.log(`[${callSid}] Phase is 'ending'. Sending <Hangup> TwiML.`); // Keep this log
            twiml.hangup();
        } else {
             // console.log(`[${callSid}] Phase is '${state.phase}'. Waiting for user response with Pause ${pauseDuration}s.`); // Reduced log
             twiml.pause({ length: pauseDuration });
        }

    } catch (error) {
        console.error(`[${callSid}] Error in /continue-interview (Phase: ${state.phase}):`, error);
        twiml.say({ voice: 'Polly.Aditi', language: 'en-IN' }, "An internal error occurred. Goodbye.");
        twiml.hangup();
        state.phase = 'ending';
    }
    res.type('text/xml').send(twiml.toString());
});


// --- WebSocket Server Logic (Reduced Logging) ---
wss.on('connection', (ws, req) => {
    // console.log('>>> WebSocket connection established.'); // Reduced log
    let callSid = null;
    let streamSid = null;
    let interviewState = null;
    let isActive = true;
    let vadState = { pcmBuffer: Buffer.alloc(0), isSpeaking: false, silenceFrameCounter: 0, speechStartTime: null, frameCounter: 0, noiseEnergyAvg: 0.0, speechEnergyAvg: 0.0, isInitialized: false, noiseEnergySum: 0.0, validFramesCount: 0, accumulatedSpeechBuffer: Buffer.alloc(0), totalSamplesProcessed: 0, isProcessing: false };

    function resetVadState(clearAccumulated = true) { vadState = { ...vadState, pcmBuffer: Buffer.alloc(0), isSpeaking: false, silenceFrameCounter: 0, speechStartTime: null, frameCounter: 0, accumulatedSpeechBuffer: clearAccumulated ? Buffer.alloc(0) : vadState.accumulatedSpeechBuffer, totalSamplesProcessed: 0 }; /* console.log(`[${callSid || 'WS'}] VAD state reset.`); */ } // Reduced log

    async function processDetectedSpeech() {
        if (!isActive || !callSid || !interviewState || vadState.isProcessing) return;
        vadState.isProcessing = true;
        const speechBuffer = Buffer.from(vadState.accumulatedSpeechBuffer);
        const bufferLength = speechBuffer.length;
        vadState.accumulatedSpeechBuffer = Buffer.alloc(0);
        if (bufferLength < (SAMPLE_RATE * 0.2 * 1)) { /* console.log(`[${callSid}] Ignoring short audio segment (${bufferLength} bytes).`); */ resetVadState(true); vadState.isProcessing = false; return; } // Reduced log

        console.log(`[${callSid}] Processing ${bufferLength} bytes of speech...`); // Keep this
        try {
            const wavBuffer = await convertAudio(speechBuffer);
            // console.log(`[${callSid}] Audio converted to WAV (${wavBuffer.length} bytes).`); // Reduced log
            const transcription = await Promise.race([ transcribeBuffer(wavBuffer, callSid), new Promise((_, reject) => setTimeout(() => reject(new Error("Transcription timeout (15s)")), 15000)) ]);
            const trimmedTranscription = transcription?.trim() ?? "";
            console.log(`[${callSid}] Transcription: "${trimmedTranscription}"`); // Keep this
             if (!Array.isArray(interviewState.history)) interviewState.history = [];
             interviewState.history.push({ role: 'user', content: trimmedTranscription });
             interviewState.lastActivity = Date.now();
            await triggerInterviewContinuation(callSid);
        } catch (error) {
            console.error(`[${callSid}] Error processing speech segment:`, error);
            if (!Array.isArray(interviewState.history)) interviewState.history = [];
            interviewState.history.push({ role: 'system', content: `Error processing user audio: ${error.message}` });
             try { await triggerInterviewContinuation(callSid); }
             catch (triggerError) { console.error(`[${callSid}] Failed to trigger continuation after speech processing error:`, triggerError); try { await client.calls(callSid).update({ status: 'completed' }); } catch (hangupError) { console.error(`[${callSid}] Failed to hang up call after nested errors:`, hangupError); } isActive = false; ws.close(); }
        } finally { resetVadState(true); vadState.isProcessing = false; }
    }

    async function triggerInterviewContinuation(targetCallSid) {
        if (!isActive || !targetCallSid) return;
        const currentState = interviews.get(targetCallSid);
        if (!currentState || currentState.phase === 'ending' || currentState.phase === 'scored') return;

        // console.log(`[${targetCallSid}] Triggering /continue-interview.`); // Reduced log
        let backendUrl = process.env.BACKEND_URL;
        if (!backendUrl) { console.error(`[${targetCallSid}] Cannot trigger continue: BACKEND_URL not set.`); try { await client.calls(targetCallSid).update({status: 'completed'}); } catch(e){} isActive = false; ws.close(); return; }
        if (!backendUrl.startsWith('http')) backendUrl = `https://${backendUrl}`;
        if (backendUrl.endsWith('/')) backendUrl = backendUrl.slice(0, -1);
        const continueUrl = `${backendUrl}/continue-interview/${targetCallSid}`;
        try {
             await axios.post(continueUrl, {}, { timeout: 10000 });
             // console.log(`[${targetCallSid}] Successfully triggered POST to ${continueUrl}.`); // Reduced log
         } catch (error) {
              console.error(`[${targetCallSid}] Error triggering POST to ${continueUrl}:`, error.response ? `${error.response.status} ${error.response.statusText}` : error.message);
               try {
                   console.log(`[${targetCallSid}] Attempting hangup via API due to trigger failure.`);
                   const errorTwiml = new twilio.twiml.VoiceResponse(); errorTwiml.say("A system error occurred."); errorTwiml.hangup();
                   await client.calls(targetCallSid).update({ twiml: errorTwiml.toString() });
               } catch(e) { console.error(`[${targetCallSid}] Failed to update call with hangup on trigger error:`, e)}
               isActive = false; ws.close();
         }
    }

    ws.on('error', (error) => { console.error(`>>> WebSocket Error (CallSid ${callSid || 'Unknown'}):`, error); isActive = false; if (callSid) { interviews.delete(callSid); } });
    ws.on('close', (code, reason) => { isActive = false; console.log(`>>> WebSocket closed. Code: ${code}, Reason: ${reason?.toString() || 'N/A'}, CallSid: ${callSid || 'Unknown'}`); /* Don't delete state here */ }); // Keep essential close info

    ws.on('message', async (message) => {
        if (!isActive) return;
        let msg; try { msg = JSON.parse(message); } catch (err) { console.error("Non-JSON WS message received:", message.toString().substring(0, 100)); return; } // Log beginning of non-JSON
        switch (msg.event) {
            case 'connected': /* console.log(`[${callSid || 'WS'}] WebSocket Event: connected`); */ break; // Reduced log
            case 'start':
                callSid = msg.start.callSid; streamSid = msg.start.streamSid;
                if (!callSid) { console.error("[WS] Error: callSid not found in 'start'. Closing."); isActive = false; ws.close(); return; }
                interviewState = interviews.get(callSid);
                if (!interviewState) { console.error(`[${callSid}] Error: Interview state not found for WS. Closing.`); isActive = false; ws.close(); return; }
                interviewState.streamSid = streamSid; interviewState.lastActivity = Date.now();
                console.log(`[${callSid}] WebSocket stream started.`); // Keep essential start info
                resetVadState(true); vadState.isProcessing = false;
                break;
            case 'media': // VAD Logic - Keep internal logic, reduce logging
                if (!callSid || !streamSid || !interviewState || vadState.isProcessing) return;
                const mulawChunk = Buffer.from(msg.media.payload, 'base64'); if (mulawChunk.length === 0) return;
                 try {
                    const pcm8kS16Chunk = pcmConvert(mulawChunk, { from: 'mulaw u8', to: 'pcm s16 le', rate: SAMPLE_RATE }); vadState.pcmBuffer = Buffer.concat([vadState.pcmBuffer, pcm8kS16Chunk]);
                    while (vadState.pcmBuffer.length >= BYTES_PER_PCM16_FRAME) {
                        const frameBuffer = vadState.pcmBuffer.slice(0, BYTES_PER_PCM16_FRAME); const correspondingMulawChunk = mulawChunk.slice(0, frameBuffer.length / 2); vadState.pcmBuffer = vadState.pcmBuffer.slice(BYTES_PER_PCM16_FRAME);
                        vadState.totalSamplesProcessed += FRAME_SIZE; const currentTime = vadState.totalSamplesProcessed / SAMPLE_RATE; vadState.frameCounter++;
                        let energy = 0; const frameInt16Array = new Int16Array(frameBuffer.buffer, frameBuffer.byteOffset, frameBuffer.length / 2); for (let j = 0; j < frameInt16Array.length; j++) { energy += (frameInt16Array[j] / 32768.0) ** 2; } energy = Math.max(MIN_ENERGY, energy / frameInt16Array.length);
                        if (!vadState.isInitialized) { // VAD Init
                             if (vadState.frameCounter <= INITIAL_NOISE_FRAMES) { if (energy < MAX_REASONABLE_INIT_ENERGY) { vadState.noiseEnergySum += energy; vadState.validFramesCount++; } if (vadState.frameCounter === INITIAL_NOISE_FRAMES) { vadState.noiseEnergyAvg = vadState.validFramesCount > 0 ? vadState.noiseEnergySum / vadState.validFramesCount : MIN_ENERGY; vadState.noiseEnergyAvg = Math.max(MIN_ENERGY, vadState.noiseEnergyAvg); vadState.speechEnergyAvg = vadState.noiseEnergyAvg * (RELATIVE_RISE_FACTOR * 1.5); vadState.isInitialized = true; /* console.log(`[${callSid}] VAD Initialized.`); */ } continue; } // Reduced log
                             else { vadState.noiseEnergyAvg = MIN_ENERGY; vadState.speechEnergyAvg = vadState.noiseEnergyAvg * (RELATIVE_RISE_FACTOR * 1.5); vadState.isInitialized = true; console.warn(`[${callSid}] WARN: VAD Init fallback.`); }
                         } // VAD Decision
                         let currentSilenceThresholdValue = vadState.speechEnergyAvg * 0.25; let isFramePotentiallySilent = currentSilenceThresholdValue >= SILENCE_THRESHOLD_VALUE; let potentialSpeech = energy > vadState.noiseEnergyAvg * RELATIVE_RISE_FACTOR;
                         if (vadState.isSpeaking) { // Speaking State
                             vadState.accumulatedSpeechBuffer = Buffer.concat([vadState.accumulatedSpeechBuffer, correspondingMulawChunk]); if (!isFramePotentiallySilent) { vadState.speechEnergyAvg = (SMOOTHING_ALPHA * energy) + ((1 - SMOOTHING_ALPHA) * vadState.speechEnergyAvg); } if (isFramePotentiallySilent) { vadState.silenceFrameCounter++; } else { vadState.silenceFrameCounter = 0; }
                             if (vadState.silenceFrameCounter >= SILENCE_DURATION_FRAMES) { /* console.log(`\n======= [${callSid}] Speech End Detected =======\n`); */ vadState.isSpeaking = false; vadState.speechStartTime = null; vadState.silenceFrameCounter = 0; processDetectedSpeech(); break; } // Reduced log
                         } else { // Not Speaking State
                             vadState.noiseEnergyAvg = (SMOOTHING_ALPHA * energy) + ((1 - SMOOTHING_ALPHA) * vadState.noiseEnergyAvg); vadState.noiseEnergyAvg = Math.max(MIN_ENERGY, vadState.noiseEnergyAvg);
                             if (potentialSpeech) { /* console.log(`\n======= [${callSid}] Speech Start Detected =======\n`); */ vadState.isSpeaking = true; vadState.speechStartTime = currentTime; vadState.silenceFrameCounter = 0; vadState.speechEnergyAvg = Math.max(energy, vadState.speechEnergyAvg, vadState.noiseEnergyAvg * RELATIVE_RISE_FACTOR); vadState.accumulatedSpeechBuffer = Buffer.concat([vadState.accumulatedSpeechBuffer, correspondingMulawChunk]); } // Reduced log
                         }
                    }
                 } catch(pipelineError) { console.error(`[${callSid}] Error during VAD/media pipeline:`, pipelineError); vadState.pcmBuffer = Buffer.alloc(0); resetVadState(true); }
                break;
            case 'stop': console.log(`[${callSid}] WebSocket Event: stop.`); isActive = false; if (vadState.isSpeaking && vadState.accumulatedSpeechBuffer.length > 0) { console.log(`[${callSid}] Stream stopped mid-speech. Processing final segment.`); await processDetectedSpeech(); } resetVadState(true); callSid = null; streamSid = null; interviewState = null; break; // Keep stop event log
            case 'mark': /* console.log(`[${callSid}] WebSocket Event: Mark - Name: ${msg.mark?.name}`); */ break; // Reduced log
            case 'error': console.error(`[${callSid}] WebSocket Twilio Error Event:`, msg.error); isActive = false; ws.close(); break; // Keep error log
            default: console.log(`[${callSid || 'WS'}] Received unknown WS event: ${msg.event}`); break;
        }
    });
});
// --- End WebSocket ---


app.post('/call-status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration, ErrorCode, ErrorMessage } = req.body;
  console.log(`[${CallSid}] Call Status: ${CallStatus}, Duration: ${CallDuration}s`); // Keep essential status
   if (ErrorCode && ErrorCode !== '0' && ErrorCode !== '11200') { console.error(`[${CallSid}] Call Error Code: ${ErrorCode} - ${ErrorMessage || 'No message'}`); } // Keep error code log

  const state = interviews.get(CallSid);
  try {
      const terminalStatuses = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];
      if (terminalStatuses.includes(CallStatus)) {
           // console.log(`[${CallSid}] Call ended with terminal status: ${CallStatus}.`); // Redundant with above log
           if (state) {
                 if (state.phase !== 'scored') {
                      console.log(`[${CallSid}] Triggering endInterview due to terminal status.`); // Keep this trigger log
                      await endInterview(CallSid, CallStatus);
                 } else {
                      // console.log(`[${CallSid}] Terminal status (${CallStatus}) received, but already scored. Final cleanup.`); // Reduced log
                      interviews.delete(CallSid);
                 }
           } else {
                console.warn(`[${CallSid}] No interview state found on terminal status ${CallStatus}. Cannot score.`); // Keep warning
           }
           // TTS File Cleanup
           const audioPattern = new RegExp(`^tts_${CallSid}_\\d+\\.wav$`);
           fs.readdir(audioDir, (err, files) => {
                if (err) { console.error(`[${CallSid}] Error reading audio directory for cleanup:`, err); return; }
                files.forEach(file => {
                    if (audioPattern.test(file)) {
                        const filePath = path.join(audioDir, file);
                        fs.unlink(filePath, (unlinkErr) => {
                            if (unlinkErr) console.error(`[${CallSid}] Error deleting TTS file ${filePath}:`, unlinkErr);
                            // else console.log(`[${CallSid}] Cleaned up TTS file: ${filePath}`); // Reduced log
                        });
                    }
                });
           });
      } else {
             // console.log(`[${CallSid}] Non-terminal status update: ${CallStatus}`); // Reduced log
             if (state) { state.lastActivity = Date.now(); }
      }
  } catch (error) {
    console.error(`[${CallSid}] Status handler failed for status ${CallStatus}:`, error);
  } finally {
    res.status(200).send();
  }
});


// *** MODIFIED endInterview Function for Robust Scoring ***
async function endInterview(callSid, finalCallStatus = 'unknown') {
  const state = interviews.get(callSid);

  if (!state) { /* console.log(`[${callSid}] Skipping endInterview: No state.`); */ interviews.delete(callSid); return; } // Reduced log
  if(state.phase === 'scored') { /* console.log(`[${callSid}] Skipping endInterview: Already scored.`); */ return; } // Reduced log

   console.log(`[${callSid}] Ending interview. Final Call Status: ${finalCallStatus}, Last Phase: ${state.phase}.`); // Keep essential end log
   // console.log(`[${callSid}] State details: email=${state.email}, phone=${state.candidatePhone}, name=${state.candidateName}`); // Reduced log

   const previousPhase = state.phase;
   state.phase = 'scored';
   state.lastActivity = Date.now();

  let scoreResult = null;
  let dbStatus = 'completed';
  let justification = "";
  let transcriptContent = 'No transcript available';

  try {
    if (!Array.isArray(state.history)) state.history = [];
    const hasMeaningfulHistory = state.history.some(entry => entry.role === 'user' && entry.content?.trim());
    transcriptContent = state.history.map(entry => `${entry.role}: ${entry.content}`).join('\n\n') || 'No transcript available';

    // Determine base status/justification
    if (['failed', 'canceled', 'no-answer', 'busy'].includes(finalCallStatus)) {
         dbStatus = finalCallStatus; justification = `Call ended with status: ${finalCallStatus}.`;
         if (!hasMeaningfulHistory) justification += " No meaningful interaction recorded.";
         scoreResult = { technicalScore: 0, communicationScore: 0, justification: justification, completionStatus: dbStatus, breakdown: [] };
    } else if (!hasMeaningfulHistory && finalCallStatus === 'completed') {
         dbStatus = 'incomplete'; justification = "Interview completed but no meaningful user responses recorded.";
         scoreResult = { technicalScore: 0, communicationScore: 0, justification: justification, completionStatus: dbStatus, breakdown: [] };
    } else if (finalCallStatus === 'completed' && hasMeaningfulHistory) {
         console.log(`[${callSid}] Generating final score...`); // Keep scoring log
         try {
             const rawScoreString = await Promise.race([ generateFinalScore(state.history, state.jobRole, state.jobDescription), new Promise((_, reject) => setTimeout(() => reject(new Error('Scoring timeout (25s)')), 25000)) ]);
             // *** Robust JSON Parsing ***
             try {
                 scoreResult = JSON.parse(rawScoreString);
                  if (typeof scoreResult.technicalScore !== 'number' || typeof scoreResult.communicationScore !== 'number') { throw new Error("Parsed score missing numeric scores."); }
                 dbStatus = scoreResult.completionStatus || 'completed';
                 justification = scoreResult.justification || "Scoring complete.";
                 console.log(`[${callSid}] Scoring successful. Tech: ${scoreResult.technicalScore}, Comm: ${scoreResult.communicationScore}`); // Keep score result log
             } catch (parseError) {
                 console.error(`[${callSid}] Failed to parse scoring JSON. Raw response: "${rawScoreString}". Error: ${parseError.message}`); // Keep parse error log
                 dbStatus = 'error'; justification = `Scoring evaluation returned invalid format. Raw response: "${rawScoreString}"`;
                 scoreResult = { technicalScore: 0, communicationScore: 0, justification: justification, completionStatus: dbStatus, breakdown: [] };
             }
             // *** End Robust JSON Parsing ***
         } catch (scoringError) {
             console.error(`[${callSid}] Scoring failed or timed out:`, scoringError.message); // Keep scoring error log
             dbStatus = 'error'; justification = `Automatic scoring process failed or timed out: ${scoringError.message}`;
             scoreResult = { technicalScore: 0, communicationScore: 0, justification: justification, completionStatus: dbStatus, breakdown: [] };
         }
    } else { // Unknown status or completed without meaningful history (already handled)
         dbStatus = finalCallStatus === 'completed' ? 'incomplete' : (finalCallStatus || 'unknown'); // Refine unknown status
         justification = `Call ended with status: ${dbStatus}.`;
         if (!hasMeaningfulHistory) justification += " No meaningful interaction recorded.";
         scoreResult = { technicalScore: 0, communicationScore: 0, justification: justification, completionStatus: dbStatus, breakdown: [] };
    }

    // --- Database Update (Simplified - Confirmed Working) ---
    // console.log(`[${callSid}] Attempting DB update for phone: ${state.candidatePhone} with status: ${dbStatus}`); // Reduced log
    let attempts = 0;
    let updated = false;
    while (attempts < 3 && !updated) {
        attempts++;
        try {
            const updatePayload = {
                'candidates.$.status': dbStatus, 'candidates.$.endedAt': new Date(), 'candidates.$.completionStatus': dbStatus,
                'candidates.$.scoreJustification': justification, 'candidates.$.transcript': transcriptContent,
                'candidates.$.technicalScore': scoreResult?.technicalScore ?? 0, 'candidates.$.communicationScore': scoreResult?.communicationScore ?? 0,
                'candidates.$.scoreBreakdown': scoreResult?.breakdown ?? [], 'candidates.$.startedAt': state.startTime || null
            };
            // console.log(`[${callSid}] DB Update Attempt ${attempts} (Simplified)`); // Reduced log
            const updateResult = await ScheduledCall.updateOne( { email: state.email, 'candidates.phone': state.candidatePhone }, { $set: updatePayload } );
            // console.log(`[${callSid}] DB Update Result ${attempts}:`, JSON.stringify(updateResult)); // Reduced log
            if (updateResult.acknowledged && updateResult.matchedCount > 0) {
                console.log(`[${callSid}] Successfully updated DB record (Matched: ${updateResult.matchedCount}, Modified: ${updateResult.modifiedCount}).`); // Keep final DB result
                updated = true;
            } else if (updateResult.acknowledged && updateResult.matchedCount === 0) {
                console.warn(`[${callSid}] DB update did not match record. Attempt ${attempts}. (Email: ${state.email}, Phone: ${state.candidatePhone})`); // Keep warning
                 break;
            } else {
                 console.warn(`[${callSid}] DB update failed/not acknowledged. Attempt ${attempts}. Result: ${JSON.stringify(updateResult)}`); // Keep warning
                 await new Promise(resolve => setTimeout(resolve, 1000 * attempts)); // Shorter retry delay
            }
        } catch (dbError) {
            console.error(`[${callSid}] DB update attempt ${attempts} failed with error:`, dbError); // Keep DB error
            if (attempts >= 3) console.error(`[${callSid}] Failed DB update after 3 attempts.`); else await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
        }
    }
    if (!updated) { console.error(`[${callSid}] CRITICAL: Failed to update DB record after all attempts.`); /* Log details maybe */ } // Keep critical failure

  } catch (error) {
    console.error(`[${callSid}] CRITICAL: endInterview process error -`, error.message, error.stack); // Keep critical failure
  } finally {
    interviews.delete(callSid);
    // console.log(`[${callSid}] Interview state cleared from memory.`); // Reduced log
  }
}
// *** END MODIFIED endInterview ***


// --- get scheduled-calls (Keep as is, logging is minimal) ---
app.get("/scheduled-calls", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) { return res.status(400).json({ error: "Email query parameter is required." }); }
    const calls = await ScheduledCall.find({ email }).sort({ scheduledTime: -1 });
    const response = calls.map(call => ({
      _id: call._id, jobRole: call.jobRole, jobDescription: call.jobDescription, scheduledTime: call.scheduledTime, status: call.status, email: call.email,
      candidates: call.candidates.map(candidate => ({ _id: candidate._id, name: candidate.name, phone: candidate.phone, technicalScore: candidate.technicalScore ?? null, communicationScore: candidate.communicationScore ?? null, scoreJustification: candidate.scoreJustification ?? null, scoreBreakdown: candidate.scoreBreakdown ?? [], completionStatus: candidate.completionStatus || 'scheduled', status: candidate.status || 'scheduled', transcript: candidate.transcript, startedAt: candidate.startedAt || null, endedAt: candidate.endedAt || null, })) }));
    res.json(response);
  } catch (error) {
    console.error("Error fetching scheduled calls:", error);
    res.status(500).json({ error: "Failed to fetch scheduled calls" });
  }
});
// --- End get scheduled-calls ---


app.options('*', cors());

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`); // Keep this
  let backendUrl = process.env.BACKEND_URL;
   if (backendUrl && !backendUrl.startsWith('http')) { backendUrl = `https://${backendUrl}`; }
   if (backendUrl && backendUrl.endsWith('/')) { backendUrl = backendUrl.slice(0, -1); }
   if(backendUrl) {
       console.log(` -> Twilio Voice URL: ${backendUrl}/voice`); // Keep key URLs
       console.log(` -> Twilio Status URL: ${backendUrl}/call-status`);
       console.log(` -> WebSocket URL: ${backendUrl.replace(/^http/, 'ws')}`);
       console.log(` -> TTS Audio Base: ${backendUrl}/audio/`);
   } else { console.error("Warning: BACKEND_URL environment variable not set."); } // Keep warning
});

const gracefulShutdown = (signal) => {
  console.log(`\nReceived ${signal}. Closing server gracefully...`); // Keep shutdown message
  server.close(() => {
    console.log('HTTP server closed.'); // Keep shutdown message
    wss.close(() => { console.log('WebSocket server closed.'); }); // Keep shutdown message
    mongoose.connection.close(false).then(() => {
        console.log('MongoDB connection closed.'); // Keep shutdown message
        try { // TTS File Cleanup on Shutdown
           const files = fs.readdirSync(audioDir); let deletedCount = 0;
           files.forEach(file => { if (file.startsWith('tts_') && file.endsWith('.wav')) { try { fs.unlinkSync(path.join(audioDir, file)); deletedCount++; } catch (unlinkErr) { /* Ignore unlink error */ } } });
           if(deletedCount > 0) console.log(`Cleaned up ${deletedCount} temp TTS file(s) on shutdown.`);
        } catch (readErr) { /* Ignore read error */ }
        process.exit(0);
    }).catch(err => { console.error('Error closing MongoDB connection:', err); process.exit(1); });
    setTimeout(() => { console.error("Graceful shutdown timed out. Forcing exit."); process.exit(1); }, 8000); // Shorter timeout
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err, origin) => { console.error(`\n----- UNCAUGHT EXCEPTION ----- \nOrigin: ${origin}\n`, err, `\n----- END UNCAUGHT EXCEPTION -----\n`); /* Consider exiting: process.exit(1); */ }); // Keep critical errors
process.on('unhandledRejection', (reason, promise) => { console.error(`\n----- UNHANDLED REJECTION ----- \nReason:`, reason, `\n----- END UNHANDLED REJECTION -----\n`); /* Consider exiting: process.exit(1); */ }); // Keep critical errors