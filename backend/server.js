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
const webCallRouter = require('./WebCall');
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

// Silence Detection Constants (Keep as is)
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
const TTS_PLAYBACK_DELAY_MS = 1500; // Delay after triggering TwiML before VAD resumes


// Express Middleware (Keep as is)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use('/api/web-call', webCallRouter); 

// Serve static files (for TTS audio)
const audioDir = path.join(__dirname, 'public', 'audio');
if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
}
app.use(express.static(path.join(__dirname, 'public'))); // Serve files from 'public' directory

// Connect to MongoDB (Keep as is)
connectDB();
// Initialize Passport (Keep as is)
app.use(passport.initialize());
// Routes (Keep as is)
app.use('/', authRoutes);
app.get('/', (req, res) => { res.send('Backend/Twilio server with WebSocket is running!'); });
// Nodemailer setup (Keep as is)
const transporter = nodemailer.createTransport({ /* ... */ });


// --- NEW: SARVAM TTS Integration ---
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
        speaker: "anushka", // Specify Anushka's voice
        model: "bulbul:v2", // Specify the model
        speech_sample_rate: 8000 // Match Twilio's expected rate
    };

    console.log(`[${callSid}] Requesting TTS from Sarvam for text: "${text.substring(0, 50)}..."`);

    try {
        // According to Sarvam docs, API returns JSON with base64 audio
        const response = await axios.post(apiUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'api-subscription-key': apiKey
            },
            responseType: 'json', // Expect JSON response
            timeout: 10000 // Timeout for the API call
        });

        if (response.data && response.data.audios && response.data.audios.length > 0 && response.data.audios[0]) {
            const base64Audio = response.data.audios[0];
            const audioBuffer = Buffer.from(base64Audio, 'base64');

            // Generate a unique filename
            const filename = `tts_${callSid}_${Date.now()}.wav`;
            const filePath = path.join(audioDir, filename);

            // Save the audio buffer to the file
            await fs.promises.writeFile(filePath, audioBuffer);

            // Construct the public URL
            const publicUrl = `${backendUrl}/audio/${filename}`;
            console.log(`[${callSid}] Generated TTS audio URL: ${publicUrl}`);

            return publicUrl; // Return the URL for Twilio <Play>
        } else {
            console.error(`[${callSid}] Sarvam TTS API returned unexpected JSON format:`, response.data);
            throw new Error("Invalid response format from TTS API.");
        }
    } catch (error) {
        const errorMsg = error.response ? `${error.response.status} ${error.response.statusText} - ${JSON.stringify(error.response.data)}` : error.message;
        console.error(`[${callSid}] Error calling Sarvam TTS API:`, errorMsg);
        throw new Error(`Failed to generate TTS audio: ${error.message}`);
    }
}
// --- END SARVAM TTS Integration ---


// --- make-call Endpoint (Keep as is, no changes needed here) ---
app.post("/make-call", async (req, res) => {
    // ... (Existing make-call logic remains unchanged) ...
    const { jobRole, jobDescription, candidates, email } = req.body;
    try {
        // Input validation
        if (!jobRole || !jobDescription || !candidates || !Array.isArray(candidates)) return res.status(400).json({ error: "Missing fields" });
        // User limit check
        if (email) { /* ... user limit check ... */ }
        const results = [];
        let backendUrl = process.env.BACKEND_URL;
        // Backend URL validation
        if (!backendUrl) { /* ... handle missing URL ... */ return res.status(500).json({ error: "Config error" }); }
        if (!backendUrl.startsWith('http')) backendUrl = `https://${backendUrl}`;
        if (backendUrl.endsWith('/')) backendUrl = backendUrl.slice(0, -1);

        for (const candidate of candidates) {
            // Candidate data validation
            if (!candidate || typeof candidate.phone !== 'string' || !candidate.phone.trim() || typeof candidate.name !== 'string' || !candidate.name.trim()) { /* ... skip and revert count ... */ continue; }
            try {
                console.log(`Initiating call to ${candidate.name} (${candidate.phone}) for role "${jobRole}"`);
                const twimlUrl = `${backendUrl}/voice?jobRole=${encodeURIComponent(jobRole)}&jobDescription=${encodeURIComponent(jobDescription)}`;
                const statusCallbackUrl = `${backendUrl}/call-status`;
                const call = await client.calls.create({ to: candidate.phone, from: process.env.TWILIO_PHONE_NUMBER, url: twimlUrl, statusCallback: statusCallbackUrl, statusCallbackEvent: ['completed', 'failed', 'busy', 'no-answer', 'canceled'], statusCallbackMethod: 'POST' });
                console.log(`[${call.sid}] Call initiated. Storing initial state.`);
                interviews.set(call.sid, {
                  jobRole, jobDescription, history: [], phase: 'introduction',
                  candidatePhone: candidate.phone, candidateName: candidate.name,
                  lastActivity: Date.now(), email, callSid: call.sid, streamSid: null,
                  startTime: new Date(),
                  // WebSocket/VAD specific state
                  currentAudioBuffer: Buffer.alloc(0), // Buffer for WebSocket audio (might not be needed if VAD state handles it)
                  vadState: null, // To store VAD state per call - initialized in WebSocket 'start'
                  isWaitingForAi: false // NEW flag for VAD synchronization
                });
                results.push({ success: true, callSid: call.sid, phone: candidate.phone, name: candidate.name });
            } catch (error) { /* ... handle call creation error and revert count ... */ }
        }
        res.json({ success: true, results, message: `Initiated ${results.filter(r => r.success).length} calls` });
    } catch (error) { console.error("Make Call Route Error:", error); res.status(500).json({ error: "Call processing failed" }); }
});

