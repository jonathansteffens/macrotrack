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

import { PortionAnchors } from '@/components/portion-anchors';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { todayKey } from '@/lib/dates';
import { getFoodByRef } from '@/lib/foods';
import { useUnitPrefs } from '@/hooks/use-unit-prefs';
import { defaultAmountUnit, formatAmountValue, gramsToUnit } from '@/lib/units';
import { logFood } from '@/lib/log';
import { fmtGrams, fmtKcal, parseDecimal, scaleMacros } from '@/lib/macros';
import { NUTRIENTS, type NutrientKey } from '@/lib/nutrients';
import { getTracking, type TrackingConfig } from '@/lib/tracking';
import {
  MEAL_LABELS,
  MEALS,
  mealForTime,
  type FoodItem,
  type Macros,
  type MealType,
  type Portion,
} from '@/lib/types';

/** Grams per ounce — the amount field can be entered in oz for weight foods. */
const OZ_TO_G = 28.3495;

/** One preview value in the nutrient's own display format. */
function previewValue(m: Macros | null, key: NutrientKey, unit: string): string {
  if (!m) return '–';
  const v = m[key] ?? 0;
  if (key === 'kcal') return fmtKcal(v);
  return unit === 'mg' ? `${Math.round(v)} mg` : `${fmtGrams(v)} ${unit}`;
}

/** The portion's noun for unit words and chips: "serving(s)", "egg(s)",
 *  "cup(s)". Gram equivalents live behind the grams chip, not in labels. */
function portionNoun(p: Portion, plural: boolean): string {
  if (p.label.startsWith('1 serving')) return plural ? 'servings' : 'serving';
  const noun = p.label.replace(/^1\s+/, '');
  return plural && !noun.endsWith('s') ? `${noun}s` : noun;
}

/**
 * The descriptive half of an OFF serving label, minus the gram restatement:
 * "1 serving (0.5 package (55g))" → "0.5 package". Null when the label
 * carries no description beyond the weight ("1 serving (237.0g)").
 */
function servingMeaning(p: Portion): string | null {
  const m = /^1 serving \((.+)\)$/.exec(p.label);
  if (!m) return null;
  const text = m[1].replace(/\s*\(?\d+(?:\.\d+)?\s*(?:g|ml)\s*\)?\s*$/i, '').trim();
  return text || null;
}

