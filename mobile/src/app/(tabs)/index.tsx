import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DatePickerModal } from '@/components/date-picker-modal';
import { MacroBar } from '@/components/macro-bar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MacroColors, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { syncCheckinNotification } from '@/lib/checkin';
import { addDays, dayLabel, todayKey } from '@/lib/dates';
import { usualComboForMeal, type UsualCombo } from '@/lib/habits';
import { dayTotals, deleteEntries, entriesForDay, mealsLoggedOn, relogEntries } from '@/lib/log';
import { fmtKcal, ZERO_MACROS } from '@/lib/macros';
import { NUTRIENTS, nutrientValue } from '@/lib/nutrients';
import { saveTemplate } from '@/lib/templates';
import { defaultTracking, getTracking } from '@/lib/tracking';
import {
  MEAL_LABELS,
  MEALS,
  mealForTime,
  type LogEntry,
  type Macros,
  type MealType,
} from '@/lib/types';

/** A tiny provenance tag for an entry row, or null for plain DB/custom foods.
 *  Anything logged via the AI review flow gets "AI" — whether it fell back to
 *  the model's estimate (source/quantityDesc marker) or matched a DB food
 *  (origin marker) — before the barcode "scan" tag. */
function provenanceLabel(e: LogEntry): string | null {
  if (e.source === 'ai_estimate' || e.origin === 'assist' || e.quantityDesc.includes('(AI estimate)'))
    return 'AI';
  if (e.source === 'barcode') return 'scan';
  return null;
}

