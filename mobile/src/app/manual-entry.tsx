import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
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
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { todayKey } from '@/lib/dates';
import { createCustomFood } from '@/lib/foods';
import { logManualEntry } from '@/lib/log';
import { parseDecimal } from '@/lib/macros';
import { NUTRIENTS, trackedNutrients, type NutrientKey } from '@/lib/nutrients';
import { getTracking, type TrackingConfig } from '@/lib/tracking';
import { mealForTime, type Macros, type MealType } from '@/lib/types';

/**
 * The quick way in: a name and the macros you know, nothing else — no brand,
 * no per-100g arithmetic, no library commitment. Fields are the user's TRACKED
 * nutrients (the rest behind "More"), values are absolute for what's being
 * logged. "Save to library" is the explicit opt-in that also stores it as a
 * reusable food (one serving = exactly these numbers).
 */
export default function ManualEntryScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ day?: string; meal?: string; prefillName?: string }>();
  const day = params.day ?? todayKey();
  const meal = (params.meal as MealType) ?? mealForTime();

  const [name, setName] = useState(params.prefillName ?? '');
  const [values, setValues] = useState<Partial<Record<NutrientKey, string>>>({});
  const [showMore, setShowMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [trackingCfg, setTrackingCfg] = useState<TrackingConfig | null>(null);
  useEffect(() => {
    getTracking().then(setTrackingCfg);
  }, []);

  const primary = trackedNutrients(trackingCfg);
  const primaryKeys = new Set(primary.map((n) => n.key));
  const more = NUTRIENTS.filter((n) => !primaryKeys.has(n.key));

  const buildMacros = (): Macros | null => {
    const num = (k: NutrientKey) => {
      const v = values[k];
      return v != null && v.trim() !== '' ? parseDecimal(v) : null;
    };
    const kcal = num('kcal');
    if (kcal == null) return null;
    return {
      kcal,
      protein: num('protein') ?? 0,
      carbs: num('carbs') ?? 0,
      fat: num('fat') ?? 0,
      fiber: num('fiber'),
      sugar: num('sugar'),
      sodiumMg: num('sodiumMg'),
      satFat: num('satFat'),
      cholesterolMg: num('cholesterolMg'),
      calciumMg: num('calciumMg'),
      ironMg: num('ironMg'),
      potassiumMg: num('potassiumMg'),
    };
  };

  const log = async (saveToLibrary: boolean) => {
    const macros = buildMacros();
    if (!name.trim() || macros == null) {
      Alert.alert('Missing info', 'A name and calories are required.');
      return;
    }
    setSaving(true);
    try {
      await logManualEntry({ day, meal, name, macros });
      if (saveToLibrary) {
        // One serving = exactly the entered numbers (stored per-100g with a
        // 100 g serving portion, so the arithmetic is the identity).
        await createCustomFood({
          name,
          per100: macros,
          portions: [{ label: '1 serving', grams: 100 }],
        });
      }
      router.back();
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = [styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }];

  const Field = ({ k, label }: { k: NutrientKey; label: string }) => (
    <View style={styles.numField}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <TextInput
        style={inputStyle}
        value={values[k] ?? ''}
        onChangeText={(v) => setValues((prev) => ({ ...prev, [k]: v }))}
        keyboardType="decimal-pad"
      />
    </View>
  );

  const labelFor = (n: (typeof NUTRIENTS)[number]) =>
    n.key === 'kcal' ? 'Calories *' : `${n.label}${n.unit ? ` (${n.unit})` : ''}`;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ThemedView style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <ThemedText type="small" themeColor="textSecondary">
            Log something with the numbers you already know. Nothing is saved for reuse
            unless you choose to.
          </ThemedText>

          <View style={styles.field}>
            <ThemedText type="small" themeColor="textSecondary">
              Name *
            </ThemedText>
            <TextInput
              style={inputStyle}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Aunt Rita’s casserole"
              placeholderTextColor={theme.textSecondary}
            />
          </View>

          <View style={styles.grid}>
            {primary.map((n) => (
              <Field key={n.key} k={n.key} label={labelFor(n)} />
            ))}
          </View>

          <Pressable
            style={[styles.moreButton, { backgroundColor: theme.backgroundElement }]}
            onPress={() => setShowMore((s) => !s)}>
            <ThemedText type="small">More nutrients {showMore ? '▴' : '▾'}</ThemedText>
          </Pressable>
          {showMore && (
            <View style={styles.grid}>
              {more.map((n) => (
                <Field key={n.key} k={n.key} label={labelFor(n)} />
              ))}
            </View>
          )}

          <Pressable
            style={[styles.logButton, { backgroundColor: theme.tintSolid }]}
            onPress={() => log(false)}
            disabled={saving}>
            <ThemedText type="smallBold" style={styles.logText}>
              {saving ? 'Logging…' : 'Log'}
            </ThemedText>
          </Pressable>
          <Pressable style={styles.saveLink} hitSlop={8} onPress={() => log(true)} disabled={saving}>
            <ThemedText type="small" themeColor="tint">
              Log and save to library
            </ThemedText>
          </Pressable>
        </ScrollView>
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
    paddingBottom: Spacing.six,
  },
  field: { gap: Spacing.one },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  numField: {
    width: '31%',
    flexGrow: 1,
    gap: Spacing.one,
  },
  moreButton: {
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    alignItems: 'center',
  },
  logButton: {
    borderRadius: Radius.control,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.two,
  },
  logText: { color: '#ffffff' },
  saveLink: {
    alignItems: 'center',
    paddingVertical: Spacing.one,
  },
});
