import { useEffect, useState } from 'preact/hooks';
import { singlePanel } from '../lib/layout.ts';
import { discardRecording, sendByEnter, sendRecording, voiceState } from './index.ts';
import { CHOICE_TEXT, formatElapsed } from './voice-logic.ts';
import '../styles/voice.css';

/**
 * Shell-level voice indicator, mounted once by app.tsx so it shows in every layout (the composer, with its mic
 * button, is not rendered while a panel is expanded or a document fills the phone screen). It shows the
 * recording, the transcription and, at the length limit, the Send/Discard prompt.
 */
export default function VoiceStatus() {
  const s = voiceState().value;
  const [now, setNow] = useState(() => Date.now());
  const recording = s.phase === 'recording';
  useEffect(() => {
    if (!recording) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [recording]);

  if (s.phase === 'idle') return null;
  if (s.phase === 'confirming') {
    return (
      <div class="voice-status confirm" role="alert">
        <span class="voice-status-text">{CHOICE_TEXT}</span>
        <button type="button" class="btn primary" onClick={sendRecording}>{sendByEnter.value ? 'Send (Enter)' : 'Send'}</button>
        <button type="button" class="btn" onClick={discardRecording}>Discard (Esc)</button>
      </div>
    );
  }
  // Phone width: a short one-line form that leaves the panel header's Back and Close buttons uncovered.
  const short = singlePanel.value;
  const text = s.phase === 'recording'
    ? short
      ? `\u25CF ${formatElapsed(now - (s.startedAt ?? now))} \u00B7 Esc cancels`
      : `\u25CF Recording ${formatElapsed(now - (s.startedAt ?? now))} \u00B7 release or press the mic to stop, Esc cancels`
    : s.phase === 'starting' ? 'Starting the microphone\u2026' : 'Transcribing\u2026';
  return <div class="voice-status" role="status"><span class="voice-status-text">{text}</span></div>;
}