export default function TodayScreen() {
  const theme = useTheme();
  const [day, setDay] = useState(todayKey());
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [totals, setTotals] = useState<Macros>(ZERO_MACROS);
  const [tracking, setTracking] = useState(defaultTracking());
  // Repeat-logging affordances — only offered on the actual today.
  const [copyableMeals, setCopyableMeals] = useState<Set<MealType>>(new Set());
  const [usual, setUsual] = useState<UsualCombo | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  // Undo bar for the batch quick-logs (copy-yesterday / habit chip): the exact
  // ids just inserted, so Undo removes only those.
  const [undo, setUndo] = useState<{ ids: number[]; count: number } | null>(null);
  const relogging = useRef(false);

  const load = useCallback(async () => {
    const dayEntries = await entriesForDay(day);
    setEntries(dayEntries);
    setTotals(await dayTotals(day));
    setTracking(await getTracking());

    if (day === todayKey()) {
      setCopyableMeals(await mealsLoggedOn(addDays(day, -1)));
      // Habit chip: at most one, for the current time-of-day slot, only while
      // that meal is still empty today.
      const slot = mealForTime();
      const slotEmpty = !dayEntries.some((e) => e.meal === slot);
      setUsual(slotEmpty ? await usualComboForMeal(slot) : null);
      // Logging is what changes "logged today", and every log path returns
      // focus here — so this keeps the evening check-in suppressed correctly.
      syncCheckinNotification().catch(() => {});
    } else {
      setCopyableMeals(new Set());
      setUsual(null);
    }
  }, [day]);

  const relog = async (entriesToLog: LogEntry[], meal: MealType) => {
    if (relogging.current || entriesToLog.length === 0) return;
    relogging.current = true;
    try {
      const ids = await relogEntries(entriesToLog, day, meal);
      setUndo({ ids, count: ids.length });
      await load();
    } finally {
      relogging.current = false;
    }
  };

  const undoRelog = async () => {
    if (!undo) return;
    await deleteEntries(undo.ids);
    setUndo(null);
    await load();
  };

  // Auto-dismiss the undo bar after a few seconds.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(t);
  }, [undo]);

  // Changing the day dismisses a stale undo bar (its ids belong to another view).
  const goToDay = (next: string) => {
    setUndo(null);
    setDay(next);
  };

  const copyYesterday = async (meal: MealType) => {
    const yesterday = await entriesForDay(addDays(day, -1));
    await relog(
      yesterday.filter((e) => e.meal === meal),
      meal
    );
  };

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const kcalCfg = tracking.kcal;
  const remaining =
    kcalCfg.enabled && kcalCfg.goal != null ? kcalCfg.goal - totals.kcal : null;
  const enabledNutrients = NUTRIENTS.filter((n) => tracking[n.key].enabled);

  return (
    <ThemedView style={styles.root}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        {/* Date navigation header */}
        <View style={styles.header}>
          <Pressable hitSlop={12} onPress={() => goToDay(addDays(day, -1))}>
            <ThemedText type="subtitle" themeColor="textSecondary">
              ‹
            </ThemedText>
          </Pressable>
          <Pressable hitSlop={12} onPress={() => setCalendarOpen(true)}>
            <ThemedText type="default" style={styles.dayLabel}>
              {dayLabel(day)}
            </ThemedText>
          </Pressable>
          <Pressable hitSlop={12} onPress={() => goToDay(addDays(day, 1))}>
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
            {kcalCfg.enabled && (
              <View style={styles.kcalRow}>
                <ThemedText type="subtitle">{fmtKcal(totals.kcal)}</ThemedText>
                <ThemedText themeColor="textSecondary">
                  {kcalCfg.goal != null ? ` / ${fmtKcal(kcalCfg.goal)} kcal` : ' kcal'}
                </ThemedText>
                {remaining != null &&
                  (remaining >= 0 ? (
                    <View style={styles.remainingBox}>
                      <ThemedText type="small" themeColor="textSecondary">
                        {fmtKcal(remaining)} left
                      </ThemedText>
                    </View>
                  ) : (
                    <View style={[styles.overBadge, { borderColor: theme.danger }]}>
                      <ThemedText type="small" style={[styles.overText, { color: theme.danger }]}>
                        +{fmtKcal(-remaining)} over
                      </ThemedText>
                    </View>
                  ))}
              </View>
            )}
            {enabledNutrients.map((n) => (
              <MacroBar
                key={n.key}
                label={n.label}
                value={nutrientValue(totals, n.key)}
                goal={tracking[n.key].goal}
                color={n.color}
                unit={n.unit}
              />
            ))}
          </ThemedView>

          {/* Habit chip: one tap re-logs the combo this meal slot usually gets */}
          {usual && (
            <Pressable
              style={[styles.usualChip, { backgroundColor: theme.backgroundElement }]}
              onPress={() => relog(usual.entries, usual.meal)}>
              <ThemedText type="small">
                Log your usual {usual.meal}?{'  '}
                <ThemedText type="small" themeColor="textSecondary">
                  {usual.entries.map((e) => e.foodName.split(',')[0]).join(' + ')} ·{' '}
                  {fmtKcal(usual.kcal)} kcal
                </ThemedText>
              </ThemedText>
            </Pressable>
          )}

          {/* Undo the last batch quick-log */}
          {undo && (
            <View style={[styles.undoBar, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" themeColor="textSecondary" style={styles.flex}>
                Logged {undo.count} item{undo.count === 1 ? '' : 's'}
              </ThemedText>
              <Pressable hitSlop={8} onPress={undoRelog}>
                <ThemedText type="smallBold" style={{ color: MacroColors.kcal }}>
                  Undo
                </ThemedText>
              </Pressable>
            </View>
          )}

          {/* Meals */}
          {MEALS.map((meal) => (
            <MealSection
              key={meal}
              meal={meal}
              day={day}
              entries={entries.filter((e) => e.meal === meal)}
              canCopyYesterday={copyableMeals.has(meal)}
              onCopyYesterday={() => copyYesterday(meal)}
            />
          ))}

          <View style={styles.quickActions}>
            {/* AI + Scan pick no meal — the target screens guess one (AI
                meal_guess or time of day) and the entry editor can re-file it
                later. Manual Search defaults to the current time-of-day meal so
                a tapped result files sensibly. */}
            <Pressable
              style={[styles.quickAction, { backgroundColor: theme.backgroundElement }]}
              onPress={() => router.push({ pathname: '/assist', params: { day } })}>
              <ThemedText type="small">✨ Describe</ThemedText>
            </Pressable>
            <Pressable
              style={[styles.quickAction, { backgroundColor: theme.backgroundElement }]}
              onPress={() =>
                router.push({ pathname: '/add', params: { day, meal: mealForTime() } })
              }>
              <ThemedText type="small">🔍 Search</ThemedText>
            </Pressable>
            <Pressable
              style={[styles.quickAction, { backgroundColor: theme.backgroundElement }]}
              onPress={() => router.push({ pathname: '/scan', params: { day } })}>
              <ThemedText type="small">📷 Scan</ThemedText>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>

      {calendarOpen && (
        <DatePickerModal
          selected={day}
          onSelect={(d) => {
            goToDay(d);
            setCalendarOpen(false);
          }}
          onClose={() => setCalendarOpen(false)}
        />
      )}
    </ThemedView>
  );
}

function MealSection({
  meal,
  day,
  entries,
  canCopyYesterday,
  onCopyYesterday,
}: {
  meal: MealType;
  day: string;
  entries: LogEntry[];
  canCopyYesterday: boolean;
  onCopyYesterday: () => void;
}) {
  const theme = useTheme();
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
              <Pressable
                hitSlop={8}
                onPress={saveAsTemplate}
                accessibilityLabel="Save meal as a template">
                <ThemedText type="small" themeColor="textSecondary">
                  ☆ Save
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

      {/* Empty section + yesterday had this meal → one-tap repeat */}
      {entries.length === 0 && canCopyYesterday && (
        <Pressable style={styles.copyYesterday} hitSlop={4} onPress={onCopyYesterday}>
          <ThemedText type="small" themeColor="textSecondary">
            Copy yesterday’s {MEAL_LABELS[meal].toLowerCase()}
          </ThemedText>
        </Pressable>
      )}

      {entries.length > 0 && (
        <ThemedView type="backgroundElement" style={styles.entryCard}>
          {entries.map((e, i) => (
            <Pressable
              key={e.id}
              style={[styles.entryRow, i > 0 && styles.entryRowBorder]}
              onPress={() => router.push({ pathname: '/entry', params: { id: String(e.id) } })}>
              <View style={styles.entryText}>
                <View style={styles.entryNameRow}>
                  <ThemedText type="small" numberOfLines={1} style={styles.entryName}>
                    {e.foodName}
                  </ThemedText>
                  {provenanceLabel(e) && (
                    <View style={[styles.provChip, { backgroundColor: theme.backgroundSelected }]}>
                      <ThemedText type="small" themeColor="textSecondary" style={styles.provText}>
                        {provenanceLabel(e)}
                      </ThemedText>
                    </View>
                  )}
                </View>
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
  overBadge: {
    marginLeft: 'auto',
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
  mealSection: {
    gap: Spacing.two,
  },
  usualChip: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
  },
  copyYesterday: {
    paddingHorizontal: Spacing.one,
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
  entryNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  entryName: {
    flexShrink: 1,
  },
  provChip: {
    borderRadius: Spacing.one,
    paddingHorizontal: Spacing.one + 1,
    paddingVertical: 0,
  },
  provText: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
  },
  undoBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
  },
  flex: { flex: 1 },
  quickActions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  quickAction: {
    flex: 1,
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
});