const cron = require('node-cron');

app.post('/schedule-call', async (req, res) => {
  try {
    const { email, jobRole, jobDescription, candidates, scheduledTime } = req.body;

    if (!email || !jobRole || !jobDescription || !candidates || !Array.isArray(candidates) || candidates.length === 0 || !scheduledTime) {
         return res.status(400).json({ error: "Missing required fields for scheduling." });
    }

    // Validate scheduled time is in the future
    const scheduleDate = new Date(scheduledTime);
    if (isNaN(scheduleDate.getTime()) || scheduleDate <= new Date()) { // Check for invalid date as well
        return res.status(400).json({ error: "Scheduled time must be a valid date in the future." });
    }


    // Basic validation for candidate structure *before* creating the document
     if (!candidates.every(c => c && typeof c.phone === 'string' && c.phone.trim() !== '' && typeof c.name === 'string' && c.name.trim() !== '')) {
         return res.status(400).json({ error: "Invalid candidate data. Each candidate must have a non-empty 'name' and 'phone' property." });
     }


    const scheduledCall = new ScheduledCall({
      email,
      jobRole,
      jobDescription,
      // --- CORRECTED CANDIDATE MAPPING ---
      candidates: candidates.map(c => ({
          name: c.name, // Include the name field
          phone: c.phone,
          // Initialize other fields expected by endInterview/schema
          technicalScore: null,
          communicationScore: null,
          scoreJustification: null,
          scoreBreakdown: [],
          completionStatus: 'scheduled',
          transcript: null,
          status: 'scheduled', // Initial status for the candidate within the schedule
          startedAt: null,
          endedAt: null
      })),
      // --- END CORRECTION ---
      scheduledTime: scheduleDate, // Use validated date object
      status: 'scheduled' // Overall status of the scheduled job
    });

    await scheduledCall.save(); // This is where the validation happens
    console.log(`Scheduled call saved successfully for email: ${email}`);
    res.status(201).json(scheduledCall);

  } catch (error) {
    // Catch Mongoose validation errors specifically
    if (error.name === 'ValidationError') {
        console.error("Error scheduling call (Validation Failed):", error.errors);
         // Provide a more specific error message based on validation failure
         const validationErrors = Object.values(error.errors).map(err => err.message).join(', ');
         res.status(400).json({ error: `Validation Failed: ${validationErrors}` });
    } else {
        // Catch other potential errors (DB connection, etc.)
        console.error("Error scheduling call (General):", error);
        res.status(500).json({ error: "Failed to schedule call due to a server error." });
    }
  }
});

// Cron job runs every minute to check for scheduled calls
cron.schedule('* * * * *', async () => {
  // console.log('Cron job running: Checking for scheduled calls...'); // Optional: Log cron execution
  try {
    const now = new Date();
    // Find calls scheduled for now or earlier, still in 'scheduled' status
    const callsToInitiate = await ScheduledCall.find({
      scheduledTime: { $lte: now },
      status: 'scheduled' // Ensure we only process calls not already processing/completed/failed
    }).limit(5); // Limit the number of jobs processed per minute

    if (callsToInitiate.length > 0) {
        console.log(`Found ${callsToInitiate.length} scheduled call(s) to initiate.`);
    }

    for (const call of callsToInitiate) {
      console.log(`Processing scheduled call ID: ${call._id}`);
      let processingStatus = 'processing'; // Default to processing

      try {
        // Immediately update status to 'processing' to prevent duplicate processing
        const updateResult = await ScheduledCall.updateOne(
          { _id: call._id, status: 'scheduled' }, // Add status check for atomicity
          { $set: { status: 'processing' } }
        );

        // Check if the update actually happened (atomicity check)
        if (updateResult.modifiedCount === 0) {
             console.warn(`[${call._id}] Scheduled call was likely picked up by another process. Skipping.`);
             continue; // Skip to the next call
        }


        // --- URL CONSTRUCTION ---
        let backendUrl = process.env.BACKEND_URL;
         if (!backendUrl) {
             console.error(`[${call._id}] Cannot initiate scheduled call: BACKEND_URL not set.`);
             processingStatus = 'failed'; // Mark as failed immediately
             await ScheduledCall.updateOne({ _id: call._id }, { $set: { status: processingStatus, scoreJustification: 'Server configuration error: BACKEND_URL missing.' } });
             continue; // Skip to next call
         }
         if (!backendUrl.startsWith('http://') && !backendUrl.startsWith('https://')) {
             backendUrl = `https://${backendUrl}`; // Default to https
         }
         const makeCallUrl = `${backendUrl}/make-call`;
         console.log(`[${call._id}] Cron job triggering internal API at: ${makeCallUrl}`);
        // --- END URL CONSTRUCTION ---


        // Initiate the call by POSTing to the regular /make-call endpoint
        const response = await axios.post(
          makeCallUrl,
          {
            jobRole: call.jobRole,
            jobDescription: call.jobDescription,
            // Pass candidates WITH name and phone from the DB record
             candidates: call.candidates.map(c => ({ name: c.name, phone: c.phone })),
            email: call.email // Pass the user's email
          },
          { timeout: 15000 } // Increased timeout for the internal request
        );

        // If the /make-call request was successful (doesn't mean calls connected yet)
        console.log(`[${call._id}] Successfully triggered /make-call endpoint. Response status: ${response.status}`);
        processingStatus = 'completed'; // Mark cron processing as complete


      } catch (error) {
        processingStatus = 'failed'; // Mark as failed if trigger fails
        const errorMessage = error.response?.data?.error || error.message;
        console.error(`[${call._id}] Failed to initiate scheduled call via internal API:`, errorMessage);
        // Update status to 'failed' and add reason
         await ScheduledCall.updateOne(
             { _id: call._id },
             { $set: { status: processingStatus, scoreJustification: `Failed to trigger calls: ${errorMessage}` } }
         );
      } finally {
           // Update status if it wasn't already set to failed in the catch block
           if (processingStatus !== 'failed') {
                await ScheduledCall.updateOne(
                     { _id: call._id },
                     { $set: { status: processingStatus } }
                 );
                 console.log(`[${call._id}] Marked scheduled call cron processing as ${processingStatus}.`);
           }
      }
    }
  } catch (error) {
    // Error fetching calls or general cron job error
    console.error("Error in call initiation cron job:", error);
  }
});


