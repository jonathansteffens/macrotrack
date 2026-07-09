import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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

import { FoodRow } from '@/components/food-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { searchFoods } from '@/lib/foods';
import { fmtGrams, fmtKcal, parseDecimal } from '@/lib/macros';
import {
  deleteRecipe,
  getRecipe,
  recipeItemFromFood,
  recipePerServing,
  recipeTotals,
  saveRecipe,
  type Recipe,
  type RecipeItem,
} from '@/lib/recipes';
import type { FoodItem } from '@/lib/types';

type EditorItem = RecipeItem & { gramsText: string };

export default function RecipeScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ id?: string }>();
  const editId = params.id ? Number(params.id) : undefined;

  const [name, setName] = useState('');
  const [servingsText, setServingsText] = useState('1');
  const [items, setItems] = useState<EditorItem[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FoodItem[]>([]);
  const [saving, setSaving] = useState(false);
  const searchId = useRef(0);

  useEffect(() => {
    if (editId == null) return;
    getRecipe(editId).then((r) => {
      if (!r) return;
      setName(r.name);
      setServingsText(String(r.servings));
      setItems(r.items.map((it) => ({ ...it, gramsText: fmtGrams(it.grams) })));
    });
  }, [editId]);

  useEffect(() => {
    const id = ++searchId.current;
    const q = query.trim();
    const t = setTimeout(
      async () => {
        const found = q ? await searchFoods(q, 15) : [];
        if (searchId.current === id) setResults(found);
      },
      q ? 200 : 0
    );
    return () => clearTimeout(t);
  }, [query]);

  const addIngredient = (food: FoodItem) => {
    setItems((prev) => [...prev, { ...recipeItemFromFood(food, 100), gramsText: '100' }]);
    setQuery('');
    setResults([]);
  };

  const setItemGrams = (idx: number, text: string) => {
    const g = parseDecimal(text);
    setItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, gramsText: text, grams: g ?? 0 } : it))
    );
  };

  const removeItem = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));

  const servings = parseDecimal(servingsText) ?? 1;
  const draft: Recipe = { id: editId ?? 0, name, servings, items };
  const total = recipeTotals(draft);
  const perServing = recipePerServing(draft);
  const canSave = name.trim().length > 0 && items.some((it) => it.grams > 0);

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await saveRecipe({
        id: editId,
        name,
        servings,
        items: items
          .filter((it) => it.grams > 0)
          .map(({ foodName, foodRef, grams, per100 }) => ({ foodName, foodRef, grams, per100 })),
      });
      router.back();
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = () => {
    if (editId == null) return;
    Alert.alert('Delete recipe', `Remove “${name}”?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteRecipe(editId);
          router.back();
        },
      },
    ]);
  };

  const inputStyle = [styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }];

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ThemedView style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.field}>
            <ThemedText type="small" themeColor="textSecondary">
              Recipe name
            </ThemedText>
            <TextInput
              style={inputStyle}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Weeknight chili"
              placeholderTextColor={theme.textSecondary}
            />
          </View>

          <View style={styles.field}>
            <ThemedText type="small" themeColor="textSecondary">
              Servings the whole recipe makes
            </ThemedText>
            <TextInput
              style={[...inputStyle, styles.servingsInput]}
              value={servingsText}
              onChangeText={setServingsText}
              keyboardType="decimal-pad"
              selectTextOnFocus
            />
          </View>

          {/* Ingredients */}
          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Ingredients
          </ThemedText>
          {items.length === 0 && (
            <ThemedText type="small" themeColor="textSecondary">
              Search below and tap a food to add it.
            </ThemedText>
          )}
          {items.map((it, idx) => (
            <ThemedView key={idx} type="backgroundElement" style={styles.itemCard}>
              <View style={styles.itemHeader}>
                <ThemedText type="small" numberOfLines={2} style={styles.flex}>
                  {it.foodName}
                </ThemedText>
                <Pressable hitSlop={8} onPress={() => removeItem(idx)}>
                  <ThemedText type="small" themeColor="textSecondary">
                    ✕
                  </ThemedText>
                </Pressable>
              </View>
              <View style={styles.itemRow}>
                <TextInput
                  style={[styles.gramsInput, { backgroundColor: theme.background, color: theme.text }]}
                  value={it.gramsText}
                  onChangeText={(t) => setItemGrams(idx, t)}
                  keyboardType="decimal-pad"
                  selectTextOnFocus
                />
                <ThemedText type="small" themeColor="textSecondary">
                  g
                </ThemedText>
              </View>
            </ThemedView>
          ))}

          {/* Ingredient search */}
          <TextInput
            style={inputStyle}
            value={query}
            onChangeText={setQuery}
            placeholder="Add ingredient — search foods…"
            placeholderTextColor={theme.textSecondary}
            autoCorrect={false}
          />
          {results.map((f) => (
            <FoodRow key={f.ref} food={f} onPress={() => addIngredient(f)} />
          ))}

          {/* Totals */}
          {items.length > 0 && (
            <ThemedView type="backgroundElement" style={styles.totalsCard}>
              <ThemedText type="smallBold">Per serving (makes {servings})</ThemedText>
              <ThemedText type="small">
                {fmtKcal(perServing.kcal)} kcal · P {fmtGrams(perServing.protein)} g · C{' '}
                {fmtGrams(perServing.carbs)} g · F {fmtGrams(perServing.fat)} g
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                Whole recipe: {fmtKcal(total.kcal)} kcal · P {fmtGrams(total.protein)} · C{' '}
                {fmtGrams(total.carbs)} · F {fmtGrams(total.fat)}
              </ThemedText>
            </ThemedView>
          )}

          <Pressable
            style={[styles.saveButton, { backgroundColor: MacroColors.kcal, opacity: canSave ? 1 : 0.4 }]}
            onPress={save}
            disabled={!canSave}>
            <ThemedText type="smallBold" style={styles.saveText}>
              {saving ? 'Saving…' : 'Save recipe'}
            </ThemedText>
          </Pressable>

          {editId != null && (
            <Pressable style={styles.deleteButton} onPress={confirmDelete}>
              <ThemedText type="smallBold" style={{ color: theme.danger }}>
                Delete recipe
              </ThemedText>
            </Pressable>
          )}
        </ScrollView>
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.three, paddingBottom: Spacing.six },
  field: { gap: Spacing.one },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  servingsInput: { minWidth: 90, textAlign: 'center', alignSelf: 'flex-start' },
  sectionTitle: { marginTop: Spacing.two },
  itemCard: { borderRadius: Spacing.three, padding: Spacing.three, gap: Spacing.two },
  itemHeader: { flexDirection: 'row', gap: Spacing.two, alignItems: 'flex-start' },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  gramsInput: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    fontSize: 16,
    minWidth: 80,
    textAlign: 'center',
  },
  totalsCard: { borderRadius: Spacing.three, padding: Spacing.three, gap: Spacing.one },
  saveButton: {
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.two,
  },
  saveText: { color: '#ffffff' },
  deleteButton: { alignItems: 'center', paddingVertical: Spacing.two },
});
