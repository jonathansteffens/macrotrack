import { router, useLocalSearchParams } from 'expo-router';
import { AmountInput } from '@/components/amount-input';
import { energyLabel, formatAmount } from '@/lib/units';
import { useUnitPrefs } from '@/hooks/use-unit-prefs';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { FoodSearchModal } from '@/components/food-search-modal';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  deleteEntry,
  getEntry,
  updateEntryFood,
  updateEntryMacros,
  updateEntryMeal,
  updateEntryQuantity,
} from '@/lib/log';
import { getFoodByRef } from '@/lib/foods';
import { fmtGrams, fmtKcal, parseDecimal, rescaleMacros } from '@/lib/macros';
import {
  nutrientValue,
  trackedNutrientLine,
  trackedNutrients,
  type NutrientKey,
} from '@/lib/nutrients';
import { getTracking, type TrackingConfig } from '@/lib/tracking';
import { MEAL_LABELS, MEALS, type FoodItem, type LogEntry, type MealType } from '@/lib/types';

export default function EntryScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const [entry, setEntry] = useState<LogEntry | null>(null);
  // The entry's source food, when it still resolves — its portions let the
  // amount edit in the food's own units ("2 thin slices"), not just oz/g.
  const [food, setFood] = useState<FoodItem | null>(null);
  const [gramsText, setGramsText] = useState('');
  const [meal, setMeal] = useState<MealType>('snack');
  const [searchOpen, setSearchOpen] = useState(false);
  // Direct nutrition editing — the escape hatch when the SOURCE data was wrong
  // (bad OFF entry, off USDA row, AI estimate). null → not editing; fields are
  // absolute values for the entry at its current amount, keyed by the TRACKED
  // nutrient set (whichever nutrients the user picked are their editable set).
  const [macroEdit, setMacroEdit] = useState<Partial<Record<NutrientKey, string>> | null>(null);
  const [trackingCfg, setTrackingCfg] = useState<TrackingConfig | null>(null);
  useEffect(() => {
    getTracking().then(setTrackingCfg);
  }, []);

  useEffect(() => {
    getEntry(Number(params.id)).then((e) => {
      if (!e) return;
      setEntry(e);
      setMeal(e.meal);
      if (e.grams != null) setGramsText(fmtGrams(e.grams));
      if (e.foodRef) getFoodByRef(e.foodRef).then(setFood);
    });
  }, [params.id]);

  // Every hook must run before the loading guard below, or the hook order
  // changes the moment `entry` arrives.
  const unitPrefs = useUnitPrefs();

  if (!entry) return <ThemedView style={styles.center} />;

  const newGrams = parseDecimal(gramsText);
  const preview =
    entry.grams != null && newGrams != null && entry.grams > 0
      ? rescaleMacros(entry.macros, newGrams / entry.grams)
      : entry.macros;

  const save = async () => {
    if (entry.grams != null && newGrams != null && newGrams > 0 && newGrams !== entry.grams) {
      await updateEntryQuantity(
        entry.id,
        newGrams,
        formatAmount(newGrams, {
          name: entry.foodName,
          match: food,
          prefs: unitPrefs,
          liquid: entry.unit === 'ml',
        }).primary
      );
    }
    // Typed nutrition wins over any amount rescale above: the user's numbers
    // are absolute for the entry as displayed. Unparseable fields keep the
    // previewed value rather than silently zeroing a nutrient.
    if (macroEdit) {
      const values: Partial<Record<NutrientKey, number>> = {};
      for (const n of trackedNutrients(trackingCfg)) {
        const typed = macroEdit[n.key];
        values[n.key] = (typed != null ? parseDecimal(typed) : null) ?? nutrientValue(preview, n.key);
      }
      await updateEntryMacros(entry.id, values);
    }
    if (meal !== entry.meal) {
      await updateEntryMeal(entry.id, meal);
    }
    router.back();
  };

  // Wrong-food fix: swap the underlying food, keeping the logged amount.
  const changeFood = async (food: FoodItem) => {
    await updateEntryFood(entry.id, food);
    const updated = await getEntry(entry.id);
    if (updated) {
      setEntry(updated);
      setGramsText(updated.grams != null ? fmtGrams(updated.grams) : '');
    }
    setSearchOpen(false);
  };

  const confirmDelete = () => {
    Alert.alert('Delete entry', `Remove "${entry.foodName}" from this day?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteEntry(entry.id);
          router.back();
        },
      },
    ]);
  };

  return (
    <ThemedView style={styles.root}>
      <ThemedText type="default" style={styles.name}>
        {entry.foodName}
      </ThemedText>
      <View style={styles.subRow}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.flex}>
          Logged as {entry.quantityDesc}
        </ThemedText>
        <Pressable hitSlop={8} onPress={() => setSearchOpen(true)}>
          <ThemedText type="small" themeColor="tint">
            Change food
          </ThemedText>
        </Pressable>
      </View>

      {entry.grams != null ? (
        <>
          <View style={styles.gramsRow}>
            <ThemedText type="small" themeColor="textSecondary">
              Amount
            </ThemedText>
            {/* Denominated in the entry's own unit rather than grams. A logged
                entry keeps no FoodItem, so the classification runs off its name
                plus its own `unit` — enough for "2 servings" or "3 nuggets"
                instead of making the user do the arithmetic. */}
            <AmountInput
              grams={newGrams}
              onGramsChange={(g) => {
                setGramsText(g == null ? '' : fmtGrams(g));
                // A changed amount makes any open nutrition edit stale — the
                // rescaling preview is the truth again. Without this reset,
                // the snapshot fields would overwrite the rescale on save
                // (the "changed 1 oz to 4 oz, macros didn't move" bug).
                setMacroEdit(null);
              }}
              name={entry.foodName}
              match={food}
              liquid={entry.unit === 'ml'}
            />
          </View>
        </>
      ) : (
        <ThemedText type="small" themeColor="textSecondary">
          This entry has no gram weight, so its amount can’t be edited.
        </ThemedText>
      )}

      <ThemedView type="backgroundElement" style={styles.previewCard}>
        {macroEdit == null ? (
          <View style={styles.previewRow}>
            <ThemedText type="small" style={styles.flex}>
              {trackedNutrientLine(preview, trackingCfg, energyLabel(unitPrefs))}
            </ThemedText>
            <Pressable
              hitSlop={8}
              onPress={() =>
                setMacroEdit(
                  Object.fromEntries(
                    trackedNutrients(trackingCfg).map((n) => {
                      const v = nutrientValue(preview, n.key);
                      const text =
                        n.key === 'kcal'
                          ? fmtKcal(v)
                          : n.unit === 'mg'
                            ? String(Math.round(v))
                            : fmtGrams(v);
                      return [n.key, text];
                    })
                  )
                )
              }>
              <ThemedText type="small" themeColor="tint">
                Edit
              </ThemedText>
            </Pressable>
          </View>
        ) : (
          <View style={styles.macroGrid}>
            {trackedNutrients(trackingCfg).map((n) => (
              <View key={n.key} style={styles.macroField}>
                <ThemedText type="small" themeColor="textSecondary">
                  {n.key === 'kcal' ? 'Calories' : `${n.label}${n.unit ? ` (${n.unit})` : ''}`}
                </ThemedText>
                <TextInput
                  style={[
                    styles.macroInput,
                    { backgroundColor: theme.background, color: theme.text },
                  ]}
                  value={macroEdit[n.key] ?? ''}
                  onChangeText={(v) => setMacroEdit((m) => (m ? { ...m, [n.key]: v } : m))}
                  keyboardType="decimal-pad"
                  selectTextOnFocus
                />
              </View>
            ))}
            <Pressable hitSlop={8} style={styles.macroCancel} onPress={() => setMacroEdit(null)}>
              <ThemedText type="small" themeColor="textSecondary">
                Cancel edit
              </ThemedText>
            </Pressable>
          </View>
        )}
      </ThemedView>

      <View style={styles.mealChips}>
        {MEALS.map((m) => (
          <Pressable
            key={m}
            onPress={() => setMeal(m)}
            style={[
              styles.chip,
              {
                backgroundColor: meal === m ? theme.tintSurface : theme.backgroundElement,
                borderColor: meal === m ? theme.tint : 'transparent',
              },
            ]}>
            <ThemedText type="small" themeColor={meal === m ? 'tint' : 'textSecondary'}>
              {MEAL_LABELS[m]}
            </ThemedText>
          </Pressable>
        ))}
      </View>

      <Pressable style={[styles.saveButton, { backgroundColor: theme.tintSolid }]} onPress={save}>
        <ThemedText type="smallBold" style={styles.saveText}>
          Save
        </ThemedText>
      </Pressable>
      <Pressable style={styles.deleteButton} onPress={confirmDelete}>
        <ThemedText type="smallBold" style={{ color: theme.danger }}>
          Delete entry
        </ThemedText>
      </Pressable>

      {searchOpen && (
        <FoodSearchModal
          title="Change food"
          initialQuery={entry.foodName}
          onSelect={changeFood}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    padding: Spacing.three,
    gap: Spacing.three,
  },
  center: { flex: 1 },
  flex: { flex: 1 },
  name: { fontWeight: '700' },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  gramsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  gramsInput: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 18,
    minWidth: 100,
    textAlign: 'center',
  },
  previewCard: {
    borderRadius: Radius.card,
    padding: Spacing.three,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  macroGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    alignItems: 'flex-end',
  },
  macroField: {
    gap: Spacing.one,
    width: '22%',
    flexGrow: 1,
  },
  macroInput: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    fontSize: 16,
    textAlign: 'center',
  },
  macroCancel: {
    width: '100%',
    alignItems: 'center',
    paddingTop: Spacing.one,
  },
  mealChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderWidth: 1,
  },
  saveButton: {
    borderRadius: Radius.control,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.two,
  },
  saveText: { color: '#ffffff' },
  deleteButton: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
});