// --- MODIFIED /voice Endpoint (Use Sarvam TTS) ---
app.post('/voice', async (req, res) => { // Make async for TTS call
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

  const greeting = `Hello, this is Moon, your AI interviewer from. Can you please start by introducing yourself?`;
  console.log(`[${callSid}] AI Intro: ${greeting.substring(0, 80)}...`);
  if (!Array.isArray(state.history)) state.history = [];
  state.history.push({ role: 'assistant', content: greeting });

  // --- Use Sarvam TTS for Greeting ---
  try {
    const audioUrl = await generateAndServeTTS(greeting, callSid);
    twiml.play(audioUrl); // Use <Play> with the generated URL
  } catch (ttsError) {
      console.error(`[${callSid}] TTS generation failed for greeting: ${ttsError.message}. Falling back to <Say>.`);
      // Fallback to standard Twilio voice if TTS fails
      twiml.say({ voice: 'Polly.Aditi', language: 'en-IN' }, greeting );
  }
  // --- End TTS Integration ---

  console.log(`[${callSid}] Connecting to WebSocket: ${websocketUrl}`);
  const connect = twiml.connect();
  connect.stream({ url: websocketUrl, track: 'inbound_track' });
  twiml.pause({ length: 60 }); // Keep pause, WS drives the interaction

  console.log(`[${callSid}] Sent initial TwiML (<Play>/<Say>, <Stream>, <Pause>).`);
  res.type('text/xml').send(twiml.toString());
});


