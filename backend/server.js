const express = require('express');
const twilio = require('twilio');
const connectDB = require('./db');
const passport = require('./config/passportConfig');
const authRoutes = require('./routes/authRoutes');
const cors = require('cors');
const User = require("./models/user");
const interviews = new Map();
const ScheduledCall = require("./models/ScheduledCall");
const nodemailer = require('nodemailer');
require('dotenv').config();
const { getAiResponse, transcribeRecording, generateFinalScore, getQnAResponse } = require('./interview');
const path = require('path');
const fs = require('fs');
const app = express();
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const axios = require('axios');
const allowedOrigins = [
  "http://localhost:3000",
  "https://moon-ai-one.vercel.app"
];

// Express Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Connect to MongoDB
connectDB();

// Initialize Passport
app.use(passport.initialize());

// Routes
app.use('/', authRoutes);

app.get('/', (req, res) => {
  res.send('Backend/Twilio server is running!');
});

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Handle call initiation
app.post("/make-call", async (req, res) => {
  const { jobRole, jobDescription, candidates, email } = req.body;

  try {
    // 1. Validate input
    if (!jobRole || !jobDescription || !candidates || !Array.isArray(candidates)) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 2. Update user's call counts
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
        return res.status(400).json({ error: "Call limit exceeded" });
      }
    }

    // 3. Initiate calls
    const results = [];
    for (const candidate of candidates) {
      try {
        console.log(`Initiating call to ${candidate.phone}`);

        const call = await client.calls.create({
          to: candidate.phone,
          from: process.env.TWILIO_PHONE_NUMBER,
          url: `https://${process.env.BACKEND_URL}/voice?jobRole=${encodeURIComponent(jobRole)}&jobDescription=${encodeURIComponent(jobDescription)}`,
          statusCallback: `https://${process.env.BACKEND_URL}/call-status`,
          statusCallbackEvent: ['completed', 'failed', 'busy', 'no-answer'],
          statusCallbackMethod: 'POST'
        });

        // Store call state
        interviews.set(call.sid, {
          jobRole,
          jobDescription,
          history: [],
          phase: 'introduction',
          candidatePhone: candidate.phone,
          lastActivity: Date.now(),
          email // Store email for later reference
        });

        results.push({
          success: true,
          callSid: call.sid,
          phone: candidate.phone
        });
      } catch (error) {
        console.error(`Failed to call ${candidate.phone}:`, error);
        results.push({
          success: false,
          phone: candidate.phone,
          error: error.message
        });
      }
    }

    // 4. Return results
    res.json({
      success: true,
      results,
      message: `Initiated ${results.filter(r => r.success).length} of ${candidates.length} calls`
    });

  } catch (error) {
    console.error("Call processing error:", error);
    res.status(500).json({
      error: "Call processing failed",
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});

// Add near the top with other requires
const cron = require('node-cron');

// Add this endpoint for scheduling calls
app.post('/schedule-call', async (req, res) => {
  try {
    const { email, jobRole, jobDescription, candidates, scheduledTime } = req.body;

    // Validate scheduled time is in the future
    if (new Date(scheduledTime) <= new Date()) {
      return res.status(400).json({ error: "Scheduled time must be in the future" });
    }

    const scheduledCall = new ScheduledCall({
      email,
      jobRole,
      jobDescription,
      candidates,
      scheduledTime,
      status: 'scheduled'
    });

    await scheduledCall.save();
    res.status(201).json(scheduledCall);

  } catch (error) {
    console.error("Error scheduling call:", error);
    res.status(500).json({ error: "Failed to schedule call" });
  }
});

// Add this background job to check for calls to initiate
cron.schedule('* * * * *', async () => { // Runs every minute
  try {
    const now = new Date();
    const callsToInitiate = await ScheduledCall.find({
      scheduledTime: { $lte: now },
      status: 'scheduled'
    }).limit(5); // Process 5 at a time

    for (const call of callsToInitiate) {
      try {
        // Update status to 'processing'
        await ScheduledCall.updateOne(
          { _id: call._id },
          { $set: { status: 'processing' } }
        );

        // Initiate the call
        const response = await axios.post(
          `http://localhost:5000/make-call`,
          {
            jobRole: call.jobRole,
            jobDescription: call.jobDescription,
            candidates: call.candidates,
            email: call.email
          }
        );

        // Update status to 'completed'
        await ScheduledCall.updateOne(
          { _id: call._id },
          { $set: { status: 'completed' } }
        );

      } catch (error) {
        console.error(`Failed to initiate scheduled call ${call._id}:`, error);
        await ScheduledCall.updateOne(
          { _id: call._id },
          { $set: { status: 'failed' } }
        );
      }
    }
  } catch (error) {
    console.error("Error in call initiation cron job:", error);
  }
});

// Initial voice handler
app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid;
  const jobRole = req.query.jobRole;
  const jobDescription = req.query.jobDescription;

  const twiml = new twilio.twiml.VoiceResponse();

  // Greet the user and ask for introduction
  const greeting = `Hello, My name is Moon. Your AI interviewer for the ${jobRole} role today. In this interview you will be judged on your technical and communication skills. Let's begin. Can you start by introducing yourself?`;
  console.log(`[${callSid}] AI: ${greeting}`);

  twiml.say(
    {
      voice: 'Polly.Aditi',
      language: 'en-IN'
    },
    greeting
  );
  twiml.play({ digits: '9' });

  // Record the user's introduction with 5 seconds of silence detection
  twiml.record({
    action: `/process-intro?callSid=${callSid}`,
    maxLength: 60,
    finishOnKey: '#',
    playBeep: true,
    timeout: 5
  });

  res.type('text/xml').send(twiml.toString());
});

