import { StyleSheet, View } from 'react-native';

import { ThemedText } from './themed-text';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  label: string;
  value: number;
  /** null = no goal set; the amount is shown without a target or bar. */
  goal: number | null;
  color: string;
  /** Display unit appended to values, e.g. "g". Empty for kcal. */
  unit?: string;
};

export function MacroBar({ label, value, goal, color, unit = 'g' }: Props) {
  const theme = useTheme();
  const u = unit ? ` ${unit}` : '';

  // No goal: still show the amount, but no target and no progress bar.
  if (goal == null) {
    return (
      <View style={styles.container}>
        <View style={styles.labelRow}>
          <ThemedText type="small" themeColor="textSecondary">
            {label}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {Math.round(value)}
            {u}
          </ThemedText>
        </View>
      </View>
    );
  }

  const pct = goal > 0 ? Math.min(value / goal, 1) : 0;
  const over = goal > 0 && value > goal;

  return (
    <View style={styles.container}>
      <View style={styles.labelRow}>
        <ThemedText type="small" themeColor="textSecondary">
          {label}
        </ThemedText>
        <ThemedText type="small" style={over && { color }}>
          {Math.round(value)}
          {u} / {Math.round(goal)}
          {u}
        </ThemedText>
      </View>
      <View style={[styles.track, { backgroundColor: theme.backgroundSelected }]}>
        <View
          style={[
            styles.fill,
            { backgroundColor: color, width: `${pct * 100}%`, opacity: over ? 1 : 0.85 },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.one,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  track: {
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 4,
  },
});