// --- MODIFIED /continue-interview Endpoint (Use Sarvam TTS) ---
app.post('/continue-interview/:callSid', async (req, res) => { // Make async for TTS call
    const callSid = req.params.callSid;
    const state = interviews.get(callSid);
    const twiml = new twilio.twiml.VoiceResponse();

    if (!state) { console.error(`[${callSid}] /continue-interview: State not found. Hanging up.`); twiml.say("An error occurred."); twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }
    if (state.phase === 'ending' || state.phase === 'scored') { console.warn(`[${callSid}] /continue-interview: Called in terminal phase (${state.phase}). Hanging up.`); twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }

    console.log(`[${callSid}] Continuing interview, current phase: ${state.phase}`);

    try {
        let aiResponse = "";
        let nextPhase = state.phase;
        let pauseDuration = 60; // Keep pause as WS/VAD triggers next step

        // --- Interview Logic Switch (Keep internal logic) ---
        switch (state.phase) {
            case 'introduction':
                aiResponse = await getAiResponse("Ask the first technical question...", state.jobRole, state.jobDescription, false, state.history);
                nextPhase = 'question1';
                break;
            case 'question1':
                aiResponse = await getAiResponse("Ask the second technical question...", state.jobRole, state.jobDescription, false, state.history);
                nextPhase = 'question2';
                break;
            case 'question2':
                aiResponse = "Thank you... Do you have any questions for me...?";
                nextPhase = 'qna_listen';
                break;
            case 'qna_listen':
                 // ... existing QnA logic ...
                 const lastUserMessage = state.history?.[state.history.length - 1];
                 const userContent = lastUserMessage?.content?.trim() ?? "";
                 const hasQuestion = lastUserMessage && lastUserMessage.role === 'user' && userContent !== "" && !/^(no|nope|no questions?|nothing)$/i.test(userContent);
                 if (hasQuestion) {
                     const qnaAnswer = await Promise.race([ getQnAResponse(userContent, state.history.slice(0, -1)), new Promise(r => setTimeout(() => r("Noted."), 10000)) ]);
                     aiResponse = `${qnaAnswer} Anything else?`;
                     nextPhase = 'qna_followup';
                 } else {
                     aiResponse = "Okay... Goodbye!";
                     nextPhase = 'ending';
                 }
                 break;
             case 'qna_followup':
                 // ... existing Followup logic ...
                 const lastFollowupMessage = state.history?.[state.history.length - 1];
                 const followupContent = lastFollowupMessage?.content?.trim() ?? "";
                 const hasFollowupQuestion = lastFollowupMessage && lastFollowupMessage.role === 'user' && followupContent !== "" && !/^(no|nope|no more|that's all)$/i.test(followupContent);
                 if (hasFollowupQuestion) {
                      const followupAnswer = await Promise.race([ getQnAResponse(followupContent, state.history.slice(0, -1)), new Promise(r => setTimeout(() => r("Noted."), 8000)) ]);
                      aiResponse = `${followupAnswer} Anything else?`;
                      nextPhase = 'qna_followup';
                 } else {
                      aiResponse = "Great. Thank you... Goodbye!";
                      nextPhase = 'ending';
                 }
                 break;
            default:
                aiResponse = "Ending the call. Goodbye.";
                nextPhase = 'ending';
        }
        // --- End Switch ---

        // --- Use Sarvam TTS for AI Response ---
        if (aiResponse) {
             console.log(`[${callSid}] AI Response (${nextPhase}): ${aiResponse.substring(0, 80)}...`);
             if (!Array.isArray(state.history)) state.history = [];
             state.history.push({ role: 'assistant', content: aiResponse });
             try {
                 const audioUrl = await generateAndServeTTS(aiResponse, callSid);
                 twiml.play(audioUrl); // Use <Play> with the generated URL
             } catch (ttsError) {
                 console.error(`[${callSid}] TTS generation failed for phase ${nextPhase}: ${ttsError.message}. Falling back to <Say>.`);
                 // Fallback to standard Twilio voice if TTS fails
                 twiml.say( { voice: 'Polly.Aditi', language: 'en-IN' }, aiResponse );
             }
        }
        // --- End TTS Integration ---

        state.phase = nextPhase;
        state.lastActivity = Date.now();

        if (state.phase === 'ending') {
            console.log(`[${callSid}] Phase is 'ending'. Sending <Hangup> TwiML.`);
            twiml.hangup();
            // NOTE: Scoring happens in endInterview triggered by call-status
        } else {
             console.log(`[${callSid}] Phase is '${state.phase}'. Waiting for next user response via WebSocket with Pause ${pauseDuration}s.`);
             twiml.pause({ length: pauseDuration }); // Keep listening via WS
        }

    } catch (error) {
        console.error(`[${callSid}] Error in /continue-interview (Phase: ${state.phase}):`, error);
        twiml.say({ voice: 'Polly.Aditi', language: 'en-IN' }, "An internal error occurred. Goodbye.");
        twiml.hangup();
        state.phase = 'ending'; // Mark as ending due to error
    }
    res.type('text/xml').send(twiml.toString());
});


// --- WebSocket Server Logic (Modified for Synchronization) ---
wss.on('connection', (ws, req) => {
    console.log('>>> WebSocket connection established.');
    let callSid = null;
    let streamSid = null;
    let interviewState = null; // Reference to the entry in the 'interviews' map
    let isActive = true;

    // Initialize VAD state per connection
    let vadState = { /* ... existing VAD state properties ... */ isProcessing: false }; // Keep isProcessing flag
    function initializeVadState() { // Renamed from resetVadState for clarity on first call
        return { pcmBuffer: Buffer.alloc(0), isSpeaking: false, silenceFrameCounter: 0, speechStartTime: null, frameCounter: 0, noiseEnergyAvg: 0.0, speechEnergyAvg: 0.0, isInitialized: false, noiseEnergySum: 0.0, validFramesCount: 0, accumulatedSpeechBuffer: Buffer.alloc(0), totalSamplesProcessed: 0, isProcessing: false };
    }
    function resetVadForNextUtterance() { // Specific function for resetting after processing
        vadState.pcmBuffer = Buffer.alloc(0);
        vadState.isSpeaking = false; // Reset speaking status
        vadState.silenceFrameCounter = 0; // Reset silence counter
        vadState.speechStartTime = null;
        vadState.accumulatedSpeechBuffer = Buffer.alloc(0); // Clear buffer for NEXT utterance
        vadState.totalSamplesProcessed = 0;
        vadState.frameCounter = 0; // Reset frame counter for segment timing
        // Keep noise/speech averages adaptive
        // Keep isInitialized=true
        // isProcessing flag is handled separately
        console.log(`[${callSid || 'WS Connection'}] VAD reset for next utterance.`);
    }

    // --- MODIFIED: processDetectedSpeech with state flag ---
    async function processDetectedSpeech() {
        if (!isActive || !callSid || !interviewState) return;
        // Check processing flag AND the new isWaitingForAi flag
        if (vadState.isProcessing || interviewState.isWaitingForAi) {
             console.warn(`[${callSid}] Skipping processDetectedSpeech (Processing: ${vadState.isProcessing}, WaitingForAI: ${interviewState.isWaitingForAi})`);
             return;
        }

        // Set flags to prevent parallel processing AND pause VAD during AI turn
        vadState.isProcessing = true;
        interviewState.isWaitingForAi = true; // PAUSE VAD HERE

        const speechBuffer = Buffer.from(vadState.accumulatedSpeechBuffer);
        const bufferLength = speechBuffer.length;
        vadState.accumulatedSpeechBuffer = Buffer.alloc(0); // Clear accumulator for next time

        if (bufferLength < (SAMPLE_RATE * 0.2 * 1)) {
            console.log(`[${callSid}] Ignoring short audio segment (${bufferLength} bytes).`);
            vadState.isProcessing = false;
            interviewState.isWaitingForAi = false; // RESUME VAD immediately if ignored
            resetVadForNextUtterance();
            return;
        }

        console.log(`[${callSid}] Processing ${bufferLength} bytes of speech...`);
        try {
            // 1. Convert u-law buffer to WAV buffer
            const wavBuffer = await convertAudio(speechBuffer);
            // 2. Transcribe WAV buffer
            const transcription = await Promise.race([ transcribeBuffer(wavBuffer, callSid), new Promise((_, reject) => setTimeout(() => reject(new Error("Transcription timeout (15s)")), 15000)) ]);
            const trimmedTranscription = transcription?.trim() ?? "";
            console.log(`[${callSid}] Transcription: "${trimmedTranscription}"`);
            if (!Array.isArray(interviewState.history)) interviewState.history = [];
            interviewState.history.push({ role: 'user', content: trimmedTranscription });
            interviewState.lastActivity = Date.now();
            // 3. Trigger the next step (HTTP request to /continue-interview)
            await triggerInterviewContinuation(callSid); // This function now handles the delay
        } catch (error) {
            console.error(`[${callSid}] Error processing speech segment:`, error);
            if (!Array.isArray(interviewState.history)) interviewState.history = [];
            interviewState.history.push({ role: 'system', content: `Error processing user audio: ${error.message}` });
             try {
                 // Still attempt to trigger continuation, which might say an error message
                 await triggerInterviewContinuation(callSid);
             } catch (triggerError) {
                  console.error(`[${callSid}] Failed to trigger continuation after speech processing error:`, triggerError);
                  try { await client.calls(callSid).update({ status: 'completed' }); } catch (e) { /* ignore */ }
                  isActive = false; ws.close();
             }
        } finally {
             // Processing flag is cleared after triggerInterviewContinuation finishes (including its delay)
             // vadState.isProcessing = false; // Moved to after setTimeout in trigger function
             // isWaitingForAi flag is also cleared after delay in trigger function
             // VAD state reset is also moved to after delay in trigger function
        }
    }

    // --- MODIFIED: triggerInterviewContinuation with delay ---
    async function triggerInterviewContinuation(targetCallSid) {
        if (!isActive || !targetCallSid) return;
        const currentState = interviews.get(targetCallSid);
        if (!currentState || currentState.phase === 'ending' || currentState.phase === 'scored') return;

        console.log(`[${targetCallSid}] Triggering /continue-interview endpoint.`);
        let backendUrl = process.env.BACKEND_URL;
        if (!backendUrl) { /* ... handle missing URL ... */ return; }
        if (!backendUrl.startsWith('http')) backendUrl = `https://${backendUrl}`;
        if (backendUrl.endsWith('/')) backendUrl = backendUrl.slice(0, -1);
        const continueUrl = `${backendUrl}/continue-interview/${targetCallSid}`;

        try {
             await axios.post(continueUrl, {}, { timeout: 10000 });
             console.log(`[${targetCallSid}] Successfully triggered POST to ${continueUrl}. Waiting ${TTS_PLAYBACK_DELAY_MS}ms before resuming VAD.`);

             // --- Synchronization Delay ---
             // Wait AFTER the HTTP request completes successfully before resuming VAD
             setTimeout(() => {
                if (isActive && interviewState) { // Check if WS/call still active
                    console.log(`[${targetCallSid}] Delay finished. Resuming VAD.`);
                    interviewState.isWaitingForAi = false; // RESUME VAD
                    vadState.isProcessing = false;        // Clear processing flag
                    resetVadForNextUtterance();           // Reset VAD buffers for next input
                } else {
                     console.log(`[${targetCallSid}] Delay finished, but WS/call inactive. VAD not resumed.`);
                }
            }, TTS_PLAYBACK_DELAY_MS);
            // --- End Synchronization Delay ---

         } catch (error) {
              console.error(`[${targetCallSid}] Error triggering POST to ${continueUrl}:`, error.response ? `${error.response.status}` : error.message);
               // If trigger fails, we should still allow VAD to resume listening after resetting state
               vadState.isProcessing = false; // Clear processing flag
               interviewState.isWaitingForAi = false; // Ensure VAD can resume
               resetVadForNextUtterance();
               // Optionally attempt hangup here if trigger failed critically
               try {
                   const errorTwiml = new twilio.twiml.VoiceResponse(); errorTwiml.say("A system error occurred."); errorTwiml.hangup();
                   await client.calls(targetCallSid).update({ twiml: errorTwiml.toString() });
               } catch(e) { /* Ignore hangup error */ }
               isActive = false; ws.close(); // Close WS on trigger error
         }
    }

    ws.on('error', (error) => { console.error(`>>> WebSocket Error (CallSid ${callSid || 'Unknown'}):`, error); isActive = false; if (callSid) { interviews.delete(callSid); } });
    ws.on('close', (code, reason) => { isActive = false; console.log(`>>> WebSocket closed. Code: ${code}, Reason: ${reason?.toString() || 'N/A'}, CallSid: ${callSid || 'Unknown'}`); });

    ws.on('message', async (message) => {
        if (!isActive) return;
        let msg; try { msg = JSON.parse(message); } catch (err) { return; }

        switch (msg.event) {
            case 'connected': break;
            case 'start':
                callSid = msg.start.callSid; streamSid = msg.start.streamSid;
                if (!callSid) { console.error("[WS] Error: callSid missing in 'start'. Closing."); isActive = false; ws.close(); return; }
                interviewState = interviews.get(callSid);
                if (!interviewState) { console.error(`[${callSid}] Error: State not found for WS. Closing.`); isActive = false; ws.close(); return; }
                interviewState.streamSid = streamSid; interviewState.lastActivity = Date.now();
                console.log(`[${callSid}] WebSocket stream started.`);
                // Initialize VAD state specifically for this connection
                vadState = initializeVadState();
                // Initially, AI has spoken (greeting), so wait before listening
                interviewState.isWaitingForAi = true; // Start in waiting state
                 // Start timeout matching the initial TwiML <Play> playback approximation
                 setTimeout(() => {
                     if(isActive && interviewState) {
                          console.log(`[${callSid}] Initial delay finished after greeting. Enabling VAD.`);
                          interviewState.isWaitingForAi = false; // Enable VAD listening
                          resetVadForNextUtterance(); // Ensure clean start
                     }
                 }, TTS_PLAYBACK_DELAY_MS); // Use the same delay
                break;

            case 'media':
                // --- MODIFIED: Check isWaitingForAi flag ---
                if (!callSid || !streamSid || !interviewState || vadState.isProcessing || interviewState.isWaitingForAi) {
                    return; // Ignore media if not ready, processing, or waiting for AI
                }
                // --- End Modification ---

                const mulawChunk = Buffer.from(msg.media.payload, 'base64'); if (mulawChunk.length === 0) return;
                 try {
                    // --- VAD Logic (Keep internal logic as provided) ---
                    const pcm8kS16Chunk = pcmConvert(mulawChunk, { from: 'mulaw u8', to: 'pcm s16 le', rate: SAMPLE_RATE }); vadState.pcmBuffer = Buffer.concat([vadState.pcmBuffer, pcm8kS16Chunk]);
                    while (vadState.pcmBuffer.length >= BYTES_PER_PCM16_FRAME) {
                        // Check flags again inside loop
                        if (!isActive || vadState.isProcessing || interviewState.isWaitingForAi) break;

                        const frameBuffer = vadState.pcmBuffer.slice(0, BYTES_PER_PCM16_FRAME); const correspondingMulawChunk = mulawChunk.slice(0, frameBuffer.length / 2); vadState.pcmBuffer = vadState.pcmBuffer.slice(BYTES_PER_PCM16_FRAME);
                        vadState.totalSamplesProcessed += FRAME_SIZE; const currentTime = vadState.totalSamplesProcessed / SAMPLE_RATE; vadState.frameCounter++;
                        let energy = 0; const frameInt16Array = new Int16Array(frameBuffer.buffer, frameBuffer.byteOffset, frameBuffer.length / 2); for (let j = 0; j < frameInt16Array.length; j++) { energy += (frameInt16Array[j] / 32768.0) ** 2; } energy = Math.max(MIN_ENERGY, energy / frameInt16Array.length);
                        if (!vadState.isInitialized) { /* ... VAD Init ... */ if (vadState.frameCounter <= INITIAL_NOISE_FRAMES) { if (energy < MAX_REASONABLE_INIT_ENERGY) { vadState.noiseEnergySum += energy; vadState.validFramesCount++; } if (vadState.frameCounter === INITIAL_NOISE_FRAMES) { vadState.noiseEnergyAvg = vadState.validFramesCount > 0 ? vadState.noiseEnergySum / vadState.validFramesCount : MIN_ENERGY; vadState.noiseEnergyAvg = Math.max(MIN_ENERGY, vadState.noiseEnergyAvg); vadState.speechEnergyAvg = vadState.noiseEnergyAvg * (RELATIVE_RISE_FACTOR * 1.5); vadState.isInitialized = true; } continue; } else { vadState.noiseEnergyAvg = MIN_ENERGY; vadState.speechEnergyAvg = vadState.noiseEnergyAvg * (RELATIVE_RISE_FACTOR * 1.5); vadState.isInitialized = true; console.warn(`[${callSid}] WARN: VAD Init fallback.`); } }
                         let currentSilenceThresholdValue = vadState.speechEnergyAvg * 0.25; let isFramePotentiallySilent = currentSilenceThresholdValue >= SILENCE_THRESHOLD_VALUE; let potentialSpeech = energy > vadState.noiseEnergyAvg * RELATIVE_RISE_FACTOR;
                         if (vadState.isSpeaking) { // Speaking State
                             vadState.accumulatedSpeechBuffer = Buffer.concat([vadState.accumulatedSpeechBuffer, correspondingMulawChunk]); if (!isFramePotentiallySilent) { vadState.speechEnergyAvg = (SMOOTHING_ALPHA * energy) + ((1 - SMOOTHING_ALPHA) * vadState.speechEnergyAvg); } if (isFramePotentiallySilent) { vadState.silenceFrameCounter++; } else { vadState.silenceFrameCounter = 0; }
                             if (vadState.silenceFrameCounter >= SILENCE_DURATION_FRAMES) { vadState.isSpeaking = false; vadState.speechStartTime = null; vadState.silenceFrameCounter = 0; processDetectedSpeech(); break; }
                         } else { // Not Speaking State
                             vadState.noiseEnergyAvg = (SMOOTHING_ALPHA * energy) + ((1 - SMOOTHING_ALPHA) * vadState.noiseEnergyAvg); vadState.noiseEnergyAvg = Math.max(MIN_ENERGY, vadState.noiseEnergyAvg);
                             if (potentialSpeech) { vadState.isSpeaking = true; vadState.speechStartTime = currentTime; vadState.silenceFrameCounter = 0; vadState.speechEnergyAvg = Math.max(energy, vadState.speechEnergyAvg, vadState.noiseEnergyAvg * RELATIVE_RISE_FACTOR); vadState.accumulatedSpeechBuffer = Buffer.concat([vadState.accumulatedSpeechBuffer, correspondingMulawChunk]); }
                         }
                    }
                    // --- End VAD Logic ---
                 } catch(pipelineError) { console.error(`[${callSid}] Error during VAD/media pipeline:`, pipelineError); vadState.pcmBuffer = Buffer.alloc(0); resetVadForNextUtterance(); }
                break;
            case 'stop': console.log(`[${callSid}] WebSocket Event: stop.`); isActive = false; if (vadState.isSpeaking && vadState.accumulatedSpeechBuffer.length > 0) { await processDetectedSpeech(); } vadState = initializeVadState(); callSid = null; streamSid = null; interviewState = null; break;
            case 'mark': break;
            case 'error': console.error(`[${callSid}] WebSocket Twilio Error Event:`, msg.error); isActive = false; ws.close(); break;
            default: break;
        }
    });
});

// --- call-status Endpoint (Keep as is) ---
app.post('/call-status', async (req, res) => {
    // ... (Existing call-status logic remains unchanged) ...
    const { CallSid, CallStatus, CallDuration, ErrorCode, ErrorMessage } = req.body;
    console.log(`[${CallSid}] Call Status: ${CallStatus}, Duration: ${CallDuration}s`);
    if (ErrorCode && ErrorCode !== '0' && ErrorCode !== '11200') { console.error(`[${CallSid}] Call Error Code: ${ErrorCode} - ${ErrorMessage || 'No message'}`); }
    const state = interviews.get(CallSid);
    try {
        const terminalStatuses = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];
        if (terminalStatuses.includes(CallStatus)) {
            if (state) {
                if (state.phase !== 'scored') { console.log(`[${CallSid}] Triggering endInterview due to terminal status.`); await endInterview(CallSid, CallStatus); }
                else { interviews.delete(CallSid); }
            } else { console.warn(`[${CallSid}] No interview state found on terminal status ${CallStatus}. Cannot score.`); }
            // TTS File Cleanup
            const audioPattern = new RegExp(`^tts_${CallSid}_\\d+\\.wav$`);
            fs.readdir(audioDir, (err, files) => { if (!err) files.forEach(file => { if (audioPattern.test(file)) fs.unlink(path.join(audioDir, file), (e)=>{/*ignore*/}); }); });
        } else { if (state) { state.lastActivity = Date.now(); } }
    } catch (error) { console.error(`[${CallSid}] Status handler failed for status ${CallStatus}:`, error); }
    finally { res.status(200).send(); }
});


