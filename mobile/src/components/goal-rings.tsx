import { Platform, StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { ThemedText } from './themed-text';

import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fmtKcal } from '@/lib/macros';
import type { TrackingConfig } from '@/lib/tracking';
import type { Macros } from '@/lib/types';

/**
 * The Today-screen signature visual: a hero calorie ring (brand iris) with the
 * day's total as a big rounded numeral. Every other tracked nutrient renders
 * as a MacroBar below the ring — one consistent secondary treatment (the old
 * flanking mini-rings read as clutter next to the hero).
 *
 * Over-goal never laps in the same hue: the ring completes, then the overflow
 * fraction is drawn as a danger arc from 12 o'clock on top of it, and the
 * center gains an explicit "+N over" line — color is never the only cue.
 */

const HERO_SIZE = 150;
const HERO_STROKE = 13;

/** One SVG progress ring: track, progress arc, and danger overflow overlay. */
function Ring({
  size,
  stroke,
  value,
  goal,
  color,
  trackColor,
  overflowColor,
}: {
  size: number;
  stroke: number;
  value: number;
  /** null = no goal: only the static track is drawn. */
  goal: number | null;
  color: string;
  trackColor: string;
  overflowColor: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const center = size / 2;
  const progress = goal != null && goal > 0 ? Math.min(value / goal, 1) : 0;
  const overflow =
    goal != null && goal > 0 && value > goal ? Math.min((value - goal) / goal, 1) : 0;
  // Both arcs start at 12 o'clock (the -90° rotation below).
  const rotate = `rotate(-90 ${center} ${center})`;

  return (
    <Svg width={size} height={size}>
      <Circle cx={center} cy={center} r={r} stroke={trackColor} strokeWidth={stroke} fill="none" />
      {progress > 0 && (
        <Circle
          cx={center}
          cy={center}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * progress} ${c}`}
          fill="none"
          transform={rotate}
        />
      )}
      {overflow > 0 && (
        <Circle
          cx={center}
          cy={center}
          r={r}
          stroke={overflowColor}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * overflow} ${c}`}
          fill="none"
          transform={rotate}
        />
      )}
    </Svg>
  );
}

export function GoalRings({
  totals,
  tracking,
  energy = 'Cal',
}: {
  totals: Macros;
  tracking: TrackingConfig;
  /** Energy display label from Settings → Units ("Cal" or "kcal"). */
  energy?: string;
}) {
  const theme = useTheme();

  const kcalCfg = tracking.kcal;
  if (!kcalCfg.enabled) return null;

  const kcalGoal = kcalCfg.goal;
  const over = kcalGoal != null && kcalGoal > 0 && totals.kcal > kcalGoal;
  const left = kcalGoal != null ? kcalGoal - totals.kcal : null;

  const a11y = `${fmtKcal(totals.kcal)} calories${
    kcalGoal != null ? ` of a ${fmtKcal(kcalGoal)} goal` : ''
  }`;

  return (
    <View style={styles.row} accessible accessibilityLabel={a11y}>
      {kcalCfg.enabled && (
        <View style={styles.hero}>
          <Ring
            size={HERO_SIZE}
            stroke={HERO_STROKE}
            value={totals.kcal}
            goal={kcalGoal}
            color={theme.tint}
            trackColor={theme.backgroundSelected}
            overflowColor={theme.danger}
          />
          <View style={styles.heroCenter} pointerEvents="none">
            <ThemedText style={styles.heroValue} maxFontSizeMultiplier={1.1}>
              {fmtKcal(totals.kcal)}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" maxFontSizeMultiplier={1.1}>
              {kcalGoal != null ? `of ${fmtKcal(kcalGoal)} ${energy}` : energy}
            </ThemedText>
            {left != null &&
              (over ? (
                <ThemedText
                  type="small"
                  style={[styles.heroDelta, { color: theme.danger }]}
                  maxFontSizeMultiplier={1.1}>
                  +{fmtKcal(-left)} over
                </ThemedText>
              ) : (
                <ThemedText
                  type="small"
                  themeColor="textSecondary"
                  style={styles.heroDelta}
                  maxFontSizeMultiplier={1.1}>
                  {fmtKcal(left)} left
                </ThemedText>
              ))}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
  hero: {
    width: HERO_SIZE,
    height: HERO_SIZE,
  },
  heroCenter: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroValue: {
    fontSize: 34,
    lineHeight: 38,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? Fonts.rounded : undefined,
    fontVariant: ['tabular-nums'],
  },
  heroDelta: {
    marginTop: Spacing.half,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
});
