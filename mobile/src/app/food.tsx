import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { todayKey } from '@/lib/dates';
import { getFoodByRef } from '@/lib/foods';
import { logFood } from '@/lib/log';
import { fmtGrams, fmtKcal, parseDecimal, scaleMacros } from '@/lib/macros';
import { MEAL_LABELS, MEALS, type FoodItem, type MealType } from '@/lib/types';

export default function FoodScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ ref: string; day?: string; meal?: string }>();
  const day = params.day ?? todayKey();

  const [food, setFood] = useState<FoodItem | null>(null);
  const [missing, setMissing] = useState(false);
  const [amountText, setAmountText] = useState('100');
  // 0 = grams; i+1 = food.portions[i]
  const [unitIdx, setUnitIdx] = useState(0);
  const [meal, setMeal] = useState<MealType>((params.meal as MealType) ?? 'snack');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!params.ref) return;
    getFoodByRef(params.ref).then((f) => {
      if (!f) {
        setMissing(true);
        return;
      }
      setFood(f);
      // Default to the first household portion when one exists
      if (f.portions.length > 0) {
        setUnitIdx(1);
        setAmountText('1');
      }
    });
  }, [params.ref]);

  if (missing) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText themeColor="textSecondary">This food could not be loaded.</ThemedText>
      </ThemedView>
    );
  }
  if (!food) return <ThemedView style={styles.center} />;

  const amount = parseDecimal(amountText);
  const gramsPerUnit = unitIdx === 0 ? 1 : food.portions[unitIdx - 1].grams;
  const grams = amount != null ? amount * gramsPerUnit : null;
  const preview = grams != null ? scaleMacros(food.per100, grams) : null;

  const unitLabel = food.unit ?? 'g';
  const quantityDesc =
    unitIdx === 0
      ? `${fmtGrams(amount)} ${unitLabel}`
      : `${fmtGrams(amount)} × ${food.portions[unitIdx - 1].label}`;

  const log = async () => {
    if (grams == null || grams <= 0 || saving) return;
    setSaving(true);
    try {
      await logFood(food, { day, meal, grams, quantityDesc });
      router.dismissAll();
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ThemedView style={styles.root}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <ThemedText type="default" style={styles.name}>
            {food.name}
            {food.brand ? ` (${food.brand})` : ''}
          </ThemedText>
          {food.category && (
            <ThemedText type="small" themeColor="textSecondary">
              {food.category}
            </ThemedText>
          )}

          {/* Amount + unit */}
          <View style={styles.amountRow}>
            <TextInput
              style={[
                styles.amountInput,
                { backgroundColor: theme.backgroundElement, color: theme.text },
              ]}
              value={amountText}
              onChangeText={setAmountText}
              keyboardType="decimal-pad"
              selectTextOnFocus
            />
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.unitChips}>
                <UnitChip
                  label={unitLabel}
                  selected={unitIdx === 0}
                  onPress={() => {
                    setUnitIdx(0);
                    setAmountText('100');
                  }}
                />
                {food.portions.map((p, i) => (
                  <UnitChip
                    key={i}
                    label={`${p.label} (${fmtGrams(p.grams)} ${unitLabel})`}
                    selected={unitIdx === i + 1}
                    onPress={() => {
                      setUnitIdx(i + 1);
                      setAmountText('1');
                    }}
                  />
                ))}
              </View>
            </ScrollView>
          </View>

          {/* Nutrition preview */}
          <ThemedView type="backgroundElement" style={styles.previewCard}>
            <PreviewCell label="Calories" value={preview ? fmtKcal(preview.kcal) : '–'} color={MacroColors.kcal} />
            <PreviewCell label="Protein" value={preview ? `${fmtGrams(preview.protein)} g` : '–'} color={MacroColors.protein} />
            <PreviewCell label="Carbs" value={preview ? `${fmtGrams(preview.carbs)} g` : '–'} color={MacroColors.carbs} />
            <PreviewCell label="Fat" value={preview ? `${fmtGrams(preview.fat)} g` : '–'} color={MacroColors.fat} />
          </ThemedView>
          {preview && (preview.fiber != null || preview.sodiumMg != null) && (
            <ThemedText type="small" themeColor="textSecondary">
              {preview.fiber != null ? `Fiber ${fmtGrams(preview.fiber)} g` : ''}
              {preview.fiber != null && preview.sodiumMg != null ? ' · ' : ''}
              {preview.sodiumMg != null ? `Sodium ${fmtKcal(preview.sodiumMg)} mg` : ''}
            </ThemedText>
          )}

          {/* Meal selector */}
          <View style={styles.mealChips}>
            {MEALS.map((m) => (
              <UnitChip
                key={m}
                label={MEAL_LABELS[m]}
                selected={meal === m}
                onPress={() => setMeal(m)}
              />
            ))}
          </View>

          <Pressable
            style={[
              styles.logButton,
              { backgroundColor: MacroColors.kcal, opacity: grams != null && grams > 0 ? 1 : 0.4 },
            ]}
            onPress={log}>
            <ThemedText type="smallBold" style={styles.logButtonText}>
              {saving ? 'Logging…' : 'Log food'}
            </ThemedText>
          </Pressable>
        </ScrollView>
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

function UnitChip({
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

function PreviewCell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.previewCell}>
      <ThemedText type="smallBold" style={{ color }}>
        {value}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
  },
  name: {
    fontWeight: '700',
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  amountInput: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    fontSize: 18,
    minWidth: 80,
    textAlign: 'center',
  },
  unitChips: {
    flexDirection: 'row',
    gap: Spacing.two,
    alignItems: 'center',
  },
  chip: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderWidth: 1,
  },
  previewCard: {
    flexDirection: 'row',
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
  previewCell: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  mealChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  logButton: {
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.two,
  },
  logButtonText: {
    color: '#ffffff',
  },
});
