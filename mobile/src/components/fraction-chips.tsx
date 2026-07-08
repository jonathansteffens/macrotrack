import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from './themed-text';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Quick portion multipliers ("only ate half", "had seconds"). Each chip
 * multiplies the current amount, so they compose: ½ then ½ is a quarter.
 */
const FRACTIONS: { label: string; factor: number }[] = [
  { label: '½', factor: 1 / 2 },
  { label: '⅓', factor: 1 / 3 },
  { label: '¼', factor: 1 / 4 },
  { label: '⅔', factor: 2 / 3 },
  { label: '1½', factor: 1.5 },
  { label: '2×', factor: 2 },
];

export function FractionChips({
  value,
  onValue,
}: {
  /** Current amount; null (unparseable input) disables the chips. */
  value: number | null;
  onValue: (next: number) => void;
}) {
  const theme = useTheme();
  const disabled = value == null || value <= 0;
  return (
    <View style={[styles.row, disabled && styles.disabled]}>
      {FRACTIONS.map((f) => (
        <Pressable
          key={f.label}
          disabled={disabled}
          hitSlop={4}
          onPress={() => value != null && onValue(value * f.factor)}
          style={[styles.chip, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText type="small" themeColor="textSecondary">
            {f.label}
          </ThemedText>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  disabled: {
    opacity: 0.4,
  },
  chip: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: Spacing.one,
  },
});