// --- endInterview Function (Keep as is) ---
async function endInterview(callSid, finalCallStatus = 'unknown') {
     const state = interviews.get(callSid);
     if (!state) { interviews.delete(callSid); return; }
     if(state.phase === 'scored') { return; }
     console.log(`[${callSid}] Ending interview. Final Call Status: ${finalCallStatus}, Last Phase: ${state.phase}.`);
     const previousPhase = state.phase; state.phase = 'scored'; state.lastActivity = Date.now();
     let scoreResult = null; let dbStatus = 'completed'; let justification = ""; let transcriptContent = 'No transcript available';
     try {
         if (!Array.isArray(state.history)) state.history = [];
         const hasMeaningfulHistory = state.history.some(entry => entry.role === 'user' && entry.content?.trim());
         transcriptContent = state.history.map(entry => `${entry.role}: ${entry.content}`).join('\n\n') || 'No transcript available';
         // Determine base status/justification based on call status and history
         if (['failed', 'canceled', 'no-answer', 'busy'].includes(finalCallStatus)) { dbStatus = finalCallStatus; justification = `Call ended with status: ${finalCallStatus}.`; if (!hasMeaningfulHistory) justification += " No meaningful interaction."; scoreResult = { /*...*/ }; }
         else if (!hasMeaningfulHistory && finalCallStatus === 'completed') { dbStatus = 'incomplete'; justification = "Interview completed but no meaningful responses."; scoreResult = { /*...*/ }; }
         else if (finalCallStatus === 'completed' && hasMeaningfulHistory) {
              console.log(`[${callSid}] Generating final score...`);
              try { /* Call scoring, parse result robustly */
                  const rawScoreString = await Promise.race([ generateFinalScore(state.history, state.jobRole, state.jobDescription), new Promise((_, reject) => setTimeout(() => reject(new Error('Scoring timeout')), 25000)) ]);
                  try { scoreResult = JSON.parse(rawScoreString); if (typeof scoreResult.technicalScore !== 'number' /*...*/) throw new Error("Invalid score format"); dbStatus = scoreResult.completionStatus || 'completed'; justification = scoreResult.justification || "Scoring complete."; console.log(`[${callSid}] Scoring successful.`); }
                  catch (parseError) { console.error(`[${callSid}] Failed to parse scoring JSON: ${parseError}. Raw: ${rawScoreString}`); dbStatus = 'error'; justification = "Scoring eval invalid format."; scoreResult = { /*...*/ }; }
              } catch (scoringError) { console.error(`[${callSid}] Scoring failed/timeout:`, scoringError); dbStatus = 'error'; justification = `Scoring failed: ${scoringError.message}`; scoreResult = { /*...*/ }; }
         } else { dbStatus = finalCallStatus === 'completed' ? 'incomplete' : (finalCallStatus || 'unknown'); justification = `Call ended status: ${dbStatus}.`; if (!hasMeaningfulHistory) justification += " No interaction."; scoreResult = { /*...*/ }; }

         // Database Update
         let attempts = 0; let updated = false;
         while (attempts < 3 && !updated) { attempts++; try { /* Simplified DB update logic */ const updatePayload = { /*...*/ }; const updateResult = await ScheduledCall.updateOne({ email: state.email, 'candidates.phone': state.candidatePhone }, { $set: updatePayload }); if (updateResult.acknowledged && updateResult.matchedCount > 0) { console.log(`[${callSid}] Successfully updated DB.`); updated = true; } else if (updateResult.matchedCount === 0) { console.warn(`[${callSid}] DB update no match. Attempt ${attempts}.`); break; } else { console.warn(`[${callSid}] DB update failed. Attempt ${attempts}.`); await new Promise(r => setTimeout(r, 1000*attempts)); } } catch (dbError) { console.error(`[${callSid}] DB update attempt ${attempts} error:`, dbError); if (attempts >= 3) console.error(`[${callSid}] Failed DB update.`); else await new Promise(r => setTimeout(r, 1000*attempts)); } }
         if (!updated) { console.error(`[${callSid}] CRITICAL: Failed DB update.`); }
     } catch (error) { console.error(`[${callSid}] CRITICAL: endInterview process error -`, error.message, error.stack); }
     finally { interviews.delete(callSid); }
}

