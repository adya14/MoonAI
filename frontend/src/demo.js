import React, { useState, useEffect, useRef, useCallback } from 'react';
import './demo.css'; // Make sure this path is correct
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMicrophone, faSpinner, faStop } from '@fortawesome/free-solid-svg-icons';

// Helper function encodeWAV (remains the same)
function encodeWAV(samples, sampleRate) {
    let buffer = new ArrayBuffer(44 + samples.length * 2);
    let view = new DataView(buffer);
    function writeString(view, offset, string) { for (let i = 0; i < string.length; i++) { view.setUint8(offset + i, string.charCodeAt(i)); } }
    let offset = 0;
    writeString(view, offset, 'RIFF'); offset += 4;
    view.setUint32(offset, 36 + samples.length * 2, true); offset += 4;
    writeString(view, offset, 'WAVE'); offset += 4;
    writeString(view, offset, 'fmt '); offset += 4;
    view.setUint32(offset, 16, true); offset += 4;
    view.setUint16(offset, 1, true); offset += 2;
    view.setUint16(offset, 1, true); offset += 2;
    view.setUint32(offset, sampleRate, true); offset += 4;
    view.setUint32(offset, sampleRate * 2, true); offset += 4;
    view.setUint16(offset, 2, true); offset += 2;
    view.setUint16(offset, 16, true); offset += 2;
    writeString(view, offset, 'data'); offset += 4;
    view.setUint32(offset, samples.length * 2, true); offset += 4;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([view], { type: 'audio/wav' });
}


