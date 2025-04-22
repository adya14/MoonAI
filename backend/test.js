const mic = require('mic');
const fs = require('fs');
const path = require('path');
const wav = require('wav');
const { createVAD } = require('@ricky0123/vad');

// Configuration
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const SILENCE_TIMEOUT = 3000; // 3 seconds of silence to stop
const MIN_QUESTION_DURATION = 2000; // Don't stop before 2 seconds of speech

const questions = [
  "What's your name and background?",
  "What are your strengths?",
  "Why are you applying for this role?"
];

async function setupVAD() {
  const vad = await createVAD({
    modelURL: 'https://models.huggingface.co/ricky0123/vad/tiny.en/quantized.onnx',
    workletURL: 'https://cdn.jsdelivr.net/npm/@ricky0123/vad/dist/vad.worklet.bundle.min.js'
  });
  return vad;
}

async function askQuestion(index = 0, vad) {
  if (index >= questions.length) {
    console.log('\n🎉 Interview completed!');
    process.exit(0);
  }

  const question = questions[index];
  console.log(`\n❓ Question ${index + 1}: ${question}`);
  console.log('🎙️ Start speaking now... (waiting for voice to begin recording)');

  const outputFile = path.join(__dirname, `answer${index + 1}.wav`);
  const writer = new wav.FileWriter(outputFile, {
    channels: CHANNELS,
    sampleRate: SAMPLE_RATE,
    bitDepth: 16
  });

  // Configure microphone
  const micInstance = mic({
    rate: SAMPLE_RATE.toString(),
    channels: CHANNELS.toString(),
    debug: false,
    device: 'default',
    bitwidth: '16',
    encoding: 'signed-integer',
    endian: 'little',
    exitOnSilence: 0
  });

  const micInputStream = micInstance.getAudioStream();
  let recordingStartTime = null;
  let lastVoiceTime = null;
  let isRecording = false;

  micInputStream.on('data', (chunk) => {
    if (!isRecording) {
      // Check if this is voice before starting recording
      if (vad.process(chunk)) {
        isRecording = true;
        recordingStartTime = Date.now();
        lastVoiceTime = Date.now();
        console.log('🎤 Recording started!');
        writer.write(chunk);
      }
      return;
    }

    writer.write(chunk);
    
    // Update voice detection
    if (vad.process(chunk)) {
      lastVoiceTime = Date.now();
    } else if (Date.now() - recordingStartTime > MIN_QUESTION_DURATION && 
               Date.now() - lastVoiceTime > SILENCE_TIMEOUT) {
      console.log('🔇 Natural pause detected. Stopping recording...');
      micInstance.stop();
    }
  });

  micInputStream.on('startComplete', () => {
    console.log('🔄 Microphone ready (waiting for voice)...');
  });

  micInputStream.on('stopComplete', () => {
    writer.end();
    const duration = recordingStartTime ? ((Date.now() - recordingStartTime) / 1000).toFixed(2) : 0;
    console.log(`✅ Saved answer${index + 1}.wav (${duration}s)`);
    
    // Verify file was created
    try {
      const stats = fs.statSync(outputFile);
      if (stats.size < 100) {
        console.log('⚠️ File too small - retrying question');
        fs.unlinkSync(outputFile);
        askQuestion(index, vad);
        return;
      }
    } catch (err) {
      console.log('⚠️ File not saved properly - retrying');
      askQuestion(index, vad);
      return;
    }

    askQuestion(index + 1, vad);
  });

  micInputStream.on('error', err => {
    console.error('❌ Microphone error:', err);
    writer.end();
    process.exit(1);
  });

  micInstance.start();
}

async function main() {
  try {
    // First install required packages:
    // npm install mic wav @ricky0123/vad
    
    console.log('🚀 Setting up voice activity detector...');
    const vad = await setupVAD();
    console.log('✅ VAD ready. Starting interview...');
    askQuestion(0, vad);
  } catch (err) {
    console.error('❌ Failed to initialize:', err);
    process.exit(1);
  }
}

main();