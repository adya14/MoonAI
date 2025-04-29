const fs = require('fs');
const path = require('path');

// --- Configuration ---
// Set the path to your WAV file here
const wavFilePath = path.join(__dirname, 'howza.wav'); // Replace 'your_audio_file.wav' with your file name

// --- Simple VAD Parameters ---
// These parameters are somewhat tuned for 8kHz, 16-bit, mono audio,
// but may require adjustment based on your specific recording's volume,
// background noise, and desired sensitivity.

// Duration of each frame for analysis (in milliseconds)
const frameDurationMs = 25;

// Energy threshold: The minimum mean squared energy required for a frame to be considered 'speech'.
// This is crucial and highly dependent on your audio's volume and noise floor.
// Values typically range from ~0.001 (very sensitive) to ~0.01 (less sensitive) for audio
// normalized between -1 and +1. You WILL likely need to tune this.
const energyThreshold = 0.0001; // Start with the value you tested, but be prepared to tune!

// Silence duration: The minimum duration of silence (in milliseconds) required
// after speech to consider the speech segment finished.
const silenceDurationMs = 1000; // Example: 600ms of silence

// --- WAV Parsing and VAD Logic ---

try {
    // Read the entire WAV file into a buffer
    const fileBuffer = fs.readFileSync(wavFilePath);

    // --- Basic WAV Header Parsing ---
    // We'll extract just the necessary info for VAD
    // Assumes a standard RIFF WAV format with 'fmt ' and 'data' chunks

    let offset = 0;

    // Check RIFF header
    if (fileBuffer.toString('utf8', offset, offset + 4) !== 'RIFF') {
        throw new Error('Not a valid RIFF file');
    }
    offset += 4; // 'RIFF'
    offset += 4; // File size (ignore)
    if (fileBuffer.toString('utf8', offset, offset + 4) !== 'WAVE') {
        throw new Error('Not a valid WAVE file');
    }
    offset += 4; // 'WAVE'

    // Find 'fmt ' chunk
    let fmtChunkFound = false;
    let sampleRate = 0;
    let numChannels = 0;
    let bitsPerSample = 0;

    while (offset < fileBuffer.length - 8) {
        const chunkId = fileBuffer.toString('utf8', offset, offset + 4);
        const chunkSize = fileBuffer.readUInt32LE(offset + 4);
        offset += 8; // Move past chunk ID and size

        if (chunkId === 'fmt ') {
            fmtChunkFound = true;
            const audioFormat = fileBuffer.readUInt16LE(offset);
            if (audioFormat !== 1) {
                throw new Error(`Unsupported audio format: ${audioFormat}. Only PCM (format 1) is supported.`);
            }
            numChannels = fileBuffer.readUInt16LE(offset + 2);
            sampleRate = fileBuffer.readUInt32LE(offset + 4);
            // byteRate = fileBuffer.readUInt32LE(offset + 8); // Ignore
            // blockAlign = fileBuffer.readUInt16LE(offset + 12); // Ignore
            bitsPerSample = fileBuffer.readUInt16LE(offset + 14);

            if (numChannels !== 1) {
                 throw new Error(`Unsupported number of channels: ${numChannels}. Only mono (1 channel) is supported.`);
            }
             if (bitsPerSample !== 16) {
                 throw new Error(`Unsupported bit depth: ${bitsPerSample}. Only 16-bit is supported.`);
             }
             if (sampleRate !== 8000) {
                  console.warn(`Warning: File sample rate is ${sampleRate} Hz. Expected 8000 Hz. VAD parameters might need tuning.`);
             }

            offset += chunkSize; // Move past fmt chunk data
            break; // Found fmt chunk, move on
        } else {
            // Skip other chunks
            offset += chunkSize;
        }
    }

    if (!fmtChunkFound) {
        throw new Error('Fmt chunk not found in WAV file.');
    }

    // Find 'data' chunk
    let dataChunkFound = false;
    let dataOffset = 0;
    let dataSize = 0;

     // Reset offset to search for 'data' chunk after 'fmt '
     offset = 12; // Start searching after RIFF and WAVE headers

     while (offset < fileBuffer.length - 8) {
        const chunkId = fileBuffer.toString('utf8', offset, offset + 4);
        const chunkSize = fileBuffer.readUInt32LE(offset + 4);
        offset += 8; // Move past chunk ID and size

         if (chunkId === 'data') {
            dataChunkFound = true;
            dataOffset = offset;
            dataSize = chunkSize;
            // No need to move offset past data chunk, we'll read from dataOffset
            break; // Found data chunk
        } else {
            // Skip other chunks
            offset += chunkSize;
        }
     }

     if (!dataChunkFound) {
         throw new Error('Data chunk not found in WAV file.');
     }

    console.log(`WAV Info: Sample Rate=${sampleRate} Hz, Channels=${numChannels}, Bit Depth=${bitsPerSample}`);
    console.log(`Data Chunk: Offset=${dataOffset}, Size=${dataSize} bytes`);

    // --- VAD Calculation Setup ---
    const bytesPerSample = bitsPerSample / 8;
    const totalSamples = dataSize / bytesPerSample;
    const durationSeconds = totalSamples / sampleRate;

    // Calculate the number of samples per frame
    const frameSize = Math.floor(sampleRate * (frameDurationMs / 1000));
     if (frameSize === 0) {
         throw new Error('Calculated frame size is 0. Check sample rate and frame duration.');
     }

    // Calculate the number of consecutive silent frames needed to end a speech segment
    const silenceDurationFrames = Math.floor((silenceDurationMs / 1000) * sampleRate / frameSize);
     if (silenceDurationFrames === 0) {
          console.warn(`Warning: Calculated silence duration frames is 0. Silence duration (${silenceDurationMs}ms) is shorter than frame duration (${frameDurationMs}ms). Silence detection may not work as expected.`);
     }


    console.log(`VAD Parameters: Frame Size=${frameSize} samples (${frameDurationMs}ms), Energy Threshold=${energyThreshold}, Silence Duration=${silenceDurationMs}ms (${silenceDurationFrames} frames)`);
    console.log('Processing audio data...');

    // --- VAD Logic ---
    let isSpeaking = false; // State variable: true if currently in a speech segment
    let silenceFrameCounter = 0; // Counts consecutive frames below the energy threshold
    let speechStartTime = null; // Timestamp when the current speech segment started

    console.log('\n--- Detected Events ---');

    // Iterate through the audio data frame by frame
    // We iterate based on samples, not bytes
    for (let i = 0; i < totalSamples; i += frameSize) {
        // Calculate the start byte offset for the current frame
        const frameByteOffset = dataOffset + i * bytesPerSample;

        // Calculate the number of samples in the current frame (handle the last partial frame)
        const currentFrameSize = Math.min(frameSize, totalSamples - i);

        if (currentFrameSize <= 0) continue; // Should not happen if loop condition is correct

        // Calculate the energy of the current frame (Mean Squared Energy)
        let energy = 0;
        for (let j = 0; j < currentFrameSize; j++) {
            // Read 16-bit sample (little-endian)
            const sample16 = fileBuffer.readInt16LE(frameByteOffset + j * bytesPerSample);
            // Normalize the sample to a float between -1.0 and 1.0
            const sampleFloat = sample16 / 32768.0; // Divide by max possible 16-bit value

            energy += sampleFloat * sampleFloat; // Sum of squares
        }
        energy /= currentFrameSize; // Divide by number of samples to get the mean

        // Calculate the time (in seconds) at the start of the current frame
        const currentTime = i / sampleRate;

        // --- VAD State Machine Logic ---
        if (energy > energyThreshold) {
            // The current frame's energy is above the threshold -> potential speech
            if (!isSpeaking) {
                // Transition from silence to speech
                isSpeaking = true;
                speechStartTime = currentTime; // Record the start time
                silenceFrameCounter = 0; // Reset silence counter

                // Print Speech Start Timestamp
                console.log(`Speech Start: ${speechStartTime.toFixed(3)}`);

            } else {
                // Still in a speech segment, reset silence counter
                silenceFrameCounter = 0;
            }
        } else {
            // The current frame's energy is below the threshold -> potential silence
            if (isSpeaking) {
                // We are in a speech segment, but current frame is silent
                silenceFrameCounter++;

                // Check if we have accumulated enough consecutive silent frames
                if (silenceFrameCounter >= silenceDurationFrames) {
                    // The period of silence is long enough to consider the speech segment finished.
                    isSpeaking = false;
                    // Approximate the end time of the speech segment. It's the time
                    // *before* the required duration of silence started.
                    const segmentEndTime = currentTime - (silenceDurationFrames * frameSize / sampleRate);

                    // Print Speech End Timestamp (due to detected silence)
                    console.log(`Speech End (Silence Detected): ${segmentEndTime.toFixed(3)}`);

                    speechStartTime = null; // Reset start time for the next segment
                    silenceFrameCounter = 0; // Reset the silence counter for the new silence period
                }
            } else {
                 // We are already in a silence state and detected more silence.
                 // No action needed unless we were tracking silence duration for other purposes.
            }
        }
    }

     // --- Handle case where speech extends to the very end of the file ---
     // If we were speaking when the loop finished, the segment ends at the end of the file.
     if (isSpeaking && speechStartTime !== null) {
         // The last speech segment ended at the end of the file without enough trailing silence
         console.log(`Speech End (End of File): ${durationSeconds.toFixed(3)}`);
     }

    console.log('--- End of Processing ---');

} catch (error) {
    console.error('Error:', error.message);
    console.error('Please ensure the file exists, is a valid mono 8000 Hz 16-bit PCM WAV, and check the VAD parameters.');
}