const Demo = () => {
    // --- VAD & RECORDING CONSTANTS ---
    const SPEECH_THRESHOLD = 0.03;
    const INTERRUPTION_THRESHOLD = 0.15;
    const SILENCE_DELAY_MS = 1000;
    const MIN_RECORDING_DURATION_MS = 250;
    const VAD_SAMPLE_RATE = 16000;
    const VAD_BUFFER_SIZE = 1024;

    // --- State Management ---
    const [conversationState, setConversationState] = useState('idle');
    const [statusText, setStatusText] = useState('Click the microphone to start the demo.');

    // --- Refs for Audio Processing ---
    const audioContextRef = useRef(null);
    const mediaStreamSourceRef = useRef(null);
    const scriptProcessorRef = useRef(null);
    const userAudioStreamRef = useRef(null);
    const audioPlayerRef = useRef(new Audio()); // Use a ref for the persistent audio player
    const silenceTimeoutRef = useRef(null);
    const recordedAudioRef = useRef([]);

    // --- Conversation History & TTS ---
    const [messages, setMessages] = useState([
        { role: "system", content: "You are a helpful assistant and your name is Moon. Respond naturally in the language appropriate to the user's query or context, unless specifically asked otherwise. Keep responses concise. Keep responses short 5-6 lines maximum. Strictly do not include any emojis of special unecessary characters" }
    ]);
    const synthesisRef = useRef(window.speechSynthesis);
    const currentUtteranceRef = useRef(null);
    const conversationStateRef = useRef(conversationState);

    useEffect(() => {
        conversationStateRef.current = conversationState;
        console.log("Conversation state changed to:", conversationState);
    }, [conversationState]);

    const stopAudioProcessingPipeline = useCallback(() => {
        console.log("Stopping audio processing pipeline (VAD)...");
        if (scriptProcessorRef.current) {
            scriptProcessorRef.current.disconnect();
            scriptProcessorRef.current.onaudioprocess = null;
            scriptProcessorRef.current = null;
        }
        if (mediaStreamSourceRef.current) {
            mediaStreamSourceRef.current.disconnect();
            mediaStreamSourceRef.current = null;
        }
        if (userAudioStreamRef.current) {
            userAudioStreamRef.current.getTracks().forEach(track => track.stop());
            userAudioStreamRef.current = null;
        }
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            audioContextRef.current.close().then(() => console.log("AudioContext closed."));
            audioContextRef.current = null;
        }
        recordedAudioRef.current = [];
        if (silenceTimeoutRef.current) {
            clearTimeout(silenceTimeoutRef.current);
            silenceTimeoutRef.current = null;
        }
    }, []);

    const resumeListening = useCallback(() => {
        const currentState = conversationStateRef.current;
        if (currentState !== 'processing' && currentState !== 'user_speaking') {
            setConversationState('listening');
            setStatusText('Listening...');
            console.log("Transitioned to listening state.");
        } else {
            console.log(`Attempted to resume listening, but current state is ${currentState}. No change.`);
        }
    }, []);

    const stopAiAudioPlayback = useCallback(() => {
        let wasSpeaking = false;
        // Stop streamed audio player
        if (audioPlayerRef.current && !audioPlayerRef.current.paused) {
            audioPlayerRef.current.pause();
            audioPlayerRef.current.src = ''; // Detach the source
            wasSpeaking = true;
        }
        // Stop browser TTS
        if (synthesisRef.current && synthesisRef.current.speaking) {
            synthesisRef.current.cancel();
            currentUtteranceRef.current = null;
            wasSpeaking = true;
        }
        if(wasSpeaking) console.log("AI audio playback stopped.");
        return wasSpeaking;
    }, []);

    const playStreamedAudioAndResumeListen = useCallback((audioBlob) => {
        stopAiAudioPlayback(); // Ensure nothing else is playing
        setConversationState('ai_speaking');
        setStatusText('AI Speaking...');
        
        const audioUrl = URL.createObjectURL(audioBlob);
        const player = audioPlayerRef.current;
        player.src = audioUrl;
        player.play().catch(e => {
            console.error("Error playing streamed audio:", e);
            resumeListening(); // If play fails, go back to listening
        });

        player.onended = () => {
            console.log("Streamed audio finished.");
            URL.revokeObjectURL(audioUrl); // Clean up the object URL
            if (conversationStateRef.current === 'ai_speaking') {
                resumeListening();
            }
        };

        player.onerror = (e) => {
            console.error("Audio player error:", e);
            URL.revokeObjectURL(audioUrl);
            if (conversationStateRef.current === 'ai_speaking') {
                resumeListening();
            }
        };
    }, [stopAiAudioPlayback, resumeListening]);

    const playBrowserTTSAndResumeListen = useCallback((text) => {
        if (!text || text.trim() === "") {
            console.warn("playBrowserTTSAndResumeListen called with empty text.");
            resumeListening();
            return;
        }
        stopAiAudioPlayback();
        setConversationState('ai_speaking');
        setStatusText('AI Speaking...');
        console.log("AI Speaking (Browser TTS Fallback):", text);

        const utterance = new SpeechSynthesisUtterance(text);
        currentUtteranceRef.current = utterance;

        utterance.onend = () => {
            console.log("Browser TTS finished.");
            currentUtteranceRef.current = null;
            if (conversationStateRef.current === 'ai_speaking') {
                resumeListening();
            }
        };
        utterance.onerror = (event) => {
            console.error("Browser TTS error:", event);
            currentUtteranceRef.current = null;
            if (conversationStateRef.current === 'ai_speaking') {
                resumeListening();
            }
        };
        synthesisRef.current.speak(utterance);
    }, [stopAiAudioPlayback, resumeListening]);

    const processAudio = useCallback(async (audioBuffer) => {
        const audioDurationMs = (audioBuffer.length / VAD_SAMPLE_RATE) * 1000;
        if (!audioBuffer || audioBuffer.length === 0 || audioDurationMs < MIN_RECORDING_DURATION_MS) {
            console.log(`Audio too short (${audioDurationMs.toFixed(0)}ms). Resuming listening.`);
            resumeListening();
            return;
        }

        setConversationState('processing');
        setStatusText('Processing your speech...');

        const wavBlob = encodeWAV(audioBuffer, VAD_SAMPLE_RATE);
        const formData = new FormData();
        formData.append('audio', wavBlob, 'user_speech.wav');
        formData.append('history', JSON.stringify(messages));

        const backendBaseUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:5000';
        const apiUrl = `${backendBaseUrl}/api/web-call/process-web-audio`;

        try {
            const response = await fetch(apiUrl, { method: 'POST', body: formData });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: `Server error! Status: ${response.status}` }));
                throw new Error(errorData.error || `Server error! Status: ${response.status}`);
            }

            // Get text from headers, regardless of content type
            const userTranscription = decodeURIComponent(response.headers.get('X-User-Transcription') || "");
            const aiResponseText = decodeURIComponent(response.headers.get('X-AI-Response-Text') || "");

            // Update conversation history as soon as we get the text
            if (userTranscription) setMessages(prev => [...prev, { role: "user", content: userTranscription }]);
            if (aiResponseText) setMessages(prev => [...prev, { role: "assistant", content: aiResponseText }]);

            const contentType = response.headers.get('Content-Type');

            // SCENARIO 1: We received streamed audio from Google TTS
            if (contentType?.includes('audio/mpeg')) {
                 console.log("Received streamed audio response. Playing now.");
                 const audioBlob = await response.blob();
                 playStreamedAudioAndResumeListen(audioBlob);

            // SCENARIO 2: We received a JSON response (TTS fallback or no speech)
            } else if (contentType?.includes('application/json')) {
                const responseBody = await response.json();
                console.log("Received JSON response (TTS fallback).", responseBody.message);
                if (responseBody.message && responseBody.message.toLowerCase().includes('silence or no speech')) {
                     console.log("Backend detected no speech. Resuming listening.");
                     setMessages(prev => prev.slice(0, -1)); // Remove empty user message
                     resumeListening();
                } else {
                     playBrowserTTSAndResumeListen(responseBody.aiResponseText);
                }
            } else {
                throw new Error(`Received unexpected response content type: ${contentType}`);
            }
        } catch (error) {
            console.error("Error processing audio:", error);
            setStatusText(`Error: ${error.message}. Resuming...`);
            resumeListening();
        }
    }, [messages, resumeListening, playBrowserTTSAndResumeListen, playStreamedAudioAndResumeListen]);

    const handleAudioProcess = useCallback((event) => {
        if (!audioContextRef.current || scriptProcessorRef.current === null) return;
        
        const inputBuffer = event.inputBuffer.getChannelData(0);
        let sum = 0.0;
        for (let i = 0; i < inputBuffer.length; i++) {
            sum += inputBuffer[i] * inputBuffer[i];
        }
        const rms = Math.sqrt(sum / inputBuffer.length);
        const currentState = conversationStateRef.current;

        if (currentState === 'ai_speaking') {
            if (rms > INTERRUPTION_THRESHOLD) {
                console.log(`INTERRUPTION DETECTED over AI! RMS: ${rms.toFixed(4)}`);
                stopAiAudioPlayback();
                recordedAudioRef.current = [...inputBuffer];
                setConversationState('user_speaking');
                setStatusText('Listening (interrupted AI)...');
                if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current);
                silenceTimeoutRef.current = null;
            }
            return;
        }

        if (currentState === 'listening') {
            if (rms > SPEECH_THRESHOLD) {
                console.log(`User speech started. RMS: ${rms.toFixed(4)}`);
                recordedAudioRef.current = [...inputBuffer];
                setConversationState('user_speaking');
                setStatusText('Listening...');
            }
            return;
        }

        if (currentState === 'user_speaking') {
            recordedAudioRef.current.push(...inputBuffer);

            if (rms < SPEECH_THRESHOLD) {
                if (!silenceTimeoutRef.current) {
                    silenceTimeoutRef.current = setTimeout(() => {
                        console.log(`Silence detected for ${SILENCE_DELAY_MS}ms. Processing.`);
                        const completeAudio = new Float32Array(recordedAudioRef.current);
                        recordedAudioRef.current = [];
                        silenceTimeoutRef.current = null;
                        if (conversationStateRef.current === 'user_speaking') {
                           processAudio(completeAudio);
                        } else {
                           console.log("Silence timer fired, but state changed. Not processing.");
                           resumeListening();
                        }
                    }, SILENCE_DELAY_MS);
                }
            } else {
                if (silenceTimeoutRef.current) {
                    clearTimeout(silenceTimeoutRef.current);
                    silenceTimeoutRef.current = null;
                }
            }
        }
    }, [processAudio, stopAiAudioPlayback, resumeListening]);
    
    const startDemo = useCallback(async () => {
        if (conversationStateRef.current !== 'idle') {
            console.log("Demo is already running.");
            return;
        }
        console.log("Attempting to start demo...");
        setStatusText('Initializing...');
        setMessages([{ role: "system", content: "You are a helpful assistant and your name is Moon. Respond naturally in the language appropriate to the user's query or context, unless specifically asked otherwise. Keep responses concise. Keep responses short 5-6 lines maximum. Strictly do not include any emojis of special unecessary characters" }]);

        try {
            if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
                await audioContextRef.current.close();
            }
            if (userAudioStreamRef.current) {
                userAudioStreamRef.current.getTracks().forEach(track => track.stop());
            }
            
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { sampleRate: VAD_SAMPLE_RATE, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            userAudioStreamRef.current = stream;

            const context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: VAD_SAMPLE_RATE });
            audioContextRef.current = context;
            if (context.state === 'suspended') await context.resume();

            const source = context.createMediaStreamSource(stream);
            mediaStreamSourceRef.current = source;
            
            const processor = context.createScriptProcessor(VAD_BUFFER_SIZE, 1, 1);
            scriptProcessorRef.current = processor;
            processor.onaudioprocess = handleAudioProcess;
            source.connect(processor);
            processor.connect(context.destination);

            setConversationState('listening');
            setStatusText('Listening...');
            console.log("Demo started successfully.");

        } catch (error) {
            console.error("Failed to start demo:", error);
            setStatusText('Error: Check microphone permissions.');
            setConversationState('idle');
            stopAudioProcessingPipeline();
        }
    }, [handleAudioProcess, stopAudioProcessingPipeline]);

    const stopDemo = useCallback(() => {
        if (conversationStateRef.current === 'idle') return;
        console.log("Stopping demo manually...");
        stopAudioProcessingPipeline();
        stopAiAudioPlayback();
        setConversationState('idle');
        setStatusText('Click the microphone to start the demo.');
    }, [stopAudioProcessingPipeline, stopAiAudioPlayback]);

    useEffect(() => {
        return () => {
            console.log("Demo component unmounting. Cleaning up...");
            stopDemo();
        };
    }, [stopDemo]);
    
    const isDemoActive = conversationState !== 'idle';
    let buttonIcon = faMicrophone;
    let buttonText = "Start Demo";
    let buttonDisabled = false;

    if (conversationState === 'processing') {
        buttonIcon = faSpinner;
        buttonText = "Processing...";
        buttonDisabled = true;
    } else if (isDemoActive) {
        buttonIcon = faStop;
        buttonText = "Stop Demo";
    }

    return (
        <div className="web-demo-split-layout scroll-reveal" id="web-demo">
            <h2>Try Our AI Voice Demo</h2>
            <div className="demo-columns-container">
                <div className="web-demo-content-left">
                    <p>Click "Start Demo" to begin. Speak naturally and the AI will respond when you pause. You can interrupt the AI by speaking over it.</p>
                    <button
                        className={`demo-start-button ${isDemoActive && conversationState !== 'processing' ? 'is-recording' : ''}`}
                        onClick={isDemoActive ? stopDemo : startDemo}
                        disabled={buttonDisabled}
                    >
                        <FontAwesomeIcon icon={buttonIcon} spin={conversationState === 'processing'} />
                        {buttonText}
                    </button>
                    <div className="demo-status">{statusText}</div>
                </div>

                <div className={`web-demo-animation-right ${conversationState === 'ai_speaking' ? 'active' : ''}`}>
                    <div className="orb-container">
                        <div className="orb orb-1"></div>
                        <div className="orb orb-2"></div>
                        <div className="orb orb-3"></div>
                    </div>
                </div>
            </div>
            <div style={{ marginTop: '20px', textAlign: 'left', maxHeight: '200px', overflowY: 'auto', border: '1px solid #ccc', padding: '10px', fontSize: '0.8em', borderRadius: '8px' }}>
                {messages.slice(1).map((msg, index) => (
                    <div key={index} style={{ marginBottom: '8px', paddingLeft: '5px', borderLeft: `3px solid ${msg.role === 'user' ? '#007bff' : '#28a745'}` }}>
                        <strong style={{ color: msg.role === 'user' ? '#007bff' : '#28a745' }}>{msg.role === 'user' ? 'You: ' : 'Moon: '}</strong>{msg.content}
                    </div>
                ))}
            </div>
        </div>
    );
};

export default Demo;