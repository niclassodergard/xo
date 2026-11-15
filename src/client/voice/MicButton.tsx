import { useEffect, useState } from 'preact/hooks';
import { singlePanel } from '../lib/layout.ts';
import { toggleDictation, voiceState } from './index.ts';
import { formatElapsed } from './voice-logic.ts';
import '../styles/voice.css';

/**
 * Composer mic button. States: idle, starting, recording (elapsed time), transcribing, confirming
 * (Send / Discard at the length limit). The accessible name always starts with "Dictate".
 * `large` is the phone variant (default: on in single-panel mode).
 */
export default function MicButton(props: { large?: boolean } = {}) {
  const s = voiceState().value;
  const [now, setNow] = useState(() => Date.now());
  const recording = s.phase === 'recording';
  useEffect(() => {
    if (!recording) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [recording]);
  const size = (props.large ?? singlePanel.value) ? ' large' : ''; // the phone layout always gets the big target

  if (s.phase === 'confirming') {
    // The Send/Discard prompt itself is VoiceStatus (shell level, visible in every layout); the mic just waits.
    return (
      <span class="mic-wrap">
        <button type="button" class={`mic${size}`} aria-label="Dictate: waiting for Send or Discard" disabled>…</button>
      </span>
    );
  }
  if (s.phase === 'recording') {
    const elapsed = formatElapsed(now - (s.startedAt ?? now));
    return (
      <span class="mic-wrap"><button type="button" class={`mic recording${size}`} aria-pressed="true" aria-label={`Dictate: recording ${elapsed}. Activate to stop and transcribe`} onClick={toggleDictation}>
        ● {elapsed}
      </button></span>
    );
  }
  if (s.phase === 'starting') {
    return <span class="mic-wrap"><button type="button" class={`mic${size}`} aria-label="Dictate: starting the microphone" disabled>…</button></span>;
  }
  if (s.phase === 'transcribing') {
    return <span class="mic-wrap"><button type="button" class={`mic${size}`} aria-label="Dictate: transcribing" disabled>…</button></span>;
  }
  return (
    <span class="mic-wrap">
      <button type="button" class={`mic${size}`} aria-label="Dictate: hold Option-Space, or click to start and stop" title="Dictate (hold Option-Space)" onClick={toggleDictation}>
        🎤
      </button>
    </span>
  );
}
