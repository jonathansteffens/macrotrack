import { StyleSheet } from 'react-native';

import { ThemedText } from './themed-text';

/**
 * One-line everyday reference anchors shown wherever a portion is being
 * entered. The values deliberately mirror the portion guidance in the AI
 * system prompt (lib/ai/prompt.ts), so the app and the model quote the same
 * numbers.
 */
export function PortionAnchors() {
  return (
    <ThemedText type="small" themeColor="textSecondary" style={styles.line}>
      1 egg ≈ 50 g · bread slice ≈ 30 g · cup cooked rice ≈ 160 g · tbsp oil ≈ 14 g ·
      chicken breast ≈ 150–220 g
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  line: {
    opacity: 0.8,
  },
});
