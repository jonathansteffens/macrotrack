import { Platform } from 'react-native';
// Type-only imports — erased at compile time, so referencing the module's shapes
// never pulls the native `expo-speech-recognition` module into the bundle or the
// Expo Go / web runtime. The real module is loaded lazily via dynamic import
// below (the same pattern local-model.ts uses for llama.rn).
import type {
  ExpoSpeechRecognitionErrorCode,
  ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition';

/**
 * Thin wrapper around `expo-speech-recognition` for MacroTrack's speak-your-meal
 * input. Speech recognition is a native module that only exists in an Expo **dev
 * build** — it is absent in Expo Go, and this wrapper treats web as unsupported
 * too, so the mic affordance simply never appears there (the caller hides the
 * button when `probeSpeech()` isn't 'ready'). Never a dead end: the text field
 * and keyboard are always the fallback.
 *
 * The transcript is streamed into an editable field — nothing here ever submits.
 * The user edits and taps the normal Estimate button (dictation mishears food /
 * brand words, so edit-before-submit is the whole point).
 */

/** Collapsed error taxonomy the UI reacts to. `aborted` (a normal stop) is not
 *  an error and is never surfaced. */
export type SpeechErrorKind = 'denied' | 'unavailable' | 'no-speech' | 'network' | 'error';

/** Result of an availability probe: 'ready' → show the mic; anything else → hide
 *  it, except 'denied' which the UI can turn into an inline "enable in Settings"
 *  note (still not a dead end — the keyboard is right there). */
export type SpeechAvailability = 'ready' | 'unavailable' | 'denied';

export type SpeechHandlers = {
  /** Fires on every partial (interim) transcript — the full best guess so far,
   *  cumulative within the session (not incremental). Stream it into the field. */
  onPartial: (transcript: string) => void;
  /** Fires once with the final transcript when recognition settles. */
  onFinal: (transcript: string) => void;
  /** Recognition ended (silence auto-stop, manual stop, or after a final). Use
   *  to return the UI to idle. Always fires exactly once per session. */
  onEnd: () => void;
  /** A real error (not a normal stop). onEnd still fires afterwards. */
  onError: (kind: SpeechErrorKind) => void;
};

/** Handle to an in-flight session. `stop()` asks for a final result; `abort()`
 *  cancels immediately with no final. */
export type SpeechSession = { stop: () => void; abort: () => void };

// ---- Lazy module load (never touched at import time) ----

type SpeechModule = typeof import('expo-speech-recognition');

let modulePromise: Promise<SpeechModule | null> | null = null;

/** Load the native module once, or null if it can't be loaded here (web, Expo
 *  Go, or a build without the native module). Cached across calls. */
function loadModule(): Promise<SpeechModule | null> {
  if (!modulePromise) {
    modulePromise = (async () => {
      if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
      try {
        return await import('expo-speech-recognition');
      } catch {
        // Native module absent (Expo Go) — degrade to "no mic".
        return null;
      }
    })();
  }
  return modulePromise;
}

export function isSpeechSupported(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

/**
 * Non-intrusive availability probe: is the platform supported, is the native
 * module present, does the recognizer service exist on the device, and are
 * permissions already granted? Does NOT prompt for permission — a fresh
 * 'undetermined' reads as 'ready' so the mic shows and the *first tap* triggers
 * the OS prompt (probing shouldn't nag). Only a hard 'denied' hides the pure
 * mic in favour of the inline enable-in-Settings note.
 */
export async function probeSpeech(): Promise<SpeechAvailability> {
  const mod = await loadModule();
  if (!mod) return 'unavailable';
  try {
    if (!mod.ExpoSpeechRecognitionModule.isRecognitionAvailable()) return 'unavailable';
    const perm = await mod.ExpoSpeechRecognitionModule.getPermissionsAsync();
    if (!perm.granted && !perm.canAskAgain) return 'denied';
    return 'ready';
  } catch {
    return 'unavailable';
  }
}

/** Map a native Web-Speech-style error code to our collapsed taxonomy. Returns
 *  null for `aborted` — a normal programmatic stop, never surfaced as an error. */
function mapError(code: ExpoSpeechRecognitionErrorCode): SpeechErrorKind | null {
  switch (code) {
    case 'aborted':
      return null;
    case 'not-allowed':
    case 'service-not-allowed':
      return 'denied';
    case 'no-speech':
    case 'speech-timeout':
      return 'no-speech';
    case 'network':
      return 'network';
    case 'audio-capture':
    case 'language-not-supported':
    case 'bad-grammar':
      return 'unavailable';
    default:
      // busy, client, interrupted, unknown
      return 'error';
  }
}

/**
 * Start a listening session. Requests permission on first use (the OS prompt),
 * wires up interim + final transcript streaming, and auto-stops on silence
 * (continuous:false → the recognizer settles after a natural pause). Resolves to
 * a {@link SpeechSession} once listening, or null if it couldn't start (in which
 * case `onError` has already fired with the reason and `onEnd` will not).
 */
export async function startSpeech(handlers: SpeechHandlers): Promise<SpeechSession | null> {
  const mod = await loadModule();
  if (!mod) {
    handlers.onError('unavailable');
    return null;
  }
  const { ExpoSpeechRecognitionModule: M } = mod;

  try {
    if (!M.isRecognitionAvailable()) {
      handlers.onError('unavailable');
      return null;
    }
    const perm = await M.requestPermissionsAsync();
    if (!perm.granted) {
      handlers.onError('denied');
      return null;
    }
  } catch {
    handlers.onError('unavailable');
    return null;
  }

  let ended = false;
  const subs = [
    M.addListener('result', (e: ExpoSpeechRecognitionResultEvent) => {
      const transcript = e.results[0]?.transcript ?? '';
      if (e.isFinal) handlers.onFinal(transcript);
      else handlers.onPartial(transcript);
    }),
    M.addListener('error', (e) => {
      const kind = mapError(e.error);
      if (kind) handlers.onError(kind);
    }),
    M.addListener('end', () => {
      if (ended) return;
      ended = true;
      for (const s of subs) s.remove();
      handlers.onEnd();
    }),
  ];

  const cleanupNow = () => {
    if (ended) return;
    ended = true;
    for (const s of subs) s.remove();
    handlers.onEnd();
  };

  try {
    M.start({
      lang: 'en-US',
      interimResults: true, // stream partials into the field as the user speaks
      continuous: false, // settle on a natural pause (silence auto-stop)
      // Prefer on-device recognition when the device supports it — keeps meal
      // descriptions private and works offline. Falls back to network otherwise.
      requiresOnDeviceRecognition: false,
    });
  } catch {
    cleanupNow();
    handlers.onError('error');
    return null;
  }

  return {
    stop: () => M.stop(),
    abort: () => M.abort(),
  };
}
