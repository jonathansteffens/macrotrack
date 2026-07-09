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
        <View style={styles.valueRow}>
          {/* Explicit over-budget cue — a compact pill, never color alone. */}
          {over && (
            <View style={[styles.overBadge, { borderColor: theme.danger }]}>
              <ThemedText type="small" style={[styles.overText, { color: theme.danger }]}>
                +{Math.round(value - goal)}
                {u} over
              </ThemedText>
            </View>
          )}
          <ThemedText type="small" style={over ? { color: theme.danger } : undefined}>
            {Math.round(value)}
            {u} / {Math.round(goal)}
            {u}
          </ThemedText>
        </View>
      </View>
      <View style={[styles.track, { backgroundColor: theme.backgroundSelected }]}>
        <View
          style={[
            styles.fill,
            {
              backgroundColor: over ? theme.danger : color,
              width: `${pct * 100}%`,
              opacity: over ? 1 : 0.85,
            },
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
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  overBadge: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.one + 2,
    paddingVertical: 1,
  },
  overText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
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
