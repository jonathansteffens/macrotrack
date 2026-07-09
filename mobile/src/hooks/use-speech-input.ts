import { useCallback, useEffect, useRef, useState } from 'react';

import {
  probeSpeech,
  startSpeech,
  type SpeechAvailability,
  type SpeechErrorKind,
  type SpeechSession,
} from '@/lib/speech';

/**
 * UI state for one dictation-enabled field. `idle`/`listening` are the working
 * states; the error kinds double as the note the UI shows. `no-speech` never
 * appears here — a silence timeout returns to `idle` quietly (per the product
 * spec), so this union omits it.
 */
export type SpeechStatus = 'idle' | 'listening' | Exclude<SpeechErrorKind, 'no-speech'>;

/**
 * Drives one field's speak-to-fill behaviour. Streams the live transcript INTO
 * the field (never submits) by capturing the field's value when listening
 * starts and appending the recognizer's cumulative transcript to it, so partial
 * results replace cleanly and any text the user already typed is preserved.
 *
 * Reused by every {@link SpeechTextInput} — the main meal description and each
 * clarification answer — which is why the value/setter come in as props: each
 * instance drives its own field. Availability is probed once on mount; the mic
 * is only rendered when {@link showMic} is true.
 */
export function useSpeechInput({
  value,
  onChangeText,
}: {
  value: string;
  onChangeText: (text: string) => void;
}) {
  const [available, setAvailable] = useState<SpeechAvailability | null>(null);
  const [status, setStatus] = useState<SpeechStatus>('idle');

  const sessionRef = useRef<SpeechSession | null>(null);
  // Live refs so the async session callbacks always see the latest field value /
  // setter without being re-created (and without stale closures). Synced in an
  // effect — writing refs during render is disallowed under the React Compiler.
  const valueRef = useRef(value);
  const setTextRef = useRef(onChangeText);
  // The field's content at the moment listening began — the transcript is
  // appended to this so the user's pre-typed text is never clobbered.
  const baseRef = useRef('');

  useEffect(() => {
    valueRef.current = value;
    setTextRef.current = onChangeText;
  });

  useEffect(() => {
    let alive = true;
    probeSpeech().then((a) => {
      if (alive) setAvailable(a);
    });
    return () => {
      alive = false;
      // Abort a dangling session if the screen unmounts mid-listen.
      sessionRef.current?.abort();
      sessionRef.current = null;
    };
  }, []);

  const applyTranscript = useCallback((transcript: string) => {
    const base = baseRef.current;
    const sep = base && !/\s$/.test(base) ? ' ' : '';
    setTextRef.current(base + sep + transcript);
  }, []);

  const start = useCallback(async () => {
    baseRef.current = valueRef.current;
    setStatus('listening');
    const session = await startSpeech({
      onPartial: applyTranscript,
      onFinal: applyTranscript,
      onEnd: () => {
        sessionRef.current = null;
        // Only the normal-stop path resets to idle; an error already set its own
        // note, which must survive the end event that follows it.
        setStatus((s) => (s === 'listening' ? 'idle' : s));
      },
      onError: (kind) => {
        // Silence timeout is not a failure the user needs told about.
        setStatus(kind === 'no-speech' ? 'idle' : kind);
      },
    });
    if (session) sessionRef.current = session;
    // else: startSpeech already fired onError (status set) and will NOT fire
    // onEnd, so there is nothing to reset here.
  }, [applyTranscript]);

  const toggle = useCallback(() => {
    if (sessionRef.current) sessionRef.current.stop();
    else void start();
  }, [start]);

  return {
    /** Whether to render the mic at all. Hidden while probing and on platforms /
     *  builds without the recognizer; shown when ready or when access was denied
     *  (so a tap can surface the enable-in-Settings note). */
    showMic: available === 'ready' || available === 'denied',
    listening: status === 'listening',
    status,
    toggle,
  };
}
