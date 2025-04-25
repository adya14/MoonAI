const fs = require('fs');
const path = require('path');

// --- Configuration ---
const ulawFilePath = path.join(__dirname, 'audio2.ulaw'); // Or your other test file

// --- Audio Properties ---
const sampleRate = 8000;
const frameDurationMs = 25;
const silenceDurationMs = 1000;

// --- Adaptive VAD Parameters ---
const INITIAL_NOISE_FRAMES = 20;
const SMOOTHING_ALPHA = 0.1;
const RELATIVE_DROP_FACTOR = 0.25;
const RELATIVE_RISE_FACTOR = 3.0;
const MIN_ENERGY = 1e-7;

// --- Calculated Values ---
const frameSize = Math.floor(sampleRate * (frameDurationMs / 1000));
const silenceDurationFrames = Math.floor((silenceDurationMs / 1000) * sampleRate / frameSize);

if (frameSize <= 0) { throw new Error('Calculated frame size is 0 or less.'); }
if (silenceDurationFrames <= 0) { console.warn(`Warning: Calculated silence duration frames is 0 or less.`); }

function decodeUlaw(ulawByte) {
    // (decodeUlaw function remains the same)
    ulawByte = ~ulawByte;
    const sign = (ulawByte & 0x80);
    const exponent = (ulawByte >> 4) & 0x07;
    const mantissa = ulawByte & 0x0F;
    let linear = (mantissa << 4) + 0x80 + (0x100 << exponent);
    if (!sign) { linear = -linear; }
    return linear;
}

// --- Main Processing Logic ---
try {
    const ulawBuffer = fs.readFileSync(ulawFilePath);
    const totalUlawSamples = ulawBuffer.length;
    const totalLinearSamples = totalUlawSamples;
    const durationSeconds = totalLinearSamples / sampleRate;
    const linearPcmSamples = new Int16Array(totalLinearSamples);

    console.log(`Decoding ${totalUlawSamples} u-law bytes...`); // Keep basic info
    for (let i = 0; i < totalUlawSamples; i++) {
        linearPcmSamples[i] = decodeUlaw(ulawBuffer[i]);
    }
    console.log(`Decoding complete. ${totalLinearSamples} linear samples generated.`); // Keep basic info

    // Keep parameter summary
    console.log(`Adaptive VAD Parameters: Frame Size=${frameSize}, Silence Duration=${silenceDurationMs}ms (${silenceDurationFrames} frames), Drop Factor=${RELATIVE_DROP_FACTOR}, Rise Factor=${RELATIVE_RISE_FACTOR}`);

    // --- Initialize VAD State ---
    let isSpeaking = false;
    let silenceFrameCounter = 0;
    let speechStartTime = null;
    let frameCounter = 0;
    let noiseEnergyAvg = 0.0;
    let speechEnergyAvg = 0.0;
    let isInitialized = false;

    console.log('\n--- Detected Speech Events ---'); // Changed title

    // --- Processing Loop ---
    for (let i = 0; i < totalLinearSamples; i += frameSize) {
        const currentFrameSize = Math.min(frameSize, totalLinearSamples - i);
        if (currentFrameSize < frameSize) continue; // Skip incomplete frames

        // Calculate frame energy
        let energy = 0;
        for (let j = 0; j < currentFrameSize; j++) {
            const sample16 = linearPcmSamples[i + j];
            const sampleFloat = sample16 / 32768.0;
            energy += sampleFloat * sampleFloat;
        }
        energy = Math.max(MIN_ENERGY, energy / currentFrameSize);

        const currentTime = i / sampleRate;
        frameCounter++;

        // Initialization Phase
        if (!isInitialized) {
            if (frameCounter <= INITIAL_NOISE_FRAMES) {
                noiseEnergyAvg += energy;
                if (frameCounter === INITIAL_NOISE_FRAMES) {
                    noiseEnergyAvg /= INITIAL_NOISE_FRAMES;
                    noiseEnergyAvg = Math.max(MIN_ENERGY, noiseEnergyAvg);
                    speechEnergyAvg = noiseEnergyAvg * (RELATIVE_RISE_FACTOR * 1.5); // Initialize speech avg guess
                    isInitialized = true;
                    // Removed initial average estimate logs
                }
                continue; // Skip VAD logic during init
            }
        }

        // --- VAD State Machine ---
        let potentialSpeech = energy > noiseEnergyAvg * RELATIVE_RISE_FACTOR;
        let potentialSilence = energy < speechEnergyAvg * RELATIVE_DROP_FACTOR;
        let silenceThresholdValue = speechEnergyAvg * RELATIVE_DROP_FACTOR; // Keep for logging end event context

        if (isSpeaking) {
            // Only update speechEnergyAvg if NOT potentially silent
            if (!potentialSilence) {
                 speechEnergyAvg = (SMOOTHING_ALPHA * energy) + ((1 - SMOOTHING_ALPHA) * speechEnergyAvg);
                 silenceFrameCounter = 0; // Reset counter if energy goes back up
            } else {
                 // Potential silence - DO NOT update speechEnergyAvg, just count frames
                 silenceFrameCounter++;
            }

            // Check for confirmed silence AFTER updating counter
            if (silenceFrameCounter >= silenceDurationFrames) {
                isSpeaking = false;
                const segmentEndTime = currentTime - (silenceDurationFrames * frameSize / sampleRate);
                // *** Keep this essential log ***
                console.log(`Speech End (Silence Detected): ${segmentEndTime.toFixed(3)}s`);
                speechStartTime = null;
                silenceFrameCounter = 0;
            }

        } else { // !isSpeaking
            // Update noise average when not speaking
            noiseEnergyAvg = (SMOOTHING_ALPHA * energy) + ((1 - SMOOTHING_ALPHA) * noiseEnergyAvg);
            noiseEnergyAvg = Math.max(MIN_ENERGY, noiseEnergyAvg);

            // Check for transition to speech
            if (potentialSpeech) {
                isSpeaking = true;
                speechStartTime = currentTime;
                silenceFrameCounter = 0;
                 // *** Keep this essential log ***
                console.log(`Speech Start: ${speechStartTime.toFixed(3)}s`);
                // Initialize speech average based on triggering energy
                speechEnergyAvg = Math.max(energy, speechEnergyAvg);
            }
        }
    } // End loop

     // Handle speech ending at the very end of the file
     if (isSpeaking && speechStartTime !== null) {
        // *** Keep this essential log ***
        console.log(`Speech End (End of File): ${durationSeconds.toFixed(3)}s`);
     }

    console.log('--- End of Processing ---'); // Keep basic info

} catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('Please ensure the file exists, is a raw u-law file, and check the VAD parameters.');
}