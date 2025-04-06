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
const { transcribeAudio, getAiResponse } = require('./interview');
const { convertAudio } = require('./audioProcessor'); 
const app = express();
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

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
  const { jobRole, jobDescription, candidates } = req.body;
  
  try {
    if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
      return res.status(400).json({ error: "Invalid candidates data" });
    }

    const results = [];
    for (const candidate of candidates) {
      try {
        console.log(`Initiating call to ${candidate.phone}`);
        
        const call = await client.calls.create({
          to: candidate.phone,
          from: process.env.TWILIO_PHONE_NUMBER,
          url: `https://${process.env.BACKEND_URL}/voice?jobRole=${encodeURIComponent(jobRole)}&jobDescription=${encodeURIComponent(jobDescription)}`
        });

        interviews.set(call.sid, {
          jobRole,
          jobDescription,
          history: [],
          phase: 'introduction',
          candidatePhone: candidate.phone,
          lastActivity: Date.now()
        });

        results.push({ success: true, callSid: call.sid, phone: candidate.phone });
      } catch (error) {
        console.error(`Failed to call ${candidate.phone}:`, error);
        results.push({ success: false, phone: candidate.phone, error: error.message });
      }
    }

    res.json({ results });
  } catch (error) {
    console.error("Global call error:", error);
    res.status(500).json({ 
      error: "Call processing failed",
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});

// Initial voice handler
app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid;
  const jobRole = req.query.jobRole;
  const jobDescription = req.query.jobDescription;
  
  const twiml = new twilio.twiml.VoiceResponse();
  
  // Greet the user and ask for introduction
  const greeting = `Hello, this is an automated interview for the ${jobRole} position. Please introduce yourself after the beep.`;
  console.log(`[${callSid}] AI: ${greeting}`);
  
  twiml.say(greeting);
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

// Process introduction and ask first question
app.post('/process-intro', async (req, res) => {
  const callSid = req.query.callSid;
  const recordingUrl = req.body.RecordingUrl;
  const state = interviews.get(callSid);
  
  if (!state) {
    return res.status(404).send('Call not found');
  }

  // Store recording URL in state
  state.recordingUrl = recordingUrl;
  state.phase = 'question1';
  
  // Transcribe and log the introduction
  try {
    const audioBuffer = await downloadAudio(recordingUrl);
    const wavBuffer = await convertAudio(audioBuffer);
    const transcription = await transcribeAudio(wavBuffer, callSid);
    console.log(`[${callSid}] User Introduction: ${transcription}`);
    state.history.push({ role: 'user', content: transcription });
  } catch (error) {
    console.error(`[${callSid}] Error transcribing introduction:`, error);
  }
  
  const twiml = new twilio.twiml.VoiceResponse();
  
  // Get AI response for first question
  const aiResponse = await getAiResponse("Ask first technical question", state.jobRole, state.jobDescription);
  console.log(`[${callSid}] AI Question 1: ${aiResponse}`);
  state.history.push({ role: 'assistant', content: aiResponse });
  
  twiml.say(aiResponse);
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
  
  if (!state) {
    return res.status(404).send('Call not found');
  }

  // Store recording URL in state
  state.answer1Url = recordingUrl;
  state.phase = 'question2';
  
  // Transcribe and log the answer
  try {
    const transcription = await transcribeAudio(recordingUrl, callSid);
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
  
  twiml.say(aiResponse);
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
  
  if (!state) {
    return res.status(404).send('Call not found');
  }

  // Store recording URL in state
  state.answer2Url = recordingUrl;
  state.phase = 'qna';
  
  // Transcribe and log the answer
  try {
    const transcription = await transcribeAudio(recordingUrl, callSid);
    console.log(`[${callSid}] User Answer 2: ${transcription}`);
    state.history.push({ role: 'user', content: transcription });
  } catch (error) {
    console.error(`[${callSid}] Error transcribing answer 2:`, error);
  }
  
  const twiml = new twilio.twiml.VoiceResponse();
  
  // Transition to Q&A phase
  const prompt = "Thank you for your answers! Do you have any questions for me? If yes, please ask after the beep. If not, just stay silent or press # to end the call.";
  console.log(`[${callSid}] AI: ${prompt}`);
  
  twiml.say(prompt);
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

// Process Q&A interaction
app.post('/process-qna', async (req, res) => {
  const callSid = req.query.callSid;
  const recordingUrl = req.body.RecordingUrl;
  const digits = req.body.Digits;
  const state = interviews.get(callSid);
  
  if (!state) {
    return res.status(404).send('Call not found');
  }

  const twiml = new twilio.twiml.VoiceResponse();
  
  // Check if user pressed # or was silent (no questions)
  if (digits === '#' || !recordingUrl) {
    console.log(`[${callSid}] User had no questions, ending call`);
    twiml.say("Thank you for your time! We will review your answers and get back to you soon. Goodbye!");
    twiml.hangup();
    interviews.delete(callSid);
    return res.type('text/xml').send(twiml.toString());
  }
  
  // Transcribe and log the user's question
  try {
    const question = await transcribeAudio(recordingUrl, callSid);
    console.log(`[${callSid}] User Question: ${question}`);
    state.history.push({ role: 'user', content: question });
    
    // Get AI response to the question
    const aiResponse = await getAiResponse(`Answer this question: ${question}`, state.jobRole, state.jobDescription);
    console.log(`[${callSid}] AI Answer: ${aiResponse}`);
    state.history.push({ role: 'assistant', content: aiResponse });
    
    twiml.say(aiResponse);
    twiml.play({ digits: '9' });
    
    // Ask if they have more questions
    const followUp = "Do you have any other questions? If yes, please ask after the beep. If not, just stay silent or press # to end the call.";
    console.log(`[${callSid}] AI: ${followUp}`);
    
    twiml.say(followUp);
    twiml.play({ digits: '9' });
    
    // Record again
    twiml.record({
      action: `/process-qna?callSid=${callSid}`,
      maxLength: 60,
      finishOnKey: '#',
      playBeep: true,
      timeout: 5
    });
    
  } catch (error) {
    console.error(`[${callSid}] Error processing Q&A:`, error);
    twiml.say("Sorry, I encountered an error. Thank you for your time! Goodbye!");
    twiml.hangup();
    interviews.delete(callSid);
  }
  
  res.type('text/xml').send(twiml.toString());
});

// Handle preflight requests
app.options('*', cors());

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});