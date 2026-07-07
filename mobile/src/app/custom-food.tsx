import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
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
import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { createCustomFood } from '@/lib/foods';
import { parseDecimal } from '@/lib/macros';
import type { Portion } from '@/lib/types';

/**
 * Manual food creation. Nutrition values are entered per 100 g; an optional
 * serving (label + gram weight) becomes a selectable portion when logging.
 */
export default function CustomFoodScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{
    day?: string;
    meal?: string;
    barcode?: string;
    prefillName?: string;
  }>();

  const [name, setName] = useState(params.prefillName ?? '');
  const [brand, setBrand] = useState('');
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [fiber, setFiber] = useState('');
  const [sugar, setSugar] = useState('');
  const [sodium, setSodium] = useState('');
  const [servingLabel, setServingLabel] = useState('');
  const [servingGrams, setServingGrams] = useState('');
  const [unit, setUnit] = useState<'g' | 'ml'>('g');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const kcalNum = parseDecimal(kcal);
    if (!name.trim() || kcalNum == null) {
      Alert.alert('Missing info', `A name and calories (per 100 ${unit}) are required.`);
      return;
    }
    const portions: Portion[] = [];
    const sg = parseDecimal(servingGrams);
    if (sg != null && sg > 0) {
      portions.push({ label: servingLabel.trim() || '1 serving', grams: sg });
    }
    setSaving(true);
    try {
      const food = await createCustomFood({
        name,
        brand: brand || null,
        per100: {
          kcal: kcalNum,
          protein: parseDecimal(protein) ?? 0,
          carbs: parseDecimal(carbs) ?? 0,
          fat: parseDecimal(fat) ?? 0,
          fiber: parseDecimal(fiber),
          sugar: parseDecimal(sugar),
          sodiumMg: parseDecimal(sodium),
        },
        portions,
        barcode: params.barcode ?? null,
        unit,
      });
      if (params.day && params.meal) {
        router.replace({
          pathname: '/food',
          params: { ref: food.ref, day: params.day, meal: params.meal },
        });
      } else {
        router.back();
      }
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = [
    styles.input,
    { backgroundColor: theme.backgroundElement, color: theme.text },
  ];

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ThemedView style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {params.barcode && (
            <ThemedText type="small" themeColor="textSecondary">
              Barcode {params.barcode} — this product wasn’t in Open Food Facts, so enter its
              label info once and it will scan instantly next time.
            </ThemedText>
          )}

          <Field label="Name *">
            <TextInput
              style={inputStyle}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Protein pancake mix"
              placeholderTextColor={theme.textSecondary}
            />
          </Field>
          <Field label="Brand">
            <TextInput style={inputStyle} value={brand} onChangeText={setBrand} />
          </Field>

          <View style={styles.unitToggleRow}>
            <ThemedText type="smallBold" style={styles.sectionTitle}>
              Nutrition per 100 {unit}
            </ThemedText>
            <View style={styles.unitChips}>
              {(['g', 'ml'] as const).map((u) => (
                <Pressable
                  key={u}
                  onPress={() => setUnit(u)}
                  style={[
                    styles.unitChip,
                    {
                      backgroundColor:
                        unit === u ? theme.backgroundSelected : theme.backgroundElement,
                      borderColor: unit === u ? MacroColors.kcal : 'transparent',
                    },
                  ]}>
                  <ThemedText type="small" themeColor={unit === u ? 'text' : 'textSecondary'}>
                    {u}
                  </ThemedText>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={styles.grid}>
            <NumField label="Calories *" value={kcal} onChange={setKcal} style={inputStyle} />
            <NumField label="Protein (g)" value={protein} onChange={setProtein} style={inputStyle} />
            <NumField label="Carbs (g)" value={carbs} onChange={setCarbs} style={inputStyle} />
            <NumField label="Fat (g)" value={fat} onChange={setFat} style={inputStyle} />
            <NumField label="Fiber (g)" value={fiber} onChange={setFiber} style={inputStyle} />
            <NumField label="Sugar (g)" value={sugar} onChange={setSugar} style={inputStyle} />
            <NumField label="Sodium (mg)" value={sodium} onChange={setSodium} style={inputStyle} />
          </View>

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Serving size (optional)
          </ThemedText>
          <View style={styles.servingRow}>
            <View style={styles.servingLabel}>
              <NumFieldWrapper label="Label">
                <TextInput
                  style={inputStyle}
                  value={servingLabel}
                  onChangeText={setServingLabel}
                  placeholder="1 scoop"
                  placeholderTextColor={theme.textSecondary}
                />
              </NumFieldWrapper>
            </View>
            <View style={styles.servingGrams}>
              <NumField label="Grams" value={servingGrams} onChange={setServingGrams} style={inputStyle} />
            </View>
          </View>

          <Pressable
            style={[styles.saveButton, { backgroundColor: MacroColors.kcal }]}
            onPress={save}
            disabled={saving}>
            <ThemedText type="smallBold" style={styles.saveText}>
              {saving ? 'Saving…' : 'Save food'}
            </ThemedText>
          </Pressable>
        </ScrollView>
      </ThemedView>
    </KeyboardAvoidingView>
  );
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

function NumFieldWrapper({ label, children }: { label: string; children: React.ReactNode }) {
  return <Field label={label}>{children}</Field>;
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
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
    paddingBottom: Spacing.six,
  },
  field: {
    gap: Spacing.one,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  sectionTitle: {
    marginTop: Spacing.two,
  },
  unitToggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  unitChips: {
    flexDirection: 'row',
    gap: Spacing.one,
  },
  unitChip: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderWidth: 1,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  numField: {
    width: '31%',
    flexGrow: 1,
  },
  servingRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  servingLabel: { flex: 2 },
  servingGrams: { flex: 1 },
  saveButton: {
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.three,
  },
  saveText: { color: '#ffffff' },
});