// async function delay(ms) {
//   return new Promise(resolve => setTimeout(resolve, ms));
// }

app.post('/process-intro', async (req, res) => {
  const callSid = req.query.callSid;
  const recordingUrl = req.body.RecordingUrl;
  const state = interviews.get(callSid);
  if (req.body.Digits === '#') {
    console.log('User pressed # to end call');
    await endInterview(req.body.CallSid);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(
      {
        voice: 'Polly.Aditi',
        language: 'en-IN'
      },
      'Thank you for your time. Goodbye.'
    );

    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  if (!state) {
    return res.status(404).send('Call not found');
  }

  // Store recording URL in state
  state.recordingUrl = recordingUrl;
  state.phase = 'question1';

  // Transcribe and log the introduction
  try {
    const transcription = await transcribeRecording(recordingUrl, callSid);
    console.log(`[${callSid}] Transcription:\n${transcription}`);
    state.history.push({ role: 'user', content: transcription });
  } catch (error) {
    console.error(`[${callSid}] Error transcribing introduction:`, error);
  }

  const twiml = new twilio.twiml.VoiceResponse();

  // Get AI response for first question
  const aiResponse = await getAiResponse("Ask first technical question", state.jobRole, state.jobDescription);
  console.log(`[${callSid}] AI Question 1: ${aiResponse}`);
  state.history.push({ role: 'assistant', content: aiResponse });

  twiml.say(
    {
      voice: 'Polly.Aditi',
      language: 'en-IN'
    },
    aiResponse
  );
  twiml.play({ digits: '9' });

  // Record the user's answer
  twiml.record({
    action: `/process-answer1?callSid=${callSid}`,
    maxLength: 120,
    finishOnKey: '#',
    playBeep: true,
    timeout: 5
  });

  res.type('text/xml').send(twiml.toString());
});

// Process first answer and ask second question
app.post('/process-answer1', async (req, res) => {
  const callSid = req.query.callSid;
  const recordingUrl = req.body.RecordingUrl;
  const state = interviews.get(callSid);
  if (req.body.Digits === '#') {
    console.log('User pressed # to end call');
    await endInterview(req.body.CallSid);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(
      {
        voice: 'Polly.Aditi',
        language: 'en-IN'
      },
      'Thank you for your time. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  if (!state) {
    return res.status(404).send('Call not found');
  }

  // Store recording URL in state
  state.answer1Url = recordingUrl;
  state.phase = 'question2';

  // Transcribe and log the answer
  try {
    const transcription = await transcribeRecording(recordingUrl, callSid);
    console.log(`[${callSid}] User Answer 1: ${transcription}`);
    state.history.push({ role: 'user', content: transcription });
  } catch (error) {
    console.error(`[${callSid}] Error transcribing answer 1:`, error);
  }

  const twiml = new twilio.twiml.VoiceResponse();

  // Get AI response for second question
  const aiResponse = await getAiResponse("Ask second technical question", state.jobRole, state.jobDescription);
  console.log(`[${callSid}] AI Question 2: ${aiResponse}`);
  state.history.push({ role: 'assistant', content: aiResponse });

  twiml.say(
    {
      voice: 'Polly.Aditi',
      language: 'en-IN'
    },aiResponse);
  twiml.play({ digits: '9' });

  // Record the user's answer
  twiml.record({
    action: `/process-answer2?callSid=${callSid}`,
    maxLength: 120,
    finishOnKey: '#',
    playBeep: true,
    timeout: 5
  });

  res.type('text/xml').send(twiml.toString());
});

// Process second answer and transition to Q&A
app.post('/process-answer2', async (req, res) => {
  const callSid = req.query.callSid;
  const recordingUrl = req.body.RecordingUrl;
  const state = interviews.get(callSid);
  if (req.body.Digits === '#') {
    console.log('User pressed # to end call');
    await endInterview(req.body.CallSid);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(
      {
        voice: 'Polly.Aditi',
        language: 'en-IN'
      },'Thank you for your time. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  if (!state) {
    return res.status(404).send('Call not found');
  }

  // Store recording URL in state
  state.answer2Url = recordingUrl;
  state.phase = 'qna';

  // Transcribe and log the answer
  try {
    const transcription = await transcribeRecording(recordingUrl, callSid);
    console.log(`[${callSid}] User Answer 2: ${transcription}`);
    state.history.push({ role: 'user', content: transcription });
  } catch (error) {
    console.error(`[${callSid}] Error transcribing answer 2:`, error);
  }

  const twiml = new twilio.twiml.VoiceResponse();

  // Transition to Q&A phase
  const prompt = "Thank you for your answers! Do you have any questions for me? If yes, please ask after the beep. If not, just stay silent or press # to end the call.";
  console.log(`[${callSid}] AI: ${prompt}`);

  twiml.say(
    {
      voice: 'Polly.Aditi',
      language: 'en-IN'
    },prompt);
  twiml.play({ digits: '9' });

  // Record the user's question or silence
  twiml.record({
    action: `/process-qna?callSid=${callSid}`,
    maxLength: 60,
    finishOnKey: '#',
    playBeep: true,
    timeout: 5
  });

  res.type('text/xml').send(twiml.toString());
});

app.post('/process-qna', async (req, res) => {
  const callSid = req.query.callSid;
  const recordingUrl = req.body.RecordingUrl;
  const digits = req.body.Digits;
  const state = interviews.get(callSid);
  
  const twiml = new twilio.twiml.VoiceResponse();

  // Handle early termination
  if (digits === '#') {
    console.log(`[${callSid}] User ended call during Q&A`);
    twiml.say({
      voice: 'Polly.Aditi',
      language: 'en-IN'
    }, 'Thank you for your time. Goodbye.');
    twiml.hangup();
    await endInterview(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  if (!state) {
    twiml.say('Interview session not found. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Check if user had no questions
  if (!recordingUrl) {
    console.log(`[${callSid}] User had no questions, ending call`);
    twiml.say({
      voice: 'Polly.Aditi',
      language: 'en-IN'
    }, 'Thank you for your time! We will review your answers and get back to you soon. Goodbye!');
    twiml.hangup();
    await endInterview(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  // Immediately respond to Twilio to prevent timeout
  twiml.say({
    voice: 'Polly.Aditi',
    language: 'en-IN'
  }, 'Please wait while we process your question.');
  
  // Use <Redirect> to check back for the response
  twiml.redirect({
    method: 'POST'
  }, `/process-qna-response?callSid=${callSid}&recordingUrl=${encodeURIComponent(recordingUrl)}`);

  res.type('text/xml').send(twiml.toString());
});

// New endpoint to handle the AI response after processing
app.post('/process-qna-response', async (req, res) => {
  const callSid = req.query.callSid;
  const recordingUrl = req.query.recordingUrl;
  const state = interviews.get(callSid);
  
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    console.log(`[${callSid}] Processing user question...`);
    const question = await transcribeRecording(recordingUrl, callSid);
    console.log(`[${callSid}] User Question: ${question}`);
    state.history.push({ role: 'user', content: question });

    // Get AI response with shorter timeout
    console.log(`[${callSid}] Generating AI response...`);
    const aiResponse = await Promise.race([
      getQnAResponse(question, state.history),
      new Promise((resolve) => setTimeout(
        () => resolve("Thank you for your question. We'll follow up with more details later."),
        4000 // 4 second timeout to ensure we're under Twilio's 5s
      ))
    ]);

    console.log(`[${callSid}] AI Response: ${aiResponse}`);
    state.history.push({ role: 'assistant', content: aiResponse });

    // Deliver response
    twiml.say({
      voice: 'Polly.Aditi',
      language: 'en-IN'
    }, `${aiResponse} That concludes our interview. Thank you for your time!`);
    twiml.hangup();

  } catch (error) {
    console.error(`[${callSid}] Q&A Processing Error:`, error);
    twiml.say({
      voice: 'Polly.Aditi',
      language: 'en-IN'
    }, 'Thank you for your time! We will review your answers and get back to you soon. Goodbye!');
    twiml.hangup();
  }

  await endInterview(callSid).catch(err => {
    console.error(`[${callSid}] Error in endInterview:`, err);
  });

  return res.type('text/xml').send(twiml.toString());
});

app.post('/call-status', async (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`[${CallSid}] Call status update: ${CallStatus}`);

  try {
    if (CallStatus === 'completed') {
      const state = interviews.get(CallSid);
      if (state && state.history?.length > 0) {
        console.log(`[${CallSid}] Triggering final scoring`);
        await endInterview(CallSid); // Single point of scoring
      }
    }
  } catch (error) {
    console.error(`[${CallSid}] Status handler failed:`, error);
  } finally {
    res.status(200).send();
  }
});

// In server.js, modify the endInterview function:
async function endInterview(callSid) {
  const state = interviews.get(callSid);
  if (!state) {
    console.log(`[${callSid}] No interview state found`);
    return;
  }

  console.log(`[${callSid}] Ending interview at phase: ${state.phase} | History entries: ${state.history.length}`);

  try {
    // 1. Generate score with proper timeout handling
    let score;
    try {
      score = await Promise.race([
        generateFinalScore(state.history, state.jobRole, state.jobDescription),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Scoring timeout after 15s')), 15000);
        })
      ]);
    } catch (scoringError) {
      console.error(`[${callSid}] Scoring failed, using fallback:`, scoringError);
      score = {
        technicalScore: 0,
        communicationScore: 0,
        justification: "Automatic scoring failed",
        completionStatus: "complete",
        breakdown: []
      };
    }

    // 2. Prepare data for DB
    const updateData = {
      "candidates.$.technicalScore": score.technicalScore,
      "candidates.$.communicationScore": score.communicationScore,
      "candidates.$.scoreJustification": score.justification,
      "candidates.$.scoreBreakdown": score.breakdown,
      "candidates.$.completionStatus": score.completionStatus,
      "candidates.$.transcript": state.history
        .map(entry => `${entry.role}: ${entry.content}`)
        .join('\n\n'),
      "candidates.$.status": "completed",
      "candidates.$.endedAt": new Date()
    };

    // 3. Update database (with retry)
    let attempts = 0;
    while (attempts < 3) {
      try {
        await ScheduledCall.findOneAndUpdate(
          { "candidates.phone": state.candidatePhone },
          { $set: updateData },
          { new: true }
        );
        console.log(`[${callSid}] Saved interview results`);
        break;
      } catch (dbError) {
        attempts++;
        if (attempts >= 3) {
          console.error(`[${callSid}] Failed to save results after 3 attempts:`, dbError);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
      }
    }

  } catch (error) {
    console.error(`[${callSid}] CRITICAL: Interview completion failed -`, error.message);
  } finally {
    interviews.delete(callSid);
    console.log(`[${callSid}] Interview state cleared`);
  }
}

app.get("/scheduled-calls", async (req, res) => {
  try {
    const { email } = req.query;
    const calls = await ScheduledCall.find({ email }).sort({ scheduledTime: -1 });

    // Ensure all score fields are included in the response
    const response = calls.map(call => ({
      ...call.toObject(),
      candidates: call.candidates.map(candidate => ({
        ...candidate.toObject(),
        // Ensure these fields are always present
        technicalScore: candidate.technicalScore || null,
        communicationScore: candidate.communicationScore || null,
        scoreJustification: candidate.scoreJustification || null,
        scoreBreakdown: candidate.scoreBreakdown || [],
        completionStatus: candidate.completionStatus || 'complete'
      }))
    }));

    res.json(response);
  } catch (error) {
    console.error("Error fetching scheduled calls:", error);
    res.status(500).json({ error: "Failed to fetch scheduled calls" });
  }
});


// Handle preflight requests
app.options('*', cors());

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});