app.get("/scheduled-calls", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) { return res.status(400).json({ error: "Email query parameter is required." }); }
    const calls = await ScheduledCall.find({ email }).sort({ scheduledTime: -1 });

    const response = calls.map(call => ({
      _id: call._id, // Include schedule ID
      jobRole: call.jobRole,
      jobDescription: call.jobDescription,
      scheduledTime: call.scheduledTime,
      status: call.status, // Overall schedule status
      email: call.email,
      candidates: call.candidates.map(candidate => ({
        _id: candidate._id, // Include candidate subdocument ID
        name: candidate.name, // Include name
        phone: candidate.phone,
        technicalScore: candidate.technicalScore ?? null,
        communicationScore: candidate.communicationScore ?? null,
        scoreJustification: candidate.scoreJustification ?? null,
        scoreBreakdown: candidate.scoreBreakdown ?? [],
        completionStatus: candidate.completionStatus || 'scheduled',
        status: candidate.status || 'scheduled',
        transcript: candidate.transcript,
        startedAt: candidate.startedAt || null,
        endedAt: candidate.endedAt || null,
      }))
    }));

    res.json(response);
  } catch (error) {
    console.error("Error fetching scheduled calls:", error);
    res.status(500).json({ error: "Failed to fetch scheduled calls" });
  }
});


