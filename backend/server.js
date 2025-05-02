const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const pcmConvert = require('pcm-convert');
const fs = require('fs');
const connectDB = require('./db'); // Assuming db.js handles mongoose connection
const mongoose = require('mongoose'); // Import mongoose for graceful shutdown
const passport = require('./config/passportConfig');
const authRoutes = require('./routes/authRoutes');
const cors = require('cors');
const User = require("./models/user");
const interviews = new Map();
const webCallRouter = require('./WebCall');
const ScheduledCall = require("./models/ScheduledCall");
const nodemailer = require('nodemailer');
require('dotenv').config();
const { getAiResponse, transcribeBuffer, generateFinalScore, getQnAResponse } = require('./interview'); // Updated import
const { convertAudio } = require('./audioProcessor'); // Import conversion function
const path = require('path');
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
app.use('/api/web-call', webCallRouter);
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

app.post("/make-call", async (req, res) => {
  const { jobRole, jobDescription, candidates, email } = req.body;

  try {
    if (!jobRole || !jobDescription || !candidates || !Array.isArray(candidates)) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (email) {
      const user = await User.findOneAndUpdate(
        { email },
        {
          $inc: {
            usedCalls: candidates.length,
            totalCallsTillDate: candidates.length
          }
        },
        { new: true }
      );

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (user.usedCalls > user.totalCalls) {
        // Revert the increment if call limit exceeded before making calls
        await User.findOneAndUpdate(
           { email },
           { $inc: { usedCalls: -candidates.length, totalCallsTillDate: -candidates.length } }
        );
        return res.status(400).json({ error: "Call limit exceeded" });
      }
    }

    const results = [];
    // Ensure BACKEND_URL has a scheme (https preferably)
    let backendUrl = process.env.BACKEND_URL;
    if (!backendUrl) {
         console.error("FATAL ERROR: BACKEND_URL environment variable is not set.");
         return res.status(500).json({ error: "Server configuration error: Missing BACKEND_URL."});
    }
     if (!backendUrl.startsWith('http://') && !backendUrl.startsWith('https://')) {
         console.warn(`Warning: BACKEND_URL ('${backendUrl}') is missing scheme. Prepending 'https://'.`);
         backendUrl = `https://${backendUrl}`;
     } else if (backendUrl.startsWith('http://')) {
         console.warn("Warning: BACKEND_URL starts with http://. Consider using https:// for security.");
     }


    for (const candidate of candidates) {
        // Basic validation for candidate structure within the loop
        if (!candidate || typeof candidate.phone !== 'string' || candidate.phone.trim() === '' || typeof candidate.name !== 'string' || candidate.name.trim() === '') {
            console.warn(`Skipping candidate due to missing or invalid name/phone:`, candidate);
            results.push({
                success: false,
                phone: candidate?.phone || 'N/A',
                error: "Invalid candidate data (missing name or phone)"
            });
            // Decrement usage count if a candidate is skipped due to invalid data AFTER initial check
            if (email) {
                 await User.findOneAndUpdate(
                     { email },
                     { $inc: { usedCalls: -1, totalCallsTillDate: -1 } }
                 ).catch(err => console.error("Error reverting usage count for skipped candidate:", err));
             }
            continue; // Skip to the next candidate
        }

      try {
        console.log(`Initiating call to ${candidate.name} at ${candidate.phone}`);

        const call = await client.calls.create({
          to: candidate.phone,
          from: process.env.TWILIO_PHONE_NUMBER,
           url: `${backendUrl}/voice?jobRole=${encodeURIComponent(jobRole)}&jobDescription=${encodeURIComponent(jobDescription)}&callSid=\${CallSid}`, // Use CallSid placeholder
          statusCallback: `${backendUrl}/call-status`,
          statusCallbackEvent: ['completed', 'failed', 'busy', 'no-answer', 'canceled'], // Added canceled
          statusCallbackMethod: 'POST'
        });

        console.log(`[${call.sid}] Call initiated for ${candidate.name}. Storing initial state.`);
        interviews.set(call.sid, {
          jobRole,
          jobDescription,
          history: [],
          phase: 'introduction', // Initial phase before first TwiML executes
          candidatePhone: candidate.phone,
          candidateName: candidate.name, // Store candidate name
          lastActivity: Date.now(),
          email, // Store email for later reference
          currentAudioBuffer: Buffer.alloc(0), // Buffer for WebSocket audio (might not be needed if VAD state handles it)
          vadState: null, // To store VAD state per call - initialized in WebSocket 'start'
          callSid: call.sid, // Store callSid explicitly
          streamSid: null, // Will be set in WebSocket 'start'
          startTime: new Date() // Record start time
        });

        results.push({
          success: true,
          callSid: call.sid,
          phone: candidate.phone,
          name: candidate.name
        });
      } catch (error) {
        console.error(`Failed to call ${candidate.name} (${candidate.phone}):`, error);
        // If a call fails to initiate, potentially decrement the usage count if applicable
        if (email) {
            await User.findOneAndUpdate(
                { email },
                { $inc: { usedCalls: -1, totalCallsTillDate: -1 } } // Decrement for the failed call
            ).catch(err => console.error("Error reverting usage count for failed call:", err));
        }
        results.push({
          success: false,
          phone: candidate.phone,
          name: candidate.name,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      results,
      message: `Initiated ${results.filter(r => r.success).length} of ${candidates.length} valid calls`
    });

  } catch (error) {
    console.error("Call processing error:", error);
    res.status(500).json({
      error: "Call processing failed",
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
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


// Initial TwiML: Say greeting and connect stream
app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid;
  const jobRole = req.query.jobRole;
  const jobDescription = req.query.jobDescription;

   if (!callSid) {
      console.error("'/voice' endpoint called without CallSid.");
       res.status(400).send("CallSid is required.");
       return;
   }
    if (!jobRole || !jobDescription) {
        console.error(`[${callSid}] '/voice' called without jobRole or jobDescription query parameters.`);
        const twimlErr = new twilio.twiml.VoiceResponse();
        twimlErr.say("There was a configuration error with this call. Please contact support.");
        twimlErr.hangup();
        res.type('text/xml').send(twimlErr.toString());
        return;
    }

   // Retrieve the interview state early
    const state = interviews.get(callSid);
    if (!state) {
        // This can happen if the /make-call succeeded but the state wasn't set correctly/fast enough, or if Twilio calls /voice unexpectedly.
        console.error(`[${callSid}] State not found in /voice. CallSid might be unexpected or state setting failed in /make-call.`);
        const twimlErr = new twilio.twiml.VoiceResponse();
        twimlErr.say("There was an internal error initializing the interview session. Please try again later. Goodbye.");
        twimlErr.hangup();
        res.type('text/xml').send(twimlErr.toString());
        return;
    }
    // Update state with job details if somehow missed (should be redundant)
    state.jobRole = state.jobRole || jobRole;
    state.jobDescription = state.jobDescription || jobDescription;


  // Determine WebSocket URL
  let backendUrl = process.env.BACKEND_URL;
  if (!backendUrl) {
     console.error(`[${callSid}] FATAL ERROR: BACKEND_URL environment variable is not set.`);
     const twimlErr = new twilio.twiml.VoiceResponse();
     twimlErr.say("Server configuration error. Cannot connect audio stream.");
     twimlErr.hangup();
     res.type('text/xml').send(twimlErr.toString());
     return;
   }
   if (!backendUrl.startsWith('http://') && !backendUrl.startsWith('https://')) {
     backendUrl = `https://${backendUrl}`;
   }
  const websocketUrl = backendUrl.replace(/^http/, 'ws');

  const twiml = new twilio.twiml.VoiceResponse();

  const greeting = `Hello, this is Moon, your AI interviewer from [Your Company Name, if applicable] for the ${jobRole} role. Today, I'll ask a few questions to understand your technical and communication skills. Let's begin. Can you please start by introducing yourself?`;
  console.log(`[${callSid}] AI (Intro - Candidate: ${state.candidateName}): ${greeting}`);
  state.history.push({ role: 'assistant', content: greeting }); // Log initial greeting

  twiml.say(
    {
      voice: 'Polly.Aditi', // Consider making voice configurable
      language: 'en-IN'
    },
    greeting
  );

  console.log(`[${callSid}] Connecting to WebSocket: ${websocketUrl}`);
  const connect = twiml.connect();
  connect.stream({
       url: websocketUrl,
       track: 'inbound_track' // Only stream candidate's audio
       // Parameters like callSid are usually sent automatically by Twilio Streams
  });

  // Pause to wait for user speech / WebSocket actions
  twiml.pause({ length: 60 }); // Wait up to 60 seconds for the VAD/WebSocket to drive the next step

  console.log(`[${callSid}] Sent initial TwiML with <Stream> and <Pause length="60">.`);
  res.type('text/xml').send(twiml.toString());
});


// Endpoint to provide subsequent TwiML instructions (next question, hangup, etc.)
app.post('/continue-interview/:callSid', async (req, res) => {
    const callSid = req.params.callSid;
    const state = interviews.get(callSid);
    const twiml = new twilio.twiml.VoiceResponse();

    if (!state) {
        console.error(`[${callSid}] /continue-interview called, but state not found. Hanging up.`);
        twiml.say("An error occurred during the interview session. Goodbye.");
        twiml.hangup();
        return res.type('text/xml').send(twiml.toString());
    }

    // Prevent processing if call is already ending/scored
     if (state.phase === 'ending' || state.phase === 'scored') {
         console.warn(`[${callSid}] /continue-interview called during or after termination (phase: ${state.phase}). Sending Hangup.`);
         twiml.hangup(); // Ensure hangup if somehow triggered late
         return res.type('text/xml').send(twiml.toString());
     }


    console.log(`[${callSid}] Continuing interview, current phase: ${state.phase}`);

    try {
        let aiResponse = "";
        let nextPhase = state.phase; // Start with current phase
        let pauseDuration = 60; // Default pause length while waiting for user response

        switch (state.phase) {
            case 'introduction': // After user intro -> Ask Q1
                aiResponse = await getAiResponse("Ask the first technical question, considering the user's introduction if relevant.", state.jobRole, state.jobDescription, false, state.history);
                nextPhase = 'question1';
                break;
            case 'question1': // After user answer 1 -> Ask Q2
                aiResponse = await getAiResponse("Ask the second technical question, considering the previous question and answer.", state.jobRole, state.jobDescription, false, state.history);
                nextPhase = 'question2';
                break;
            case 'question2': // After user answer 2 -> Ask if user has questions
                aiResponse = "Thank you for answering my questions. Now, do you have any questions for me about the role or the company? Feel free to ask, or you can say 'no questions'.";
                nextPhase = 'qna_listen'; // Listen for user's question or lack thereof
                break;
            case 'qna_listen': // After potentially hearing user question -> Respond or end
                 const lastUserMessage = state.history[state.history.length - 1];
                 const hasQuestion = lastUserMessage &&
                                    lastUserMessage.role === 'user' &&
                                    lastUserMessage.content.trim() !== "" &&
                                    !/^(no|nope|no questions?|nothing|i'm good|i am good)$/i.test(lastUserMessage.content.trim());

                 if (hasQuestion) {
                     console.log(`[${callSid}] Generating QnA response for: "${lastUserMessage.content}"`);
                     const qnaAnswer = await Promise.race([
                         getQnAResponse(lastUserMessage.content, state.history.slice(0, -1)),
                         new Promise((resolve) => setTimeout(() => resolve("That's a good question. While I don't have the specific details right now, I'll make sure to pass it along to the team."), 8000)) // 8s timeout
                     ]);
                     aiResponse = `${qnaAnswer} Was there anything else you wanted to ask?`;
                     nextPhase = 'qna_followup'; // Allow for another question or end
                 } else {
                     console.log(`[${callSid}] No user question detected or user indicated no questions. Ending interview.`);
                     aiResponse = "Okay, thank you for confirming. This concludes our initial interview. We appreciate your time today and will be in touch regarding the next steps. Goodbye!";
                     nextPhase = 'ending'; // Trigger hangup
                 }
                 break;
             case 'qna_followup': // After answering a user question -> Check for more questions or end
                 const lastFollowupMessage = state.history[state.history.length - 1];
                 const hasFollowupQuestion = lastFollowupMessage &&
                                           lastFollowupMessage.role === 'user' &&
                                           lastFollowupMessage.content.trim() !== "" &&
                                           !/^(no|nope|no more|that's all|i'm good|i am good|that helps|thank you)$/i.test(lastFollowupMessage.content.trim()); // Added "thank you"

                 if (hasFollowupQuestion) {
                      console.log(`[${callSid}] Generating response for followup question: "${lastFollowupMessage.content}"`);
                      const followupAnswer = await Promise.race([
                          getQnAResponse(lastFollowupMessage.content, state.history.slice(0, -1)),
                          new Promise((resolve) => setTimeout(() => resolve("Thanks for the additional question. I've noted that one down as well."), 8000))
                      ]);
                      aiResponse = `${followupAnswer} Anything else?`;
                      nextPhase = 'qna_followup'; // Loop back to allow more questions
                 } else {
                      console.log(`[${callSid}] No further questions detected or user finished. Ending interview.`);
                      aiResponse = "Great. Thank you again for your time and interest! We'll be in touch soon. Have a great day. Goodbye!";
                      nextPhase = 'ending';
                 }
                 break;

            default:
                console.warn(`[${callSid}] Reached /continue-interview with unexpected phase: ${state.phase}. Ending call.`);
                aiResponse = "It seems we've reached the end or encountered an issue. Thank you for your time. Goodbye.";
                nextPhase = 'ending';
        }

        // Log AI response only if it's not empty
        if (aiResponse) {
             console.log(`[${callSid}] AI (${nextPhase}): ${aiResponse}`);
             state.history.push({ role: 'assistant', content: aiResponse });
             twiml.say(
                 {
                     voice: 'Polly.Aditi',
                     language: 'en-IN'
                 },
                 aiResponse
             );
        } else {
             console.log(`[${callSid}] Phase changed to ${nextPhase} without explicit AI response this turn.`);
        }

        state.phase = nextPhase;
        state.lastActivity = Date.now(); // Update activity timestamp


        if (state.phase === 'ending') {
            console.log(`[${callSid}] Phase is 'ending'. Sending <Hangup> TwiML.`);
            twiml.hangup();
        } else {
             // Keep the stream connected by sending a pause.
             console.log(`[${callSid}] Phase is '${state.phase}'. Waiting for next user response via WebSocket with Pause length ${pauseDuration}.`);
             twiml.pause({ length: pauseDuration }); // Keep listening
        }

    } catch (error) {
        console.error(`[${callSid}] Error in /continue-interview (Phase: ${state.phase}):`, error);
        twiml.say({ voice: 'Polly.Aditi', language: 'en-IN' }, "I encountered an internal error and cannot continue. Apologies for the inconvenience. Goodbye.");
        twiml.hangup();
        state.phase = 'ending'; // Mark as ending due to error
    }

    res.type('text/xml').send(twiml.toString());
});

// WebSocket Server Logic
wss.on('connection', (ws, req) => {
    console.log('>>> WebSocket connection established.');
    let callSid = null; // Determined on 'start' event
    let streamSid = null;
    let interviewState = null; // Reference to the entry in the 'interviews' map
    let isActive = true; // Flag to control processing loop


    // Initialize VAD state per connection
    let vadState = {
        pcmBuffer: Buffer.alloc(0),
        isSpeaking: false,
        silenceFrameCounter: 0,
        speechStartTime: null,
        frameCounter: 0,
        noiseEnergyAvg: 0.0,
        speechEnergyAvg: 0.0,
        isInitialized: false,
        noiseEnergySum: 0.0,
        validFramesCount: 0,
        accumulatedSpeechBuffer: Buffer.alloc(0), // Buffer for the current speech segment (µ-law)
        totalSamplesProcessed: 0,
        isProcessing: false // Flag to prevent concurrent processing
    };


    function resetVadState(clearAccumulated = true) {
         vadState.pcmBuffer = Buffer.alloc(0);
         vadState.isSpeaking = false;
         vadState.silenceFrameCounter = 0;
         vadState.speechStartTime = null;
         vadState.frameCounter = 0;
         // Don't reset noise/speech averages fully, maybe just nudge towards initial? Or keep adaptive.
         // vadState.noiseEnergyAvg = 0.0;
         // vadState.speechEnergyAvg = 0.0;
         vadState.isInitialized = vadState.isInitialized; // Keep initialization status
         vadState.noiseEnergySum = 0.0; // Reset sum used during init
         vadState.validFramesCount = 0; // Reset count used during init
         if (clearAccumulated) {
            vadState.accumulatedSpeechBuffer = Buffer.alloc(0); // Clear speech buffer too
         }
         vadState.totalSamplesProcessed = 0; // Reset sample count for the segment
         console.log(`[${callSid || 'WS Connection'}] VAD state reset for next utterance (Accumulated Cleared: ${clearAccumulated}, Initialized: ${vadState.isInitialized}).`);
    }

    async function processDetectedSpeech() {
        if (!isActive || !callSid || !interviewState) {
             console.log(`[${callSid}] Skipping speech processing (Inactive WS: ${!isActive}, No CallSid: ${!callSid}, No State: ${!interviewState})`);
             return;
        }
         if (vadState.isProcessing) {
             console.warn(`[${callSid}] Warning: processDetectedSpeech called while already processing. Skipping.`);
             return;
         }
         vadState.isProcessing = true; // Set processing flag


        const speechBuffer = Buffer.from(vadState.accumulatedSpeechBuffer); // Take a copy
        const bufferLength = speechBuffer.length;
        vadState.accumulatedSpeechBuffer = Buffer.alloc(0); // Clear the main accumulator


        if (bufferLength < (SAMPLE_RATE * 0.2 * 1)) { // Ignore very short segments (e.g., < 200ms, 1 byte/sample for ulaw)
             console.log(`[${callSid}] Ignoring very short detected audio segment (${bufferLength} bytes).`);
             resetVadState(true); // Reset VAD completely after handling silence/short segment
             vadState.isProcessing = false; // Clear processing flag
             return; // End processing for this segment
        }


        console.log(`[${callSid}] Processing ${bufferLength} bytes of speech...`);

        try {
            // 1. Convert u-law buffer to WAV buffer
            const wavBuffer = await convertAudio(speechBuffer);
            console.log(`[${callSid}] Audio converted to WAV (${wavBuffer.length} bytes).`);

            // 2. Transcribe WAV buffer
            const transcription = await Promise.race([
                 transcribeBuffer(wavBuffer, callSid),
                 new Promise((_, reject) => setTimeout(() => reject(new Error("Transcription timeout (15s)")), 15000))
             ]);
            const trimmedTranscription = transcription?.trim() ?? ""; // Trim and handle null/undefined
            console.log(`[${callSid}] Transcription: "${trimmedTranscription}"`);

             // Add transcription to history
             interviewState.history.push({ role: 'user', content: trimmedTranscription });
             interviewState.lastActivity = Date.now();


            // 3. Trigger the next step in the interview flow via HTTP request
            await triggerInterviewContinuation(callSid);


        } catch (error) {
            console.error(`[${callSid}] Error processing speech segment:`, error);
            // Log the error but try to continue the interview by prompting again
            interviewState.history.push({ role: 'system', content: `Error processing user audio: ${error.message}` });
             try {
                 // Trigger continuation, which might say an error message and re-pause
                 await triggerInterviewContinuation(callSid);
             } catch (triggerError) {
                  console.error(`[${callSid}] Failed to trigger continuation after speech processing error:`, triggerError);
                   try { await client.calls(callSid).update({ status: 'completed' }); } catch (hangupError) { console.error(`[${callSid}] Failed to hang up call after nested errors:`, hangupError); }
                   isActive = false; ws.close();
             }
        } finally {
             // Reset VAD state for the next utterance *after* processing is done or errored
             resetVadState(true); // Full reset including accumulated buffer (already cleared)
             vadState.isProcessing = false; // Clear processing flag
        }
    }

    // Function to trigger the /continue-interview endpoint
    async function triggerInterviewContinuation(targetCallSid) {
        if (!isActive || !targetCallSid) {
            console.log(`[${targetCallSid}] Skipping triggerInterviewContinuation (WS Inactive: ${!isActive}, No CallSid: ${!targetCallSid})`);
            return;
        }
        // Prevent triggering if interview state is already ending/scored
         const currentState = interviews.get(targetCallSid);
         if (!currentState || currentState.phase === 'ending' || currentState.phase === 'scored') {
             console.warn(`[${targetCallSid}] Skipping triggerInterviewContinuation as state is terminal (${currentState?.phase})`);
             return;
         }

        console.log(`[${targetCallSid}] Triggering /continue-interview endpoint.`);
        let backendUrl = process.env.BACKEND_URL;
        if (!backendUrl) {
             console.error(`[${targetCallSid}] Cannot trigger continue: BACKEND_URL not set.`);
             try { await client.calls(targetCallSid).update({status: 'completed'}); } catch(e){}
             isActive = false; ws.close();
             return;
        }
        if (!backendUrl.startsWith('http')) backendUrl = `https://${backendUrl}`;
        const continueUrl = `${backendUrl}/continue-interview/${targetCallSid}`;

        try {
             await axios.post(continueUrl, {}, { timeout: 10000 });
             console.log(`[${targetCallSid}] Successfully triggered POST to ${continueUrl}.`);
         } catch (error) {
              console.error(`[${targetCallSid}] Error triggering POST to ${continueUrl}:`, error.response ? `${error.response.status} ${error.response.statusText}` : error.message);
               try {
                   console.log(`[${targetCallSid}] Attempting hangup via API due to trigger failure.`);
                   const errorTwiml = new twilio.twiml.VoiceResponse();
                   errorTwiml.say("A system error occurred, ending the call. Goodbye.");
                   errorTwiml.hangup();
                   await client.calls(targetCallSid).update({ twiml: errorTwiml.toString() });
                   console.log(`[${targetCallSid}] Call hangup initiated via API.`);
               } catch(e) { console.error(`[${targetCallSid}] Failed to update call with hangup TwiML on trigger error:`, e)}
               isActive = false; ws.close();
         }
    }


    ws.on('error', (error) => {
        console.error(`>>> WebSocket Error for CallSid ${callSid || 'Unknown'}:`, error);
        isActive = false;
         if (callSid) { interviews.delete(callSid); }
    });

    ws.on('close', (code, reason) => {
        isActive = false;
        const reasonStr = reason ? reason.toString() : 'No reason given';
        console.log(`>>> WebSocket connection closed. Code: ${code}, Reason: ${reasonStr}, CallSid: ${callSid || 'Unknown'}`);
         // Don't delete interview state here - let call-status handle final cleanup
    });

    ws.on('message', async (message) => {
        if (!isActive) return;

        let msg;
        try { msg = JSON.parse(message); }
        catch (err) { console.error("Non-JSON message received:", message.toString()); return; }

        switch (msg.event) {
            case 'connected':
                console.log(`[${callSid || 'WS'}] WebSocket Event: connected`);
                break;
            case 'start':
                callSid = msg.start.callSid;
                streamSid = msg.start.streamSid;

                if (!callSid) { console.error("[WS] Error: callSid not found in 'start'. Closing.", msg.start); isActive = false; ws.close(); return; }

                interviewState = interviews.get(callSid);
                if (!interviewState) { console.error(`[${callSid}] Error: Interview state not found for WS connection. Closing.`); isActive = false; ws.close(); return; }

                interviewState.streamSid = streamSid;
                interviewState.lastActivity = Date.now();

                console.log(`[${callSid}] WebSocket stream started (StreamSid: ${streamSid}). Initializing VAD.`);
                resetVadState(true);
                vadState.isProcessing = false;
                break;

            case 'media':
                if (!callSid || !streamSid || !interviewState || vadState.isProcessing) return;

                const mulawChunk = Buffer.from(msg.media.payload, 'base64');
                if (mulawChunk.length === 0) return;

                 try {
                    const pcm8kS16Chunk = pcmConvert(mulawChunk, { from: 'mulaw u8', to: 'pcm s16 le', rate: SAMPLE_RATE });
                    vadState.pcmBuffer = Buffer.concat([vadState.pcmBuffer, pcm8kS16Chunk]);

                    while (vadState.pcmBuffer.length >= BYTES_PER_PCM16_FRAME) {
                        const frameBuffer = vadState.pcmBuffer.slice(0, BYTES_PER_PCM16_FRAME);
                        const correspondingMulawChunk = mulawChunk.slice(0, frameBuffer.length / 2); // Get corresponding µ-law part
                        vadState.pcmBuffer = vadState.pcmBuffer.slice(BYTES_PER_PCM16_FRAME);


                        vadState.totalSamplesProcessed += FRAME_SIZE;
                        const currentTime = vadState.totalSamplesProcessed / SAMPLE_RATE;
                        vadState.frameCounter++;

                        let energy = 0;
                        const frameInt16Array = new Int16Array(frameBuffer.buffer, frameBuffer.byteOffset, frameBuffer.length / 2);
                        for (let j = 0; j < frameInt16Array.length; j++) { energy += (frameInt16Array[j] / 32768.0) ** 2; }
                        energy = Math.max(MIN_ENERGY, energy / frameInt16Array.length);

                        // VAD Initialization
                        if (!vadState.isInitialized) {
                             if (vadState.frameCounter <= INITIAL_NOISE_FRAMES) {
                                 if (energy < MAX_REASONABLE_INIT_ENERGY) { vadState.noiseEnergySum += energy; vadState.validFramesCount++; }
                                 if (vadState.frameCounter === INITIAL_NOISE_FRAMES) {
                                     vadState.noiseEnergyAvg = vadState.validFramesCount > 0 ? vadState.noiseEnergySum / vadState.validFramesCount : MIN_ENERGY;
                                     vadState.noiseEnergyAvg = Math.max(MIN_ENERGY, vadState.noiseEnergyAvg);
                                     vadState.speechEnergyAvg = vadState.noiseEnergyAvg * (RELATIVE_RISE_FACTOR * 1.5);
                                     vadState.isInitialized = true;
                                     console.log(`[${callSid}] VAD Initialized. Noise Avg: ${vadState.noiseEnergyAvg.toExponential(3)}`);
                                 } continue;
                             } else {
                                 vadState.noiseEnergyAvg = MIN_ENERGY; vadState.speechEnergyAvg = vadState.noiseEnergyAvg * (RELATIVE_RISE_FACTOR * 1.5);
                                 vadState.isInitialized = true; console.warn(`[${callSid}] WARN: VAD Init fallback. Using MIN_ENERGY.`);
                             }
                         }

                         // VAD Decision
                         let currentSilenceThresholdValue = vadState.speechEnergyAvg * 0.25;
                         let isFramePotentiallySilent = currentSilenceThresholdValue >= SILENCE_THRESHOLD_VALUE;
                         let potentialSpeech = energy > vadState.noiseEnergyAvg * RELATIVE_RISE_FACTOR;

                         // Speaking State
                         if (vadState.isSpeaking) {
                             vadState.accumulatedSpeechBuffer = Buffer.concat([vadState.accumulatedSpeechBuffer, correspondingMulawChunk]);
                             if (!isFramePotentiallySilent) { vadState.speechEnergyAvg = (SMOOTHING_ALPHA * energy) + ((1 - SMOOTHING_ALPHA) * vadState.speechEnergyAvg); }
                             if (isFramePotentiallySilent) { vadState.silenceFrameCounter++; } else { vadState.silenceFrameCounter = 0; }

                             if (vadState.silenceFrameCounter >= SILENCE_DURATION_FRAMES) {
                                 console.log(`\n======= [${callSid}] Speech End (Silence Detected): ${currentTime.toFixed(3)}s =======\n`);
                                 vadState.isSpeaking = false; vadState.speechStartTime = null; vadState.silenceFrameCounter = 0;
                                 processDetectedSpeech(); // Async process
                                 break; // Stop processing frames for this chunk, segment is being handled
                             }
                         }
                         // Not Speaking State
                         else {
                             vadState.noiseEnergyAvg = (SMOOTHING_ALPHA * energy) + ((1 - SMOOTHING_ALPHA) * vadState.noiseEnergyAvg);
                             vadState.noiseEnergyAvg = Math.max(MIN_ENERGY, vadState.noiseEnergyAvg);

                             if (potentialSpeech) {
                                 console.log(`\n======= [${callSid}] Speech Start Detected: ${currentTime.toFixed(3)}s =======\n`);
                                 vadState.isSpeaking = true; vadState.speechStartTime = currentTime; vadState.silenceFrameCounter = 0;
                                 vadState.speechEnergyAvg = Math.max(energy, vadState.speechEnergyAvg, vadState.noiseEnergyAvg * RELATIVE_RISE_FACTOR);
                                 vadState.accumulatedSpeechBuffer = Buffer.concat([vadState.accumulatedSpeechBuffer, correspondingMulawChunk]);
                             }
                         }
                    } // End while loop
                 } catch(pipelineError) {
                    console.error(`[${callSid}] Error during VAD/media processing pipeline:`, pipelineError);
                    vadState.pcmBuffer = Buffer.alloc(0); resetVadState(true);
                 }
                break;

            case 'stop':
                console.log(`[${callSid}] WebSocket Event: stop - StreamSid: ${msg.stop?.streamSid}`);
                isActive = false;
                 if (vadState.isSpeaking && vadState.accumulatedSpeechBuffer.length > 0) {
                     console.log(`[${callSid}] Stream stopped during speech. Processing final segment.`);
                     await processDetectedSpeech();
                 }
                 resetVadState(true);
                 callSid = null; streamSid = null; interviewState = null;
                break;
            case 'mark':
                 console.log(`[${callSid}] WebSocket Event: Mark - Name: ${msg.mark?.name}`);
                 break;
            case 'error':
                 console.error(`[${callSid}] WebSocket Twilio Error Event:`, msg.error);
                 isActive = false; ws.close();
                 break;
            default:
                console.log(`[${callSid || 'WS'}] Received unknown WebSocket event type: ${msg.event}`);
                break;
        }
    });
});


app.post('/call-status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration, RecordingUrl, ErrorCode, ErrorMessage } = req.body;
  console.log(`[${CallSid}] Call Status Update: ${CallStatus}, Duration: ${CallDuration}s`);
   if (ErrorCode && ErrorCode !== '0') { // Twilio often sends ErrorCode 0 on normal hangup
       console.error(`[${CallSid}] Call Error: Code ${ErrorCode} - ${ErrorMessage || 'No message'}`);
   }

  const state = interviews.get(CallSid);

  try {
      const terminalStatuses = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];
      if (terminalStatuses.includes(CallStatus)) {
           console.log(`[${CallSid}] Call ended with terminal status: ${CallStatus}.`);
           if (state) {
                 if(state.phase !== 'scored') {
                      console.log(`[${CallSid}] Terminal status received. Triggering endInterview.`);
                      await endInterview(CallSid, CallStatus); // Pass status to scoring
                 } else {
                      console.log(`[${CallSid}] Terminal status received, but already scored. Final cleanup.`);
                       interviews.delete(CallSid);
                 }
           } else {
                console.warn(`[${CallSid}] No interview state found in memory on terminal call status ${CallStatus}. Cannot score or update DB accurately via this path.`);
                // If state is lost, we can't easily link back to the specific candidate record here.
                // The record in the DB might remain 'processing' or 'scheduled'. Needs investigation if this happens often.
           }
      } else {
             console.log(`[${CallSid}] Non-terminal status update: ${CallStatus}`);
             if (state) { state.lastActivity = Date.now(); }
      }
  } catch (error) {
    console.error(`[${CallSid}] Status handler failed for status ${CallStatus}:`, error);
  } finally {
    res.status(200).send(); // Always respond 200 OK to Twilio
  }
});

// Modified endInterview to accept final call status
async function endInterview(callSid, finalCallStatus = 'unknown') {
  const state = interviews.get(callSid);

  if (!state || state.phase === 'scored') {
    const reason = !state ? "No interview state found" : "Already scored";
    console.log(`[${callSid}] Skipping endInterview: ${reason}.`);
    if (!state) interviews.delete(callSid);
    return;
  }

   const previousPhase = state.phase;
   state.phase = 'scored';
   state.lastActivity = Date.now();

  console.log(`[${callSid}] Ending interview. Final Call Status: ${finalCallStatus}, Last Phase: ${previousPhase} | History entries: ${state.history?.length ?? 0}`);

  let scoreResult = null;
  let dbStatus = 'completed';
  let justification = "";

  try {
    const hasMeaningfulHistory = state.history && state.history.some(entry => entry.role === 'user' && entry.content?.trim());

    if (['failed', 'canceled', 'no-answer', 'busy'].includes(finalCallStatus)) {
         dbStatus = finalCallStatus;
         justification = `Call ended with status: ${finalCallStatus}.`;
         if (!hasMeaningfulHistory) justification += " No meaningful interaction recorded.";
         scoreResult = { technicalScore: 0, communicationScore: 0, justification: justification, completionStatus: dbStatus, breakdown: [] };
    } else if (!hasMeaningfulHistory && finalCallStatus === 'completed') { // Completed but no interaction
         dbStatus = 'incomplete';
         justification = "Interview completed but no meaningful user responses recorded.";
         scoreResult = { technicalScore: 0, communicationScore: 0, justification: justification, completionStatus: dbStatus, breakdown: [] };
    } else if (finalCallStatus === 'completed') { // Completed with interaction
         console.log(`[${callSid}] Generating final score...`);
         try {
             const rawScoreString = await Promise.race([
                 generateFinalScore(state.history, state.jobRole, state.jobDescription),
                 new Promise((_, reject) => setTimeout(() => reject(new Error('Scoring timeout after 25s')), 25000))
             ]);
             try {
                 scoreResult = JSON.parse(rawScoreString);
                  if (typeof scoreResult.technicalScore !== 'number' || typeof scoreResult.communicationScore !== 'number') { throw new Error("Parsed score missing numeric scores."); }
                 dbStatus = scoreResult.completionStatus || 'completed';
                 justification = scoreResult.justification || "Scoring complete.";
                 console.log(`[${callSid}] Scoring successful. Tech: ${scoreResult.technicalScore}, Comm: ${scoreResult.communicationScore}`);
             } catch (parseError) {
                 console.error(`[${callSid}] Failed to parse scoring JSON: ${parseError}. Raw: ${rawScoreString}`);
                 dbStatus = 'error'; justification = "Scoring evaluation returned invalid format.";
                 scoreResult = { technicalScore: 0, communicationScore: 0, justification: justification, completionStatus: dbStatus, breakdown: [] };
             }
         } catch (scoringError) {
             console.error(`[${callSid}] Scoring failed or timed out:`, scoringError);
             dbStatus = 'error'; justification = "Automatic scoring process failed or timed out.";
             scoreResult = { technicalScore: 0, communicationScore: 0, justification: justification, completionStatus: dbStatus, breakdown: [] };
         }
    } else {
         // Unknown final status, treat as potentially incomplete or error
         dbStatus = 'unknown';
         justification = `Call ended with unclear status: ${finalCallStatus}.`;
          if (!hasMeaningfulHistory) justification += " No meaningful interaction recorded.";
         scoreResult = { technicalScore: 0, communicationScore: 0, justification: justification, completionStatus: dbStatus, breakdown: [] };
    }

    // --- Database Update ---
    const updateData = {
      "candidates.$.technicalScore": scoreResult?.technicalScore ?? 0,
      "candidates.$.communicationScore": scoreResult?.communicationScore ?? 0,
      "candidates.$.scoreJustification": justification,
      "candidates.$.scoreBreakdown": scoreResult?.breakdown ?? [],
      "candidates.$.completionStatus": dbStatus,
      "candidates.$.transcript": state.history?.map(entry => `${entry.role}: ${entry.content}`).join('\n\n') || 'No transcript available',
      "candidates.$.status": dbStatus,
      "candidates.$.endedAt": new Date(),
      "candidates.$.startedAt": state.startTime || null, // Add startedAt if available
    };

    console.log(`[${callSid}] Attempting DB update for candidate: ${state.candidateName} (${state.candidatePhone}) with status: ${dbStatus}`);

    let attempts = 0;
    let updated = false;
    while (attempts < 3 && !updated) {
      attempts++;
      try {
           const scheduledCallRecord = await ScheduledCall.findOne({ email: state.email, "candidates.phone": state.candidatePhone });

          if (!scheduledCallRecord) {
              console.error(`[${callSid}] DB Update Error: Could not find scheduled call record for email ${state.email} and phone ${state.candidatePhone}. Attempt ${attempts}`);
              if (attempts === 1) { console.warn(`[${callSid}] Not retrying DB lookup after failing to find record.`); break; }
               await new Promise(resolve => setTimeout(resolve, 1500 * attempts)); continue;
          }

           const candidateIndex = scheduledCallRecord.candidates.findIndex(c => c.phone === state.candidatePhone);
           if (candidateIndex === -1) {
               console.error(`[${callSid}] DB Update Error: Candidate phone ${state.candidatePhone} not found within the matched scheduled call record ${scheduledCallRecord._id}.`);
               break;
           }

           const indexedUpdateData = {};
           for (const key in updateData) {
                const indexedKey = key.replace('$.', `${candidateIndex}.`);
                indexedUpdateData[`candidates.${indexedKey}`] = updateData[key];
           }

           const updateResult = await ScheduledCall.updateOne( { _id: scheduledCallRecord._id }, { $set: indexedUpdateData });

          if (updateResult.matchedCount > 0) { // Check matchedCount instead of modifiedCount
              console.log(`[${callSid}] Successfully updated DB record (Matched: ${updateResult.matchedCount}, Modified: ${updateResult.modifiedCount}).`);
              updated = true;
          } else {
              console.warn(`[${callSid}] DB update command executed but failed to match record. Attempt ${attempts}`);
               // This case shouldn't happen if findOne succeeded, but handle defensively
          }

      } catch (dbError) {
        console.error(`[${callSid}] DB update attempt ${attempts} failed:`, dbError);
        if (attempts >= 3) { console.error(`[${callSid}] Failed to save results after 3 attempts.`); }
        else { await new Promise(resolve => setTimeout(resolve, 1500 * attempts)); }
      }
    } // End while loop

    if (!updated) { console.error(`[${callSid}] CRITICAL: Failed to update database record for interview after all attempts.`); }

  } catch (error) {
    console.error(`[${callSid}] CRITICAL: Interview completion process failed -`, error.message, error.stack);
  } finally {
    interviews.delete(callSid); // Final cleanup of the in-memory state
    console.log(`[${callSid}] Interview state cleared from memory.`);
  }
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
      //  console.log(`Twilio should POST call status to: ${backendUrl}/call-status`);
      //  console.log(`Twilio should POST initial call TwiML to: ${backendUrl}/voice`);
      //  console.log(`WebSocket server expects connections at: ${backendUrl.replace(/^http/, 'ws')}`);
   } else { console.error("Warning: BACKEND_URL environment variable not set."); }
});

// Graceful Shutdown Handling
const gracefulShutdown = (signal) => {
  server.close(() => {
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