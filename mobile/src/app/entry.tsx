import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { FoodSearchModal } from '@/components/food-search-modal';
import { FractionChips } from '@/components/fraction-chips';
import { PortionAnchors } from '@/components/portion-anchors';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  deleteEntry,
  getEntry,
  updateEntryFood,
  updateEntryMeal,
  updateEntryQuantity,
} from '@/lib/log';
import { fmtGrams, fmtKcal, parseDecimal, rescaleMacros } from '@/lib/macros';
import { MEAL_LABELS, MEALS, type FoodItem, type LogEntry, type MealType } from '@/lib/types';

export default function EntryScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const [entry, setEntry] = useState<LogEntry | null>(null);
  const [gramsText, setGramsText] = useState('');
  const [meal, setMeal] = useState<MealType>('snack');
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    getEntry(Number(params.id)).then((e) => {
      if (!e) return;
      setEntry(e);
      setMeal(e.meal);
      if (e.grams != null) setGramsText(fmtGrams(e.grams));
    });
  }, [params.id]);

  if (!entry) return <ThemedView style={styles.center} />;

  const newGrams = parseDecimal(gramsText);
  const preview =
    entry.grams != null && newGrams != null && entry.grams > 0
      ? rescaleMacros(entry.macros, newGrams / entry.grams)
      : entry.macros;

  const save = async () => {
    if (entry.grams != null && newGrams != null && newGrams > 0 && newGrams !== entry.grams) {
      await updateEntryQuantity(entry.id, newGrams, `${fmtGrams(newGrams)} ${entry.unit ?? 'g'}`);
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
          <ThemedText type="small" style={{ color: MacroColors.kcal }}>
            Change food
          </ThemedText>
        </Pressable>
      </View>

      {entry.grams != null ? (
        <>
          <View style={styles.gramsRow}>
            <ThemedText type="small" themeColor="textSecondary">
              Amount ({entry.unit ?? 'g'})
            </ThemedText>
            <TextInput
              style={[
                styles.gramsInput,
                { backgroundColor: theme.backgroundElement, color: theme.text },
              ]}
              value={gramsText}
              onChangeText={setGramsText}
              keyboardType="decimal-pad"
              selectTextOnFocus
            />
          </View>
          <FractionChips value={newGrams} onValue={(v) => setGramsText(fmtGrams(v))} />
          <PortionAnchors />
        </>
      ) : (
        <ThemedText type="small" themeColor="textSecondary">
          This entry has no gram weight, so its amount can’t be edited.
        </ThemedText>
      )}

      <ThemedView type="backgroundElement" style={styles.previewCard}>
        <ThemedText type="small">
          {fmtKcal(preview.kcal)} kcal · P {fmtGrams(preview.protein)} g · C{' '}
          {fmtGrams(preview.carbs)} g · F {fmtGrams(preview.fat)} g
        </ThemedText>
      </ThemedView>

      <View style={styles.mealChips}>
        {MEALS.map((m) => (
          <Pressable
            key={m}
            onPress={() => setMeal(m)}
            style={[
              styles.chip,
              {
                backgroundColor: meal === m ? theme.backgroundSelected : theme.backgroundElement,
                borderColor: meal === m ? MacroColors.kcal : 'transparent',
              },
            ]}>
            <ThemedText type="small" themeColor={meal === m ? 'text' : 'textSecondary'}>
              {MEAL_LABELS[m]}
            </ThemedText>
          </Pressable>
        ))}
      </View>

      <Pressable style={[styles.saveButton, { backgroundColor: MacroColors.kcal }]} onPress={save}>
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
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
  mealChips: {
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
  saveButton: {
    borderRadius: Spacing.three,
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
