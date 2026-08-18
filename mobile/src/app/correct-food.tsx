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
import { getFoodByRef } from '@/lib/foods';
import { parseDecimal } from '@/lib/macros';
import { correctBarcodeFood, resetBarcodeToOff } from '@/lib/off';
import type { FoodItem } from '@/lib/types';

/**
 * Fix a scanned product's nutrition from its label. Open Food Facts is
 * crowdsourced and sometimes wrong in ways no app-side check can catch (e.g.
 * per-serving values typed into the per-100 fields) — only the person holding
 * the can knows. Values are entered PER SERVING, the label's own terms; the
 * per-100 conversion happens here at the save boundary, and the corrected row
 * is marked authoritative so an OFF refresh can never overwrite it.
 */
export default function CorrectFoodScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ ref: string; day?: string; meal?: string }>();
  const barcode = params.ref?.startsWith('barcode:') ? params.ref.slice('barcode:'.length) : null;

  const [food, setFood] = useState<FoodItem | null>(null);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [servingGrams, setServingGrams] = useState('');
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [fiber, setFiber] = useState('');
  const [sugar, setSugar] = useState('');
  const [sodium, setSodium] = useState('');
  const [satFat, setSatFat] = useState('');
  const [cholesterol, setCholesterol] = useState('');
  const [calcium, setCalcium] = useState('');
  const [iron, setIron] = useState('');
  const [potassium, setPotassium] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!params.ref) return;
    getFoodByRef(params.ref).then((f) => {
      if (!f) return;
      setFood(f);
      setName(f.name);
      setBrand(f.brand ?? '');
      const sg = f.portions[0]?.grams ?? null;
      setServingGrams(sg != null ? fmtNum(sg) : '');
      // Prefill in the label's own terms: current per-100 scaled to a serving.
      const per = (v: number | null) =>
        v == null || sg == null ? '' : fmtNum((v * sg) / 100);
      setKcal(per(f.per100.kcal));
      setProtein(per(f.per100.protein));
      setCarbs(per(f.per100.carbs));
      setFat(per(f.per100.fat));
      setFiber(per(f.per100.fiber));
      setSugar(per(f.per100.sugar));
      setSodium(per(f.per100.sodiumMg));
      setSatFat(per(f.per100.satFat));
      setCholesterol(per(f.per100.cholesterolMg));
      setCalcium(per(f.per100.calciumMg));
      setIron(per(f.per100.ironMg));
      setPotassium(per(f.per100.potassiumMg));
    });
  }, [params.ref]);

  const backToFood = () => {
    // Replace rather than back: the food screen prefetches on mount, so a
    // fresh mount is what makes the corrected numbers visible immediately.
    router.replace({
      pathname: '/food',
      params: { ref: params.ref, day: params.day, meal: params.meal },
    });
  };

  const save = async () => {
    if (!barcode) return;
    const sg = parseDecimal(servingGrams);
    const kcalServ = parseDecimal(kcal);
    if (!name.trim() || sg == null || sg <= 0 || kcalServ == null) {
      Alert.alert(
        'Missing info',
        'A name, the serving size, and calories per serving are required.'
      );
      return;
    }
    // Per-serving → per-100 at the storage boundary (grams stay canonical).
    const per100 = (v: string): number | null => {
      const n = parseDecimal(v);
      return n == null ? null : (n * 100) / sg;
    };
    setSaving(true);
    try {
      await correctBarcodeFood(barcode, {
        name,
        brand: brand || null,
        per100: {
          kcal: (kcalServ * 100) / sg,
          protein: per100(protein) ?? 0,
          carbs: per100(carbs) ?? 0,
          fat: per100(fat) ?? 0,
          fiber: per100(fiber),
          sugar: per100(sugar),
          sodiumMg: per100(sodium),
          satFat: per100(satFat),
          cholesterolMg: per100(cholesterol),
          calciumMg: per100(calcium),
          ironMg: per100(iron),
          potassiumMg: per100(potassium),
        },
        servingGrams: sg,
        // Keep the descriptive OFF label ("2 bites (50 g)") only while the
        // weight still matches it — otherwise it would lie about the grams.
        servingLabel: food?.portions[0]?.grams === sg ? food.portions[0].label : undefined,
      });
      backToFood();
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (!barcode) return;
    Alert.alert(
      'Reset to Open Food Facts?',
      'Your corrections for this product will be discarded and its data re-downloaded.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            const result = await resetBarcodeToOff(barcode);
            if (result.status === 'found') backToFood();
            else
              Alert.alert(
                'Couldn’t re-download',
                'Open Food Facts wasn’t reachable (or no longer lists this product). Your correction was discarded; scan the product again to retry.'
              );
          },
        },
      ]
    );
  };

  if (!barcode) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText themeColor="textSecondary">
          Only scanned (barcode) foods can be corrected here.
        </ThemedText>
      </ThemedView>
    );
  }

  const unit = food?.unit ?? 'g';
  const inputStyle = [styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }];

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ThemedView style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <ThemedText type="small" themeColor="textSecondary">
            Type the numbers exactly as the nutrition label prints them — per serving. Your
            version wins over Open Food Facts for this product from now on.
          </ThemedText>

          <Field label="Name *">
            <TextInput style={inputStyle} value={name} onChangeText={setName} />
          </Field>
          <Field label="Brand">
            <TextInput style={inputStyle} value={brand} onChangeText={setBrand} />
          </Field>

          <Field label={`Serving size (${unit}) *`}>
            <TextInput
              style={inputStyle}
              value={servingGrams}
              onChangeText={setServingGrams}
              keyboardType="decimal-pad"
            />
          </Field>

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Nutrition per serving
          </ThemedText>
          <View style={styles.grid}>
            <NumField label="Calories *" value={kcal} onChange={setKcal} style={inputStyle} />
            <NumField label="Protein (g)" value={protein} onChange={setProtein} style={inputStyle} />
            <NumField label="Carbs (g)" value={carbs} onChange={setCarbs} style={inputStyle} />
            <NumField label="Fat (g)" value={fat} onChange={setFat} style={inputStyle} />
          </View>

          <Pressable
            style={[styles.moreButton, { backgroundColor: theme.backgroundElement }]}
            onPress={() => setShowMore((s) => !s)}>
            <ThemedText type="small">More nutrients (optional) {showMore ? '▴' : '▾'}</ThemedText>
          </Pressable>
          {showMore && (
            <View style={styles.grid}>
              <NumField label="Fiber (g)" value={fiber} onChange={setFiber} style={inputStyle} />
              <NumField label="Sugar (g)" value={sugar} onChange={setSugar} style={inputStyle} />
              <NumField label="Sodium (mg)" value={sodium} onChange={setSodium} style={inputStyle} />
              <NumField label="Sat fat (g)" value={satFat} onChange={setSatFat} style={inputStyle} />
              <NumField label="Cholesterol (mg)" value={cholesterol} onChange={setCholesterol} style={inputStyle} />
              <NumField label="Calcium (mg)" value={calcium} onChange={setCalcium} style={inputStyle} />
              <NumField label="Iron (mg)" value={iron} onChange={setIron} style={inputStyle} />
              <NumField label="Potassium (mg)" value={potassium} onChange={setPotassium} style={inputStyle} />
            </View>
          )}

          <Pressable
            style={[styles.saveButton, { backgroundColor: theme.tintSolid }]}
            onPress={save}
            disabled={saving}>
            <ThemedText type="smallBold" style={styles.saveText}>
              {saving ? 'Saving…' : 'Save correction'}
            </ThemedText>
          </Pressable>

          {food?.userEdited && (
            <Pressable style={styles.resetButton} hitSlop={8} onPress={reset}>
              <ThemedText type="small" themeColor="textSecondary">
                Reset to Open Food Facts data
              </ThemedText>
            </Pressable>
          )}
        </ScrollView>
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

/** Compact prefill formatting: at most one decimal, no float tails. */
function fmtNum(v: number): string {
  return String(Math.round(v * 10) / 10);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      {children}
    </View>
  );
}

function NumField({
  label,
  value,
  onChange,
  style,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  style: any;
}) {
  return (
    <View style={styles.numField}>
      <Field label={label}>
        <TextInput style={style} value={value} onChangeText={onChange} keyboardType="decimal-pad" />
      </Field>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
  sectionTitle: { marginTop: Spacing.two },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  moreButton: {
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    alignItems: 'center',
  },
  numField: {
    width: '31%',
    flexGrow: 1,
  },
  saveButton: {
    borderRadius: Radius.control,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.three,
  },
  saveText: { color: '#ffffff' },
  resetButton: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
});