export default function FoodScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ ref: string; day?: string; meal?: string }>();
  const day = params.day ?? todayKey();

  const [food, setFood] = useState<FoodItem | null>(null);
  const [missing, setMissing] = useState(false);
  // Only the nutrients the user tracks appear in the preview (their choice in
  // onboarding/Settings governs this screen too, not just Today/Trends).
  const [tracking, setTracking] = useState<TrackingConfig | null>(null);
  useEffect(() => {
    getTracking().then(setTracking);
  }, []);
  const [amountText, setAmountText] = useState('100');
  // 0 = grams; i+1 = food.portions[i]
  const [unitIdx, setUnitIdx] = useState(0);
  // A portion the DB does not carry but the units classifier knows about (a
  // per-piece weight from the curated table). Presented exactly like a real
  // portion so it flows through the same chip/conversion path.
  const [syntheticPortion, setSyntheticPortion] = useState<{ label: string; grams: number } | null>(
    null
  );
  // No meal in the params (e.g. quick actions) → guess from the time of day.
  const [meal, setMeal] = useState<MealType>(() => (params.meal as MealType) ?? mealForTime());
  const [saving, setSaving] = useState(false);
  const unitPrefs = useUnitPrefs();
  const [showDetails, setShowDetails] = useState(false);
  // Enter the base amount in grams or ounces (weight foods only). Logs always
  // store grams — this only changes how the number is typed/shown.
  const [weighUnit, setWeighUnit] = useState<'g' | 'oz' | 'floz'>('g');

  useEffect(() => {
    if (!params.ref) return;
    getFoodByRef(params.ref).then((f) => {
      if (!f) {
        setMissing(true);
        return;
      }
      setFood(f);
      // A stated portion is still the best default — it is the food's own unit.
      if (f.portions.length > 0) {
        setUnitIdx(1);
        setAmountText('1');
        return;
      }
      // Otherwise fall to the units classifier rather than a bare "100 g":
      // a countable food opens in pieces, a drink in fl oz, a US solid in oz.
      // 100 g is only right when nothing better is known, or Settings says so.
      const nat = defaultAmountUnit({ name: f.name, match: f, prefs: unitPrefs });
      if (nat.choice === 'piece' || nat.choice === 'serving') {
        // Express it as a synthetic portion so the existing chip machinery
        // (gramsPerUnit = portion.grams) carries it unchanged.
        setSyntheticPortion({ label: nat.label.replace(/s$/, ''), grams: nat.perUnit ?? 0 });
        setUnitIdx(1);
        setAmountText('1');
      } else if (nat.choice === 'oz' || nat.choice === 'floz') {
        setWeighUnit(nat.choice);
        const v = gramsToUnit(100, nat.choice, null);
        setAmountText(v == null ? '100' : formatAmountValue(v, nat.choice));
      }
    });
    // unitPrefs is read to seed the default unit ONCE, as the food loads.
    // Depending on it would re-run this loader whenever a unit preference
    // changed, resetting an amount the user had already typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.ref]);

  if (missing) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText themeColor="textSecondary">This food couldn’t be loaded.</ThemedText>
      </ThemedView>
    );
  }
  if (!food) return <ThemedView style={styles.center} />;

  // The DB's portions, or the classifier-derived one when the DB has none.
  const portions = food.portions.length > 0 ? food.portions : syntheticPortion ? [syntheticPortion] : [];
  const amount = parseDecimal(amountText);
  const unitLabel = food.unit ?? 'g';
  const WEIGH_G: Record<'g' | 'oz' | 'floz', number> = { g: 1, oz: OZ_TO_G, floz: 29.5735 };
  const baseGrams = WEIGH_G[weighUnit];
  const gramsPerUnit = unitIdx === 0 ? baseGrams : (portions[unitIdx - 1]?.grams ?? 1);
  const grams = amount != null ? amount * gramsPerUnit : null;
  const preview = grams != null ? scaleMacros(food.per100, grams) : null;

  const canLog = grams != null && grams > 0 && !saving;
  const quantityDesc =
    unitIdx === 0
      ? `${fmtGrams(amount)} ${weighUnit === 'g' ? unitLabel : weighUnit === 'oz' ? 'oz' : 'fl oz'}`
      : `${fmtGrams(amount)} × ${portions[unitIdx - 1]?.label ?? unitLabel}`;

  // Unit switches convert the typed number in place — the amount the user
  // expressed is preserved, only its denomination changes.
  const switchToPortion = (i: number) => {
    if (unitIdx === i + 1) return;
    const per = portions[i].grams;
    setAmountText(grams != null && per > 0 ? fmtGrams(grams / per) : '1');
    setUnitIdx(i + 1);
  };
  const switchToBase = (u: 'g' | 'oz' | 'floz') => {
    if (unitIdx === 0 && weighUnit === u) return;
    setAmountText(grams != null ? fmtGrams(grams / WEIGH_G[u]) : '100');
    setUnitIdx(0);
    setWeighUnit(u);
  };

  // Default action dismisses the whole add flow (done). "Log another" instead
  // returns to a fresh Add-food search with this same meal preselected, so
  // logging several items in one sitting doesn't mean re-navigating each time.
  const log = async (again: boolean) => {
    if (grams == null || grams <= 0 || saving) return;
    setSaving(true);
    try {
      await logFood(food, { day, meal, grams, quantityDesc });
      router.dismissAll();
      if (again) router.push({ pathname: '/add', params: { day, meal } });
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
            {food.displayName ?? food.name}
            {food.brand ? ` (${food.brand})` : ''}
          </ThemedText>
          {food.category && (
            <ThemedText type="small" themeColor="textSecondary">
              {food.category}
            </ThemedText>
          )}
          {/* OFF is crowdsourced and sometimes wrong in undetectable ways —
              only the person holding the label can fix it (see correct-food). */}
          {food.source === 'barcode' && (
            <Pressable
              hitSlop={6}
              onPress={() =>
                router.push({
                  pathname: '/correct-food',
                  params: { ref: food.ref, day, meal },
                })
              }>
              <ThemedText type="small" themeColor="textSecondary">
                {food.userEdited
                  ? 'Corrected from label ✓ · edit'
                  : 'Wrong nutrition? Fix from the label ›'}
              </ThemedText>
            </Pressable>
          )}
          {food.source === 'custom' && (
            <Pressable
              hitSlop={6}
              onPress={() =>
                router.push({
                  pathname: '/custom-food',
                  params: { editRef: food.ref, day, meal },
                })
              }>
              <ThemedText type="small" themeColor="textSecondary">
                Edit this food ›
              </ThemedText>
            </Pressable>
          )}
          {/* Plain name leads; the canonical DB name is tucked behind a
              disclosure for anyone who wants to verify the source. */}
          {food.displayName && food.displayName !== food.name && (
            <View style={styles.details}>
              <Pressable hitSlop={6} onPress={() => setShowDetails((v) => !v)}>
                <ThemedText type="small" themeColor="textSecondary">
                  Details {showDetails ? '▴' : '▾'}
                </ThemedText>
              </Pressable>
              {showDetails && (
                <ThemedText type="small" themeColor="textSecondary">
                  USDA name: {food.name}
                </ThemedText>
              )}
            </View>
          )}

          {/* Amount: number + its unit word, nothing else on the row. The
              caption appears only when a label serving has a real description
              ("1 serving = 0.5 package") — never as default "X = N g" text.
              All unit switching lives in the single "Enter in" row below. */}
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
            <ThemedText type="small" themeColor="textSecondary">
              {unitIdx === 0
                ? unitLabel === 'ml'
                  ? 'ml'
                  : weighUnit === 'g'
                    ? 'g'
                    : weighUnit === 'oz'
                      ? 'oz'
                      : 'fl oz'
                : portionNoun(portions[unitIdx - 1], amount !== 1)}
            </ThemedText>
          </View>
          {unitIdx > 0 &&
            (() => {
              const p = portions[unitIdx - 1];
              const meaning = p.label.startsWith('1 serving') ? servingMeaning(p) : null;
              return meaning ? (
                <ThemedText type="small" themeColor="textSecondary">
                  1 serving = {meaning}
                </ThemedText>
              ) : null;
            })()}
          <View style={styles.weighToggle}>
            <ThemedText type="small" themeColor="textSecondary">
              Enter in
            </ThemedText>
            {portions.map((p, i) => (
              <UnitChip
                key={`p${i}`}
                label={portionNoun(p, true)}
                selected={unitIdx === i + 1}
                onPress={() => switchToPortion(i)}
              />
            ))}
            {unitLabel === 'g' ? (
              <>
                <UnitChip
                  label="grams"
                  selected={unitIdx === 0 && weighUnit === 'g'}
                  onPress={() => switchToBase('g')}
                />
                <UnitChip
                  label="oz"
                  selected={unitIdx === 0 && weighUnit === 'oz'}
                  onPress={() => switchToBase('oz')}
                />
                <UnitChip
                  label="fl oz"
                  selected={unitIdx === 0 && weighUnit === 'floz'}
                  onPress={() => switchToBase('floz')}
                />
              </>
            ) : (
              <UnitChip
                label="ml"
                selected={unitIdx === 0}
                onPress={() => switchToBase('g')}
              />
            )}
          </View>
          <PortionAnchors />

          {/* Nutrition preview — every TRACKED nutrient gets the same cell
              treatment (no big-four/fine-print split: whichever four the user
              picked ARE their big four). Wraps beyond one row. Calories is the
              fallback so the card can never be empty. */}
          <ThemedView type="backgroundElement" style={styles.previewCard}>
            {(() => {
              const cells = NUTRIENTS.filter(
                (n) => tracking?.[n.key].enabled ?? n.defaultEnabled
              );
              const shown = cells.length > 0 ? cells : NUTRIENTS.filter((n) => n.key === 'kcal');
              return shown.map((n) => (
                <PreviewCell
                  key={n.key}
                  label={n.label}
                  value={previewValue(preview, n.key, n.unit)}
                  color={n.color}
                />
              ));
            })()}
          </ThemedView>

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

          <View style={styles.logRow}>
            <Pressable
              style={[
                styles.logAnotherButton,
                { backgroundColor: theme.backgroundElement, opacity: canLog ? 1 : 0.4 },
              ]}
              disabled={!canLog}
              onPress={() => log(true)}>
              <ThemedText type="smallBold" themeColor="textSecondary">
                Log another
              </ThemedText>
            </Pressable>
            <Pressable
              style={[
                styles.logButton,
                { backgroundColor: theme.tintSolid, opacity: canLog ? 1 : 0.4 },
              ]}
              disabled={!canLog}
              onPress={() => log(false)}>
              <ThemedText type="smallBold" style={styles.logButtonText}>
                {saving ? 'Logging…' : 'Log food'}
              </ThemedText>
            </Pressable>
          </View>
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
          backgroundColor: selected ? theme.tintSurface : theme.backgroundElement,
          borderColor: selected ? theme.tint : 'transparent',
        },
      ]}>
      <ThemedText type="small" themeColor={selected ? 'tint' : 'textSecondary'}>
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
  details: {
    gap: 2,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  weighToggle: {
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
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderWidth: 1,
  },
  previewCard: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: Spacing.three,
    borderRadius: Radius.card,
    padding: Spacing.three,
  },
  previewCell: {
    // Fixed quarter-width (not flex) so a fifth tracked nutrient wraps into a
    // clean second row instead of squeezing the first.
    width: '25%',
    alignItems: 'center',
    gap: 2,
  },
  mealChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  logRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  logAnotherButton: {
    flex: 1,
    borderRadius: Radius.control,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  logButton: {
    flex: 2,
    borderRadius: Radius.control,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  logButtonText: {
    color: '#ffffff',
  },
});
