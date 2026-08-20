import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
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

import { AmountInput } from '@/components/amount-input';
import { EstimatingIndicator } from '@/components/estimating-indicator';
import { SpeechTextInput } from '@/components/speech-text-input';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { localEstimate } from '@/lib/ai/local';
import { ensureLoaded } from '@/lib/ai/local-model';
import { displayName, resolveClaim, type ResolvedItem } from '@/lib/ai/resolver';
import { FoodSearchModal } from '@/components/food-search-modal';
import { getFoodByRef } from '@/lib/foods';
import { takePendingIngredient } from '@/lib/pending-ingredient';
import { fmtGrams, fmtKcal, parseDecimal } from '@/lib/macros';
import {
  deleteRecipe,
  getRecipe,
  recipeItemFromFood,
  recipeItemFromEstimate,
  recipeItemFromManual,
  recipePerServing,
  recipeServingGrams,
  recipeTotalGrams,
  recipeTotals,
  saveRecipe,
  servingsForServingGrams,
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // AI ingredient entry: a whole ingredient list at once, parsed by the same
  // estimator (and the same quantity hybrid) the assist flow uses — so "1 lb
  // ground beef" becomes 454 g here for the same reason it does there.
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  // Serving size can be driven from either side: the count the batch makes, or
  // the weight of one serving. Whichever the user last typed is authoritative.
  const [servingGramsText, setServingGramsText] = useState('');
  // Manual ingredient entry: the escape hatch for anything the database has
  // never heard of and the model cannot place — a jar of something regional, a
  // supplement, a friend's sauce. Typed straight in, no library entry required.
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({
    name: '', grams: '', kcal: '', protein: '', carbs: '', fat: '',
  });
  // Labels state macros per serving far more often than per 100 g, so let the
  // user say which they are copying instead of making them do the arithmetic.
  const [manualBasis, setManualBasis] = useState<'amount' | 'per100'>('amount');
  // Warm the model while the user is still adding ingredients by hand.
  useEffect(() => {
    ensureLoaded();
  }, []);

  useEffect(() => {
    if (editId == null) return;
    getRecipe(editId).then((r) => {
      if (!r) return;
      setName(r.name);
      setServingsText(String(r.servings));
      setItems(r.items.map((it) => ({ ...it, gramsText: fmtGrams(it.grams) })));
    });
  }, [editId]);

  const addIngredient = (food: FoodItem) => {
    setItems((prev) => [...prev, { ...recipeItemFromFood(food, 100), gramsText: '100' }]);
  };

  // A barcode scanned in ingredient mode lands here when the scanner pops
  // back (see lib/pending-ingredient.ts).
  useFocusEffect(
    useCallback(() => {
      const ref = takePendingIngredient();
      if (!ref) return;
      getFoodByRef(ref).then((food) => {
        if (food) addIngredient(food);
      });
    }, [])
  );

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
  const totalGrams = recipeTotalGrams(draft);
  const servingGrams = recipeServingGrams(draft);
  const canSave = name.trim().length > 0 && items.some((it) => it.grams > 0);

  /** Typing a per-serving weight re-derives the servings count from the batch. */
  const setServingGrams = (text: string) => {
    setServingGramsText(text);
    const g = parseDecimal(text);
    if (g == null) return;
    const n = servingsForServingGrams(draft, g);
    if (n != null && n > 0) setServingsText(String(n));
  };

  const setManualField = (k: keyof typeof manual, v: string) =>
    setManual((prev) => ({ ...prev, [k]: v }));

  const manualGrams = parseDecimal(manual.grams);
  const canAddManual = manual.name.trim().length > 0 && manualGrams != null && manualGrams > 0;

  /** Add a typed-in ingredient (conversion lives in recipeItemFromManual). */
  const addManual = () => {
    if (!canAddManual || manualGrams == null) return;
    const n = (v: string) => parseDecimal(v) ?? 0;
    const item = recipeItemFromManual({
      name: manual.name,
      grams: manualGrams,
      basis: manualBasis,
      macros: {
        kcal: n(manual.kcal), protein: n(manual.protein),
        carbs: n(manual.carbs), fat: n(manual.fat),
      },
    });
    if (!item) return;
    setItems((prev) => [...prev, { ...item, gramsText: fmtGrams(item.grams) }]);
    setManual({ name: '', grams: '', kcal: '', protein: '', carbs: '', fat: '' });
    setManualOpen(false);
  };

  /** Parse a free-text ingredient list and append everything it resolves. */
  const addWithAi = async () => {
    const text = aiText.trim();
    if (!text || aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const res = await localEstimate([{ role: 'user', input: { text } }]);
      if (!res.ok) {
        setAiError(res.message);
        return;
      }
      // Same resolution path as the assist flow, so ingredients match the DB the
      // same way and the quantity override applies to the amounts.
      const resolved: ResolvedItem[] = await resolveClaim(res.claim, text);
      const added = resolved
        .filter((r) => r.grams > 0)
        .map((r) =>
          recipeItemFromEstimate({
            name: displayName(r),
            grams: r.grams,
            match: r.match,
            estPer100: r.claim.est_per100,
          })
        );
      if (added.length === 0) {
        setAiError('Nothing recognisable in that list — try naming amounts.');
        return;
      }
      setItems((prev) => [...prev, ...added.map((it) => ({ ...it, gramsText: fmtGrams(it.grams) }))]);
      setAiText('');
    } catch (e) {
      setAiError(e instanceof Error ? e.message : 'Could not read that ingredient list.');
    } finally {
      setAiBusy(false);
    }
  };

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
              Serving size
            </ThemedText>
            <View style={styles.servingRow}>
              <View style={styles.servingCol}>
                <ThemedText type="small" themeColor="textSecondary">
                  Makes
                </ThemedText>
                <TextInput
                  style={[...inputStyle, styles.servingsInput]}
                  value={servingsText}
                  onChangeText={setServingsText}
                  keyboardType="decimal-pad"
                  selectTextOnFocus
                />
              </View>
              <View style={styles.servingCol}>
                <ThemedText type="small" themeColor="textSecondary">
                  Each serving (g)
                </ThemedText>
                {/* The two are the same fact from either end: typing a weight
                    re-derives the count from the batch, and adding an ingredient
                    updates the weight. Whichever the user typed last wins. */}
                <TextInput
                  style={[...inputStyle, styles.servingsInput]}
                  value={servingGramsText || (servingGrams > 0 ? fmtGrams(servingGrams) : '')}
                  onChangeText={setServingGrams}
                  keyboardType="decimal-pad"
                  selectTextOnFocus
                  placeholder={servingGrams > 0 ? fmtGrams(servingGrams) : '—'}
                  placeholderTextColor={theme.textSecondary}
                />
              </View>
            </View>
            {totalGrams > 0 && (
              <ThemedText type="small" themeColor="textSecondary">
                Batch weighs {fmtGrams(totalGrams)} g — one serving is{' '}
                {fmtGrams(servingGrams)} g.
              </ThemedText>
            )}
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
              {/* Denominated in the ingredient's own unit; the batch total
                  still sums grams, which is what AmountInput reports back. */}
              <AmountInput
                compact
                grams={it.grams}
                onGramsChange={(g) => setItemGrams(idx, g == null ? '' : String(g))}
                name={it.foodName}
              />
            </ThemedView>
          ))}

          {/* Add a whole ingredient list at once, via the on-device estimator */}
          <View style={styles.field}>
            <ThemedText type="small" themeColor="textSecondary">
              Or paste the whole ingredient list
            </ThemedText>
            {/* SpeechTextInput owns its own styling and mic affordance, so it
                takes only content props — same usage as the assist screen. */}
            <SpeechTextInput
              value={aiText}
              onChangeText={setAiText}
              placeholder={'1 lb ground beef, 2 cans black beans, an onion'}
              multiline
            />
            <Pressable
              style={[
                styles.aiButton,
                { backgroundColor: theme.tintSurface, opacity: aiText.trim() && !aiBusy ? 1 : 0.4 },
              ]}
              onPress={addWithAi}
              disabled={!aiText.trim() || aiBusy}>
              <ThemedText type="smallBold" themeColor="tint">
                {aiBusy ? 'Reading…' : 'Add ingredients with AI'}
              </ThemedText>
            </Pressable>
            {aiBusy && <EstimatingIndicator />}
            {aiError != null && (
              <ThemedText type="small" style={{ color: theme.danger }}>
                {aiError}
              </ThemedText>
            )}
            <ThemedText type="small" themeColor="textSecondary">
              Every ingredient it adds stays editable, and anything it can&rsquo;t
              match keeps the model&rsquo;s own estimate.
            </ThemedText>
          </View>

          {/* Ingredient search: the app's ONE search experience (same modal as
              Add-food and the entry editor), not a homegrown inline list. The
              modal stays open after each pick so several ingredients can be
              added in one visit. */}
          <View style={styles.ingredientButtons}>
            <Pressable
              style={[styles.searchButton, styles.flex, { backgroundColor: theme.backgroundElement }]}
              onPress={() => setSearchOpen(true)}>
              <ThemedText type="smallBold" themeColor="tint">
                🔍 Search
              </ThemedText>
            </Pressable>
            <Pressable
              style={[styles.searchButton, styles.flex, { backgroundColor: theme.backgroundElement }]}
              onPress={() => router.push({ pathname: '/scan', params: { intent: 'ingredient' } })}>
              <ThemedText type="smallBold" themeColor="tint">
                📷 Scan
              </ThemedText>
            </Pressable>
          </View>
          {searchOpen && (
            <FoodSearchModal
              title="Add ingredient"
              onSelect={(f) => addIngredient(f)}
              onClose={() => setSearchOpen(false)}
            />
          )}

          {/* Manual entry — for ingredients neither the database nor the model
              can place. Kept collapsed so it does not crowd the two paths that
              need less typing. */}
          {!manualOpen ? (
            <Pressable onPress={() => setManualOpen(true)} style={styles.manualToggle}>
              <ThemedText type="smallBold" themeColor="tint">
                + Enter an ingredient manually
              </ThemedText>
            </Pressable>
          ) : (
            <ThemedView type="backgroundElement" style={styles.manualCard}>
              <View style={styles.itemHeader}>
                <ThemedText type="smallBold" style={styles.flex}>
                  Manual ingredient
                </ThemedText>
                <Pressable hitSlop={8} onPress={() => setManualOpen(false)}>
                  <ThemedText type="small" themeColor="textSecondary">
                    ✕
                  </ThemedText>
                </Pressable>
              </View>

              <TextInput
                style={[styles.input, { backgroundColor: theme.background, color: theme.text }]}
                value={manual.name}
                onChangeText={(t) => setManualField('name', t)}
                placeholder="Ingredient name"
                placeholderTextColor={theme.textSecondary}
              />
              <View style={styles.manualRow}>
                <ThemedText type="small" themeColor="textSecondary" style={styles.manualLabel}>
                  Amount (g)
                </ThemedText>
                <TextInput
                  style={[styles.gramsInput, { backgroundColor: theme.background, color: theme.text }]}
                  value={manual.grams}
                  onChangeText={(t) => setManualField('grams', t)}
                  keyboardType="decimal-pad"
                  selectTextOnFocus
                />
              </View>

              <ThemedText type="small" themeColor="textSecondary">
                Nutrition as written on the label
              </ThemedText>
              <View style={styles.manualChips}>
                {(['amount', 'per100'] as const).map((b) => (
                  <Pressable
                    key={b}
                    onPress={() => setManualBasis(b)}
                    style={[
                      styles.chip,
                      {
                        backgroundColor:
                          manualBasis === b ? theme.tintSurface : theme.background,
                        borderColor: manualBasis === b ? theme.tint : 'transparent',
                      },
                    ]}>
                    <ThemedText
                      type="small"
                      themeColor={manualBasis === b ? 'tint' : 'textSecondary'}>
                      {b === 'amount' ? 'For this amount' : 'Per 100 g'}
                    </ThemedText>
                  </Pressable>
                ))}
              </View>
              <View style={styles.manualRow}>
                {([
                  ['kcal', 'kcal'],
                  ['protein', 'P (g)'],
                  ['carbs', 'C (g)'],
                  ['fat', 'F (g)'],
                ] as const).map(([key, label]) => (
                  <View key={key} style={styles.manualMacro}>
                    <ThemedText type="small" themeColor="textSecondary">
                      {label}
                    </ThemedText>
                    <TextInput
                      style={[styles.macroInput, { backgroundColor: theme.background, color: theme.text }]}
                      value={manual[key]}
                      onChangeText={(t) => setManualField(key, t)}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                    />
                  </View>
                ))}
              </View>

              <Pressable
                style={[
                  styles.aiButton,
                  { backgroundColor: theme.tintSurface, opacity: canAddManual ? 1 : 0.4 },
                ]}
                onPress={addManual}
                disabled={!canAddManual}>
                <ThemedText type="smallBold" themeColor="tint">
                  Add ingredient
                </ThemedText>
              </Pressable>
              <ThemedText type="small" themeColor="textSecondary">
                Leave a macro blank for zero — useful for water, salt and spices.
              </ThemedText>
            </ThemedView>
          )}

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
            style={[styles.saveButton, { backgroundColor: theme.tintSolid, opacity: canSave ? 1 : 0.4 }]}
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
  servingRow: { flexDirection: 'row', gap: Spacing.three },
  servingCol: { gap: Spacing.one },
  aiButton: { borderRadius: Radius.control, paddingVertical: Spacing.two, alignItems: 'center' },
  manualToggle: { paddingVertical: Spacing.two },
  searchButton: {
    borderRadius: Radius.card,
    padding: Spacing.three,
    alignItems: 'center',
  },
  ingredientButtons: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  manualCard: { borderRadius: Radius.card, padding: Spacing.three, gap: Spacing.two },
  manualRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  manualLabel: { minWidth: 84 },
  manualChips: { flexDirection: 'row', gap: Spacing.two },
  manualMacro: { flex: 1, gap: Spacing.one },
  macroInput: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    fontSize: 16,
    textAlign: 'center',
  },
  chip: {
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  sectionTitle: { marginTop: Spacing.two },
  itemCard: { borderRadius: Radius.card, padding: Spacing.three, gap: Spacing.two },
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
  totalsCard: { borderRadius: Radius.card, padding: Spacing.three, gap: Spacing.one },
  saveButton: {
    borderRadius: Radius.control,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.two,
  },
  saveText: { color: '#ffffff' },
  deleteButton: { alignItems: 'center', paddingVertical: Spacing.two },
});
