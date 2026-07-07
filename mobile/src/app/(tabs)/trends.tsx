import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BarChart } from '@/components/bar-chart';
import { SparkLine } from '@/components/spark-line';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MacroColors, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { shortLabel } from '@/lib/dates';
import { getGoals } from '@/lib/goals';
import { fmtGrams, parseDecimal } from '@/lib/macros';
import { getTrends, type DayTotal, type TrendSummary } from '@/lib/trends';
import { DEFAULT_GOALS, type Goals } from '@/lib/types';
import { logWeight, weightTrend, type WeightEntry } from '@/lib/weights';

const RANGES = [7, 30, 90] as const;
const METRICS = [
  { key: 'kcal', label: 'Calories', color: MacroColors.kcal, unit: 'kcal' },
  { key: 'protein', label: 'Protein', color: MacroColors.protein, unit: 'g' },
  { key: 'carbs', label: 'Carbs', color: MacroColors.carbs, unit: 'g' },
  { key: 'fat', label: 'Fat', color: MacroColors.fat, unit: 'g' },
  { key: 'fiber', label: 'Fiber', color: MacroColors.fiber, unit: 'g' },
] as const;

type MetricKey = (typeof METRICS)[number]['key'];

export default function TrendsScreen() {
  const theme = useTheme();
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [metric, setMetric] = useState<MetricKey>('kcal');
  const [trends, setTrends] = useState<TrendSummary | null>(null);
  const [goals, setGoals] = useState<Goals>(DEFAULT_GOALS);
  const [weight, setWeight] = useState<{
    series: number[];
    entries: WeightEntry[];
    change: number | null;
  } | null>(null);
  const [weightText, setWeightText] = useState('');

  const loadWeight = useCallback(() => {
    weightTrend(range).then(setWeight);
  }, [range]);

  useFocusEffect(
    useCallback(() => {
      getTrends(range).then(setTrends);
      getGoals().then(setGoals);
      loadWeight();
    }, [range, loadWeight])
  );

  const submitWeight = async () => {
    const w = parseDecimal(weightText);
    if (w == null || w <= 0) return;
    await logWeight(w);
    setWeightText('');
    loadWeight();
  };

  const m = METRICS.find((x) => x.key === metric)!;
  const values = trends?.days.map((d) => d[metric]) ?? [];
  const labels = trends?.days.map((d) => shortLabel(d.day)) ?? [];
  const movingAvg = trends ? movingAverage(trends.days, (d) => d[metric]) : [];
  const avg =
    trends == null
      ? 0
      : {
          kcal: trends.avgKcal,
          protein: trends.avgProtein,
          carbs: trends.avgCarbs,
          fat: trends.avgFat,
          fiber: trends.avgFiber,
        }[metric];

  return (
    <ThemedView style={styles.root}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}>
          <ThemedText type="subtitle">Trends</ThemedText>

          {/* Range selector */}
          <View style={styles.chipRow}>
            {RANGES.map((r) => (
              <Chip key={r} label={`${r} days`} selected={range === r} onPress={() => setRange(r)} />
            ))}
          </View>

          {/* Metric selector */}
          <View style={styles.chipRow}>
            {METRICS.map((x) => (
              <Chip
                key={x.key}
                label={x.label}
                selected={metric === x.key}
                onPress={() => setMetric(x.key)}
              />
            ))}
          </View>

          {/* Chart */}
          <ThemedView type="backgroundElement" style={styles.chartCard}>
            <View style={styles.chartHeader}>
              <ThemedText type="smallBold">{m.label}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {goals[metric] != null ? 'goal (dashed) · ' : ''}7-day avg (line)
              </ThemedText>
            </View>
            {trends && trends.loggedDays > 0 ? (
              <BarChart
                values={values}
                labels={labels}
                color={m.color}
                goal={goals[metric] ?? undefined}
                overlay={movingAvg}
              />
            ) : (
              <ThemedText type="small" themeColor="textSecondary" style={styles.emptyChart}>
                Nothing logged in this period yet.
              </ThemedText>
            )}
          </ThemedView>

          {/* Summary stats */}
          {trends && (
            <View style={styles.statsRow}>
              <StatCard
                label={`Avg ${m.label.toLowerCase()}`}
                value={`${Math.round(avg)} ${m.unit}`}
                sub="on logged days"
              />
              <StatCard
                label="Days logged"
                value={`${trends.loggedDays}/${range}`}
                sub={`${Math.round((trends.loggedDays / range) * 100)}%`}
              />
              <StatCard
                label="Streak"
                value={`${trends.streak}`}
                sub={trends.streak === 1 ? 'day' : 'days'}
              />
            </View>
          )}

          {/* Weight */}
          <ThemedView type="backgroundElement" style={styles.chartCard}>
            <View style={styles.chartHeader}>
              <ThemedText type="smallBold">Weight</ThemedText>
              {weight && weight.entries.length > 0 && (
                <ThemedText type="small" themeColor="textSecondary">
                  {fmtGrams(weight.entries[weight.entries.length - 1].weight)}
                  {weight.change != null &&
                    `  (${weight.change > 0 ? '+' : ''}${fmtGrams(weight.change)} over range)`}
                </ThemedText>
              )}
            </View>
            {weight && weight.entries.length > 1 && (
              <SparkLine values={weight.series} color={MacroColors.kcal} />
            )}
            <View style={styles.weightRow}>
              <TextInput
                style={[
                  styles.weightInput,
                  { backgroundColor: theme.background, color: theme.text },
                ]}
                value={weightText}
                onChangeText={setWeightText}
                keyboardType="decimal-pad"
                placeholder="Today’s weight"
                placeholderTextColor={theme.textSecondary}
                returnKeyType="done"
                onSubmitEditing={submitWeight}
              />
              <Pressable
                style={[styles.weightButton, { backgroundColor: MacroColors.kcal }]}
                onPress={submitWeight}>
                <ThemedText type="smallBold" style={styles.weightButtonText}>
                  Log
                </ThemedText>
              </Pressable>
            </View>
            <ThemedText type="small" themeColor="textSecondary">
              Use whichever unit you like — just stay consistent.
            </ThemedText>
          </ThemedView>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

/** Trailing 7-day moving average over logged days only; 0 where no data yet. */
function movingAverage(days: DayTotal[], sel: (d: DayTotal) => number, window = 7): number[] {
  return days.map((_, i) => {
    const slice = days.slice(Math.max(0, i - window + 1), i + 1).filter((d) => d.logged);
    if (slice.length === 0) return 0;
    return slice.reduce((s, d) => s + sel(d), 0) / slice.length;
  });
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: selected ? theme.backgroundSelected : theme.backgroundElement,
          borderColor: selected ? MacroColors.kcal : 'transparent',
        },
      ]}>
      <ThemedText type="small" themeColor={selected ? 'text' : 'textSecondary'}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <ThemedView type="backgroundElement" style={styles.statCard}>
      <ThemedText type="smallBold">{value}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {sub}
      </ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
  },
  safeArea: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  content: {
    padding: Spacing.three,
    paddingBottom: BottomTabInset + Spacing.five,
    gap: Spacing.three,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderWidth: 1,
  },
  chartCard: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  chartHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  emptyChart: {
    textAlign: 'center',
    paddingVertical: Spacing.five,
  },
  statsRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  statCard: {
    flex: 1,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: 2,
  },
  weightRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    alignItems: 'center',
  },
  weightInput: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  weightButton: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  weightButtonText: {
    color: '#ffffff',
  },
});
