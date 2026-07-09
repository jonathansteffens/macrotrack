import { useEffect } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  TextInput,
  useAnimatedValue,
  View,
  type TextInputProps,
} from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { ThemedText } from './themed-text';

import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSpeechInput, type SpeechStatus } from '@/hooks/use-speech-input';

/**
 * A themed text field with an optional speak-to-fill mic button beside it, plus
 * an inline status note. One component reused for the meal description and each
 * clarification answer, so dictation behaves identically everywhere. The mic
 * streams the transcript INTO the field and never submits — the user edits and
 * taps the screen's own Estimate/Answer button (dictation mishears food and
 * brand words, so edit-before-submit is deliberate).
 *
 * The mic is absent entirely where speech recognition can't run (web, Expo Go,
 * a build without the native module) — the keyboard is always the fallback, so
 * this is never a dead end.
 */
export type SpeechTextInputProps = Pick<
  TextInputProps,
  'placeholder' | 'autoFocus' | 'multiline' | 'returnKeyType' | 'onSubmitEditing'
> & {
  value: string;
  onChangeText: (text: string) => void;
  /** Field sits inside a raised card → use the base background so it reads as
   *  nested (matches the clarification answer inputs). Default uses the element
   *  background (matches the top-level description field). */
  nested?: boolean;
};

export function SpeechTextInput({
  value,
  onChangeText,
  placeholder,
  autoFocus,
  multiline,
  returnKeyType,
  onSubmitEditing,
  nested,
}: SpeechTextInputProps) {
  const theme = useTheme();
  const mic = useSpeechInput({ value, onChangeText });

  return (
    <View style={styles.container}>
      <View style={[styles.row, multiline && styles.rowMultiline]}>
        <TextInput
          style={[
            styles.input,
            multiline && styles.multiline,
            { backgroundColor: nested ? theme.background : theme.backgroundElement, color: theme.text },
          ]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.textSecondary}
          multiline={multiline}
          autoFocus={autoFocus}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
        />
        {mic.showMic && (
          <MicButton listening={mic.listening} onPress={mic.toggle} />
        )}
      </View>
      <SpeechHint status={mic.status} />
    </View>
  );
}

/** Circular mic toggle. Idle: tinted surface + accent glyph. Listening: solid
 *  accent fill with a soft pulsing halo behind it. */
function MicButton({ listening, onPress }: { listening: boolean; onPress: () => void }) {
  const theme = useTheme();
  const pulse = useAnimatedValue(0);

  useEffect(() => {
    if (!listening) return;
    pulse.setValue(0);
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1100,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [listening, pulse]);

  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityState={{ selected: listening }}
      accessibilityLabel={listening ? 'Stop dictation' : 'Speak your meal'}
      accessibilityHint={
        listening ? 'Stops listening and keeps the text' : 'Fills the field with what you say'
      }
      style={styles.micWrap}>
      {listening && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.halo,
            {
              backgroundColor: theme.tint,
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }),
              transform: [
                { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.6] }) },
              ],
            },
          ]}
        />
      )}
      <View
        style={[
          styles.micButton,
          { backgroundColor: listening ? theme.tintSolid : theme.tintSurface },
        ]}>
        <MicGlyph color={listening ? theme.tintText : theme.tint} />
      </View>
    </Pressable>
  );
}

/** A simple microphone drawn with SVG (the app uses react-native-svg for its
 *  glyphs / charts rather than an icon font). */
function MicGlyph({ color }: { color: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      {/* Capsule */}
      <Rect x={9} y={2} width={6} height={11} rx={3} fill={color} />
      {/* Cradle */}
      <Path
        d="M5 10a7 7 0 0 0 14 0"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
      />
      {/* Stem + base */}
      <Path d="M12 17v4M8.5 21h7" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

const HINTS: Partial<Record<SpeechStatus, string>> = {
  listening: 'Listening… tap the mic to stop',
  denied: 'Microphone access is off — turn it on in Settings, or just type.',
  network: 'Speech needs a connection right now — type instead.',
  unavailable: 'Speech input isn’t available here — type instead.',
  error: 'Didn’t catch that — try again or type instead.',
};

function SpeechHint({ status }: { status: SpeechStatus }) {
  const message = HINTS[status];
  if (!message) return null;
  const danger = status === 'denied' || status === 'network' || status === 'unavailable';
  return (
    <ThemedText type="small" themeColor={danger ? 'danger' : 'tint'} style={styles.hint}>
      {message}
    </ThemedText>
  );
}

const MIC_SIZE = 44;

const styles = StyleSheet.create({
  container: {
    gap: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  // For a tall multiline field, drop the mic to the bottom corner.
  rowMultiline: {
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  multiline: {
    minHeight: 90,
    textAlignVertical: 'top',
  },
  micWrap: {
    width: MIC_SIZE,
    height: MIC_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    position: 'absolute',
    width: MIC_SIZE,
    height: MIC_SIZE,
    borderRadius: MIC_SIZE / 2,
  },
  micButton: {
    width: MIC_SIZE,
    height: MIC_SIZE,
    borderRadius: Radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: {
    paddingHorizontal: Spacing.one,
  },
});
