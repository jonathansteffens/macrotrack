import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BarChart } from '@/components/bar-chart';
import { SparkLine } from '@/components/spark-line';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MacroColors, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { addDays, shortLabel, todayKey } from '@/lib/dates';
import { parseDecimal } from '@/lib/macros';
import { NUTRIENTS, NUTRIENTS_BY_KEY, type NutrientKey } from '@/lib/nutrients';
import { defaultTracking, getTracking } from '@/lib/tracking';
import { getTrends, type DayTotal, type TrendSummary } from '@/lib/trends';
import { fmtWeight, logWeight, weightTrend, type WeightEntry } from '@/lib/weights';

const RANGES = [7, 30, 90] as const;

export default function TrendsScreen() {
  const theme = useTheme();
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [metric, setMetric] = useState<NutrientKey>('kcal');
  const [trends, setTrends] = useState<TrendSummary | null>(null);
  const [tracking, setTracking] = useState(defaultTracking());
  const [weight, setWeight] = useState<{
    series: number[];
    entries: WeightEntry[];
    change: number | null;
  } | null>(null);
  const [weightText, setWeightText] = useState('');
  const [weightDay, setWeightDay] = useState<'today' | 'yesterday'>('today');

  const loadWeight = useCallback(() => {
    weightTrend(range).then(setWeight);
  }, [range]);

  useFocusEffect(
    useCallback(() => {
      getTrends(range).then(setTrends);
      getTracking().then(setTracking);
      loadWeight();
    }, [range, loadWeight])
  );

  const submitWeight = async () => {
    const w = parseDecimal(weightText);
    if (w == null || w <= 0) return;
    const day = weightDay === 'yesterday' ? addDays(todayKey(), -1) : todayKey();
    await logWeight(w, day);
    setWeightText('');
    loadWeight();
  };

  const enabledNutrients = NUTRIENTS.filter((n) => tracking[n.key].enabled);
  // Fall back to the first tracked nutrient if the selected one was turned off.
  const activeKey: NutrientKey = enabledNutrients.some((n) => n.key === metric)
    ? metric
    : (enabledNutrients[0]?.key ?? 'kcal');
  const m = NUTRIENTS_BY_KEY[activeKey];
  const goal = tracking[activeKey].goal;
  const values = trends?.days.map((d) => d.values[activeKey]) ?? [];
  const labels = trends?.days.map((d) => shortLabel(d.day)) ?? [];
  const movingAvg = trends ? movingAverage(trends.days, (d) => d.values[activeKey]) : [];
  const avg = trends ? trends.averages[activeKey] : 0;
  const unitSuffix = m.unit ? ` ${m.unit}` : '';

  return (
    <ThemedView style={styles.root}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}>
          <View style={styles.titleRow}>
            <ThemedText type="subtitle" style={styles.flex}>
              Trends
            </ThemedText>
            <Pressable hitSlop={12} onPress={() => router.push('/settings')}>
              <ThemedText type="default" themeColor="textSecondary">
                ⚙
              </ThemedText>
            </Pressable>
          </View>

          {/* Range selector */}
          <View style={styles.chipRow}>
            {RANGES.map((r) => (
              <Chip key={r} label={`${r} days`} selected={range === r} onPress={() => setRange(r)} />
            ))}
          </View>

          {/* Metric selector — only the nutrients being tracked */}
          <View style={styles.chipRow}>
            {enabledNutrients.map((n) => (
              <Chip
                key={n.key}
                label={n.label}
                selected={activeKey === n.key}
                onPress={() => setMetric(n.key)}
              />
            ))}
          </View>

          {/* Chart */}
          <ThemedView type="backgroundElement" style={styles.chartCard}>
            <View style={styles.chartHeader}>
              <ThemedText type="smallBold">{m.label}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {goal != null ? 'goal (dashed) · ' : ''}7-day avg (line)
              </ThemedText>
            </View>
            {trends && trends.loggedDays > 0 ? (
              <BarChart
                values={values}
                labels={labels}
                color={m.color}
                goal={goal ?? undefined}
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
                value={`${Math.round(avg)}${unitSuffix}`}
                sub="on logged days"
              />
              <StatCard
                label="Days logged"
                value={`${trends.loggedDays}/${range}`}
                sub={`${Math.round((trends.loggedDays / range) * 100)}%`}
              />
              <StatCard
                label="Last 7 days"
                value={`${trends.loggedLast7} of 7`}
                sub="days logged"
              />
            </View>
          )}

          {/* Weight */}
          <ThemedView type="backgroundElement" style={styles.chartCard}>
            <View style={styles.chartHeader}>
              <ThemedText type="smallBold">Weight</ThemedText>
              {weight && weight.entries.length > 0 && (
                <ThemedText type="small" themeColor="textSecondary">
                  {fmtWeight(weight.entries[weight.entries.length - 1].weight)}
                  {weight.change != null &&
                    `  (${weight.change > 0 ? '+' : ''}${fmtWeight(weight.change)} over range)`}
                </ThemedText>
              )}
            </View>
            {weight && weight.entries.length > 1 && (
              <SparkLine values={weight.series} color={MacroColors.kcal} />
            )}
            <View style={styles.chipRow}>
              <Chip
                label="Today"
                selected={weightDay === 'today'}
                onPress={() => setWeightDay('today')}
              />
              <Chip
                label="Yesterday"
                selected={weightDay === 'yesterday'}
                onPress={() => setWeightDay('yesterday')}
              />
            </View>
            <View style={styles.weightRow}>
              <TextInput
                style={[
                  styles.weightInput,
                  { backgroundColor: theme.background, color: theme.text },
                ]}
                value={weightText}
                onChangeText={setWeightText}
                keyboardType="decimal-pad"
                placeholder={weightDay === 'yesterday' ? 'Yesterday’s weight' : 'Today’s weight'}
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
              Use any unit you like. Keep it consistent.
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
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  flex: { flex: 1 },
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
