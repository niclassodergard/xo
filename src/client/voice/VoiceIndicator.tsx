import { useEffect, useState } from 'preact/hooks';
import { discardRecording, sendRecording, toggleDictation, voiceState } from './index.ts';
import { CHOICE_TEXT, formatElapsed } from './voice-logic.ts';

// Status-line voice state: mic button (idle), recording with elapsed time, or transcribing.
export default function VoiceIndicator() {
  const s = voiceState().value;
  const [now, setNow] = useState(() => Date.now());
  const recording = s.phase === 'recording';
  useEffect(() => {
    if (!recording) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [recording]);

  if (s.phase === 'recording') {
    const elapsed = formatElapsed(now - (s.startedAt ?? now));
    return (
      <button type="button" class="tbtn accent" aria-pressed="true" aria-label={`Recording ${elapsed}. Activate to stop and transcribe`} onClick={toggleDictation}>
        ● REC {elapsed} <span class="dim">esc cancels</span>
      </button>
    );
  }
  if (s.phase === 'confirming') {
    return (
      <span role="alert">
        <span class="accent">{CHOICE_TEXT}</span>{' '}
        <button type="button" class="tbtn" onClick={sendRecording}>Send (Enter)</button>{' '}
        <button type="button" class="tbtn" onClick={discardRecording}>Discard (Esc)</button>
      </span>
    );
  }
  if (s.phase === 'starting') return <span role="status"><span class="dim">mic…</span> <span class="dim">esc cancels</span></span>;
  if (s.phase === 'transcribing') return <span role="status"><span class="accent">transcribing…</span> <span class="dim">esc cancels</span></span>;
  return (
    <button type="button" class="tbtn" aria-label="Dictate: hold Space, or click to start and stop" title="Hold Space (Alt+Space in any mode) to talk" onClick={toggleDictation}>
      mic
    </button>
  );
}
