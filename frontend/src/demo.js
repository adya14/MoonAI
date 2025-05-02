import React, { useState, useEffect, useRef, useCallback } from 'react';
import './demo.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMicrophone, faStop, faSpinner } from '@fortawesome/free-solid-svg-icons';
import { MicVAD, utils } from "@ricky0123/vad-web";

// Helper function encodeWAV (remains the same)
function encodeWAV(samples, sampleRate) {
    let buffer = new ArrayBuffer(44 + samples.length * 2);
    let view = new DataView(buffer);
    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }
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
  const [conversationState, setConversationState] = useState('idle');
  const [statusText, setStatusText] = useState('Click "Start Demo" to begin.');
  const vadRef = useRef(null);
  const audioPlayerRef = useRef(null);
  const userSpeakingRef = useRef(false);
  const [isProcessingOrInitializing, setIsProcessingOrInitializing] = useState(false);

  const conversationStateRef = useRef(conversationState);
  useEffect(() => {
    conversationStateRef.current = conversationState;
    setIsProcessingOrInitializing(conversationState === 'initializing' || conversationState === 'processing');
  }, [conversationState]);

  const resumeListening = useCallback(() => {
      if (conversationStateRef.current === 'speaking' || conversationStateRef.current === 'processing') {
          setConversationState('listening');
          setStatusText('Listening...');
          if (vadRef.current) {
              console.log("Attempting to restart VAD listening...");
              vadRef.current.start();
          } else {
              console.warn("VAD ref was null when trying to resume, conversation likely stopped.");
              setConversationState('idle');
              setStatusText('Session ended. Start demo again.');
          }
      } else {
           console.log("Conversation state is not 'speaking' or 'processing', not resuming VAD.");
      }
  }, []);


  const cleanupVAD = useCallback(() => {
    if (vadRef.current) {
      vadRef.current.destroy();
      vadRef.current = null;
      console.log("VAD destroyed");
    }
    if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
        audioPlayerRef.current.src = '';
        audioPlayerRef.current = null;
        console.log("Audio player stopped and cleaned up");
    }
  }, []);


   const playAiAudioAndResumeListen = (aiAudioUrl) => {
        if (audioPlayerRef.current) {
            audioPlayerRef.current.pause();
            audioPlayerRef.current = null;
        }
        const newAudio = new Audio(aiAudioUrl);
        audioPlayerRef.current = newAudio;
        const onEndedListener = () => {
            audioPlayerRef.current = null;
            newAudio.removeEventListener('ended', onEndedListener);
            newAudio.removeEventListener('error', onErrorListener);
            resumeListening();
        };
        const onErrorListener = (e) => {
            console.error("Audio playback error:", e);
            setStatusText("Error playing response. Resuming listening.");
            audioPlayerRef.current = null;
            newAudio.removeEventListener('ended', onEndedListener);
            newAudio.removeEventListener('error', onErrorListener);
            resumeListening();
        };
        newAudio.addEventListener('ended', onEndedListener);
        newAudio.addEventListener('error', onErrorListener);
        newAudio.play().catch(onErrorListener);
    };

  const processAudioChunk = useCallback(async (audioBuffer) => {
    setConversationState('processing');
    setStatusText('Processing your request...');

    const audioBlob = encodeWAV(audioBuffer, 16000);
    console.log("Sending audio blob:", audioBlob);
    const formData = new FormData();
    formData.append('audio', audioBlob, 'user_speech.wav');

    try {
      const response = await fetch('/api/web-call/process-web-audio', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: `HTTP error! Status: ${response.status}` }));
        throw new Error(errorData.error || `HTTP error! Status: ${response.status}`);
      }
      const responseBlob = await response.blob();
      if (!responseBlob || responseBlob.size === 0 || !responseBlob.type.startsWith('audio/')) {
          throw new Error('Received invalid audio data from server.');
      }
      const aiAudioUrl = URL.createObjectURL(responseBlob);
      setConversationState('speaking');
      setStatusText('AI Speaking...');
      playAiAudioAndResumeListen(aiAudioUrl);

    } catch (error) {
      console.error("Error processing audio:", error);
      setStatusText(`Error: ${error.message}. Resuming listening.`);
      resumeListening();
    }
  }, [resumeListening]);

  const startConversation = useCallback(async () => {
      setConversationState('initializing');
      setStatusText('Initializing audio...');
      cleanupVAD();

      try {
          const myvad = await MicVAD.new({
              modelURL: "/silero_vad.onnx",
              ortURL: "/ort-wasm-simd-threaded.worker.js",
              positiveSpeechThreshold: 0.6,
              negativeSpeechThreshold: 0.45,
              minSilenceFrames: 30,
              preSpeechPadFrames: 5,
              redemptionFrames: 15,
              onSpeechStart: () => {
                  console.log("VAD: Speech Start");
                  userSpeakingRef.current = true;
              },
              onSpeechEnd: (audio) => {
                  console.log("VAD: Speech End");
                  userSpeakingRef.current = false;
                  if (vadRef.current) {
                      vadRef.current.pause();
                  }
                  if (audio && audio.length > 8000) {
                    processAudioChunk(audio);
                  } else {
                    console.log("VAD: Speech End - audio too short, resuming listening.");
                    resumeListening();
                  }
              },
               onVADMisfire: () => {
                    console.log("VAD: Misfire");
               }
          });
          vadRef.current = myvad;
          myvad.start();
          setConversationState('listening');
          setStatusText('Listening...');
      } catch (error) {
          console.error("Failed to initialize VAD:", error);
          setStatusText('Failed to initialize audio. Check mic permissions.');
          setConversationState('idle');
      }
  }, [cleanupVAD, processAudioChunk, resumeListening]);


  const stopConversation = useCallback(() => {
      console.log("Stopping conversation...");
      setConversationState('idle');
      cleanupVAD();
      setStatusText('Demo stopped. Click "Start Demo" to begin again.');
  }, [cleanupVAD]);


  const handleToggleDemo = () => {
    if (conversationStateRef.current === 'idle') {
      startConversation();
    } else {
      stopConversation();
    }
  };


   useEffect(() => {
       return () => {
           cleanupVAD();
       };
   }, [cleanupVAD]);

  const buttonIcon = conversationState === 'idle' ? faMicrophone : faStop;
  const buttonText = conversationState === 'idle' ? 'Start Demo' : 'Stop Demo';

  return (
    <div className="web-demo-split-layout scroll-reveal" id="web-demo">
      <h2>Try Our AI Voice Demo</h2>
      <div className="demo-columns-container">
          <div className="web-demo-content-left">
            <p>Click start, speak naturally, and have a conversation!</p>
            <button
              className={`demo-start-button ${conversationState === 'listening' && userSpeakingRef.current ? 'user-speaking' : ''}`}
              onClick={handleToggleDemo}
              disabled={isProcessingOrInitializing}
            >
               <FontAwesomeIcon icon={buttonIcon} />
               {buttonText}
            </button>
            <div className="demo-status">{statusText}</div>
          </div>

          {/* --- UPDATED ANIMATION AREA --- */}
          <div className={`web-demo-animation-right ${conversationState === 'speaking' ? 'active' : ''}`}>
             <div className="orb-container">
                 <div className="orb orb-1"></div>
                 <div className="orb orb-2"></div>
                 <div className="orb orb-3"></div>
             </div>
          </div>
          {/* --- END OF UPDATED AREA --- */}
      </div>
    </div>
  );
};

export default Demo;