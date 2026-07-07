import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MacroBar } from '@/components/macro-bar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MacroColors, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { addDays, dayLabel, todayKey } from '@/lib/dates';
import { getGoals } from '@/lib/goals';
import { dayTotals, entriesForDay } from '@/lib/log';
import { fmtKcal, ZERO_MACROS } from '@/lib/macros';
import { saveTemplate } from '@/lib/templates';
import {
  DEFAULT_GOALS,
  MEAL_LABELS,
  MEALS,
  type LogEntry,
  type Macros,
  type MealType,
} from '@/lib/types';

export default function TodayScreen() {
  const theme = useTheme();
  const [day, setDay] = useState(todayKey());
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [totals, setTotals] = useState<Macros>(ZERO_MACROS);
  const [goals, setGoals] = useState(DEFAULT_GOALS);

  const load = useCallback(async () => {
    setEntries(await entriesForDay(day));
    setTotals(await dayTotals(day));
    setGoals(await getGoals());
  }, [day]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const remaining = goals.kcal != null ? goals.kcal - totals.kcal : null;

  return (
    <ThemedView style={styles.root}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        {/* Date navigation header */}
        <View style={styles.header}>
          <Pressable hitSlop={12} onPress={() => setDay((d) => addDays(d, -1))}>
            <ThemedText type="subtitle" themeColor="textSecondary">
              ‹
            </ThemedText>
          </Pressable>
          <Pressable hitSlop={12} onPress={() => setDay(todayKey())}>
            <ThemedText type="default" style={styles.dayLabel}>
              {dayLabel(day)}
            </ThemedText>
          </Pressable>
          <Pressable hitSlop={12} onPress={() => setDay((d) => addDays(d, 1))}>
            <ThemedText type="subtitle" themeColor="textSecondary">
              ›
            </ThemedText>
          </Pressable>
          <Pressable
            hitSlop={12}
            style={styles.settingsButton}
            onPress={() => router.push('/settings')}>
            <ThemedText type="default" themeColor="textSecondary">
              ⚙
            </ThemedText>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}>
          {/* Summary card */}
          <ThemedView type="backgroundElement" style={styles.summaryCard}>
            <View style={styles.kcalRow}>
              <ThemedText type="subtitle">{fmtKcal(totals.kcal)}</ThemedText>
              <ThemedText themeColor="textSecondary">
                {goals.kcal != null ? ` / ${fmtKcal(goals.kcal)} kcal` : ' kcal'}
              </ThemedText>
              {remaining != null && (
                <View style={styles.remainingBox}>
                  <ThemedText
                    type="small"
                    themeColor="textSecondary"
                    style={remaining < 0 && { color: MacroColors.protein }}>
                    {remaining >= 0
                      ? `${fmtKcal(remaining)} left`
                      : `${fmtKcal(-remaining)} over`}
                  </ThemedText>
                </View>
              )}
            </View>
            <MacroBar label="Calories" value={totals.kcal} goal={goals.kcal} color={MacroColors.kcal} unit="" />
            <MacroBar label="Protein" value={totals.protein} goal={goals.protein} color={MacroColors.protein} />
            <MacroBar label="Carbs" value={totals.carbs} goal={goals.carbs} color={MacroColors.carbs} />
            <MacroBar label="Fat" value={totals.fat} goal={goals.fat} color={MacroColors.fat} />
            <MacroBar label="Fiber" value={totals.fiber ?? 0} goal={goals.fiber} color={MacroColors.fiber} />
          </ThemedView>

          {/* Meals */}
          {MEALS.map((meal) => (
            <MealSection
              key={meal}
              meal={meal}
              day={day}
              entries={entries.filter((e) => e.meal === meal)}
            />
          ))}

          <View style={styles.quickActions}>
            <Pressable
              style={[styles.scanButton, { backgroundColor: theme.backgroundElement }]}
              onPress={() => router.push({ pathname: '/assist', params: { day, meal: 'snack' } })}>
              <ThemedText type="small">✨ AI assistant</ThemedText>
            </Pressable>
            <Pressable
              style={[styles.scanButton, { backgroundColor: theme.backgroundElement }]}
              onPress={() => router.push({ pathname: '/scan', params: { day, meal: 'snack' } })}>
              <ThemedText type="small">📷 Scan barcode</ThemedText>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

function MealSection({
  meal,
  day,
  entries,
}: {
  meal: MealType;
  day: string;
  entries: LogEntry[];
}) {
  const mealKcal = entries.reduce((s, e) => s + e.macros.kcal, 0);

  const saveAsTemplate = () => {
    const name =
      `${MEAL_LABELS[meal]}: ${entries[0].foodName.split(',')[0]}` +
      (entries.length > 1 ? ` +${entries.length - 1}` : '');
    Alert.alert('Save template', `Save these ${entries.length} item(s) as “${name}”?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Save',
        onPress: async () => {
          await saveTemplate(name, entries);
          Alert.alert('Saved', 'Log it any time from the Add food screen.');
        },
      },
    ]);
  };

  return (
    <View style={styles.mealSection}>
      <View style={styles.mealHeader}>
        <ThemedText type="smallBold">{MEAL_LABELS[meal]}</ThemedText>
        <View style={styles.mealHeaderRight}>
          {entries.length > 0 && (
            <>
              <Pressable hitSlop={8} onPress={saveAsTemplate}>
                <ThemedText type="small" themeColor="textSecondary">
                  ☆
                </ThemedText>
              </Pressable>
              <ThemedText type="small" themeColor="textSecondary">
                {fmtKcal(mealKcal)} kcal
              </ThemedText>
            </>
          )}
          <Pressable
            hitSlop={8}
            onPress={() => router.push({ pathname: '/add', params: { day, meal } })}>
            <ThemedText type="smallBold" style={{ color: MacroColors.kcal }}>
              + Add
            </ThemedText>
          </Pressable>
        </View>
      </View>

      {entries.length > 0 && (
        <ThemedView type="backgroundElement" style={styles.entryCard}>
          {entries.map((e, i) => (
            <Pressable
              key={e.id}
              style={[styles.entryRow, i > 0 && styles.entryRowBorder]}
              onPress={() => router.push({ pathname: '/entry', params: { id: String(e.id) } })}>
              <View style={styles.entryText}>
                <ThemedText type="small" numberOfLines={1}>
                  {e.foodName}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {e.quantityDesc}
                </ThemedText>
              </View>
              <ThemedText type="small">{fmtKcal(e.macros.kcal)}</ThemedText>
            </Pressable>
          ))}
        </ThemedView>
      )}
    </View>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.four,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  dayLabel: {
    minWidth: 130,
    textAlign: 'center',
    fontWeight: '700',
  },
  settingsButton: {
    position: 'absolute',
    right: Spacing.three,
  },
  scrollContent: {
    paddingHorizontal: Spacing.three,
    paddingBottom: BottomTabInset + Spacing.five,
    gap: Spacing.three,
  },
  summaryCard: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  kcalRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: Spacing.one,
  },
  remainingBox: {
    marginLeft: 'auto',
  },
  mealSection: {
    gap: Spacing.two,
  },
  mealHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.one,
  },
  mealHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  entryCard: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.two + 2,
    gap: Spacing.three,
  },
  entryRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.3)',
  },
  entryText: {
    flex: 1,
    gap: 1,
  },
  quickActions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  scanButton: {
    flex: 1,
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
});
