import { router } from 'expo-router';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from './themed-text';

/**
 * The header settings gear — one component so every screen gets the same
 * finger-sized glyph (the default text size read as decoration, not a button).
 */
export function SettingsGear({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable hitSlop={12} style={style} onPress={() => router.push('/settings')}>
      <ThemedText type="default" themeColor="textSecondary" style={styles.glyph}>
        ⚙
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  glyph: {
    fontSize: 24,
    lineHeight: 28,
  },
});