// Handle preflight requests for CORS
app.options('*', cors());

// Start the server using the http server instance (for WebSocket compatibility)
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  let backendUrl = process.env.BACKEND_URL;
   if (backendUrl && !backendUrl.startsWith('http')) { backendUrl = `https://${backendUrl}`; }
   if(backendUrl) {
    //    console.log(`Twilio should POST call status to: ${backendUrl}/call-status`);
    //    console.log(`Twilio should POST initial call TwiML to: ${backendUrl}/voice`);
    //    console.log(`WebSocket server expects connections at: ${backendUrl.replace(/^http/, 'ws')}`);
   } else { console.error("Warning: BACKEND_URL environment variable not set."); }
});

// Graceful Shutdown Handling
const gracefulShutdown = (signal) => {
  server.close(() => {
    console.log('HTTP server closed.');
    wss.close(() => { console.log('WebSocket server closed.'); });
    mongoose.connection.close(false).then(() => { // Removed deprecated 'false' argument if using Mongoose >= 7
        process.exit(0);
    }).catch(err => {
        console.error('Error closing MongoDB connection:', err);
        process.exit(1);
    });
    setTimeout(() => { console.error("Graceful shutdown timed out. Forcing exit."); process.exit(1); }, 10000);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));


process.on('uncaughtException', (err, origin) => {
  console.error(`\n\n----- UNCAUGHT EXCEPTION -----`);
  console.error(`Origin: ${origin}`);
  console.error(err);
  console.error(`----- END UNCAUGHT EXCEPTION -----\n\n`);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error(`\n\n----- UNHANDLED REJECTION -----`);
  console.error('Reason:', reason);
  console.error(`----- END UNHANDLED REJECTION -----\n\n`);
});