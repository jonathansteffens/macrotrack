import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { FoodRow } from '@/components/food-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { dismissAiOffer, recordManualSearch, shouldShowAiOffer } from '@/lib/ai-offer';
import { todayKey } from '@/lib/dates';
import { recentFoods, searchFoods } from '@/lib/foods';
import { deleteEntries } from '@/lib/log';
import { fmtKcal } from '@/lib/macros';
import { listRecipes, recipePerServing, type Recipe } from '@/lib/recipes';
import {
  deleteTemplate,
  listTemplates,
  logTemplate,
  templateKcal,
  type MealTemplate,
} from '@/lib/templates';
import { mealForTime, type FoodItem, type MealType } from '@/lib/types';

export default function AddFoodScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ day?: string; meal?: string }>();
  const day = params.day ?? todayKey();
  // May be undefined — downstream screens guess a meal from the time of day.
  const meal = params.meal;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FoodItem[]>([]);
  const [recents, setRecents] = useState<FoodItem[]>([]);
  const [templates, setTemplates] = useState<MealTemplate[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [aiOffer, setAiOffer] = useState(false);
  // While searching, Recipes/Templates collapse behind a header+count so they
  // stay reachable without burying the food matches. Collapsed by default.
  const [expandRecipes, setExpandRecipes] = useState(false);
  const [expandTemplates, setExpandTemplates] = useState(false);
  const searchId = useRef(0);
  // The lifetime search counter bumps at most once per screen visit, so
  // keystroke-debounced re-searches don't inflate it.
  const countedSearch = useRef(false);
  // Inline undo for one-tap template logging: the exact ids just inserted, so
  // Undo removes only those. This screen owns the bar because the today
  // screen's undo state is local and unreachable across the navigation boundary.
  const [templateUndo, setTemplateUndo] = useState<{ ids: number[]; count: number } | null>(null);

  // Reload on focus so a recipe/template created in a pushed modal shows on return.
  useFocusEffect(
    useCallback(() => {
      recentFoods().then(setRecents);
      listTemplates().then(setTemplates);
      listRecipes().then(setRecipes);
      shouldShowAiOffer().then(setAiOffer);
    }, [])
  );

  useEffect(() => {
    const id = ++searchId.current;
    const q = query.trim();
    const t = setTimeout(
      async () => {
        const found = q ? await searchFoods(q) : [];
        if (searchId.current === id) setResults(found);
        if (q && !countedSearch.current) {
          countedSearch.current = true;
          recordManualSearch()
            .then(shouldShowAiOffer)
            .then(setAiOffer)
            .catch(() => {});
        }
      },
      q ? 200 : 0
    );
    return () => clearTimeout(t);
  }, [query]);

  // Auto-dismiss the undo bar after a few seconds (mirrors the today screen).
  useEffect(() => {
    if (!templateUndo) return;
    const t = setTimeout(() => setTemplateUndo(null), 6000);
    return () => clearTimeout(t);
  }, [templateUndo]);

  const openFood = (food: FoodItem) =>
    router.push({ pathname: '/food', params: { ref: food.ref, day, meal } });

  // One-tap template log stays on this screen and surfaces an inline undo bar
  // (rather than returning immediately), so the log is reversible in one tap.
  const applyTemplate = async (t: MealTemplate) => {
    const ids = await logTemplate(t, day, (meal as MealType | undefined) ?? mealForTime());
    setTemplateUndo({ ids, count: ids.length });
  };

  const undoTemplate = async () => {
    if (!templateUndo) return;
    await deleteEntries(templateUndo.ids);
    setTemplateUndo(null);
  };

  const confirmDeleteTemplate = (t: MealTemplate) => {
    Alert.alert('Delete template', `Remove “${t.name}”?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteTemplate(t.id);
          setTemplates(await listTemplates());
        },
      },
    ]);
  };

  const showingRecents = !query.trim();
  // While searching, surface recently-logged foods that match the query at the
  // top ("you've had this before"), and drop them from the results below.
  const q = query.trim().toLowerCase();
  const matchingRecents = showingRecents
    ? []
    : recents
        .filter((f) => {
          const hay = `${f.name} ${f.brand ?? ''}`.toLowerCase();
          return q.split(/\s+/).every((tok) => hay.includes(tok));
        })
        .slice(0, 3);
  const matchingRefs = new Set(matchingRecents.map((f) => f.ref));
  const data = showingRecents ? recents : results.filter((f) => !matchingRefs.has(f.ref));

  const renderRecipeRow = (r: Recipe) => (
    <Pressable
      key={r.id}
      style={styles.templateRow}
      onPress={() => router.push({ pathname: '/food', params: { ref: `recipe:${r.id}`, day, meal } })}
      onLongPress={() => router.push({ pathname: '/recipe', params: { id: String(r.id) } })}>
      <ThemedView type="backgroundElement" style={styles.templateCard}>
        <ThemedText type="small" numberOfLines={1} style={styles.templateName}>
          🍲 {r.name}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {r.servings} servings · {fmtKcal(recipePerServing(r).kcal)} kcal ea
        </ThemedText>
      </ThemedView>
    </Pressable>
  );

  const renderTemplateRow = (t: MealTemplate) => (
    <Pressable
      key={t.id}
      style={styles.templateRow}
      onPress={() => applyTemplate(t)}
      onLongPress={() => confirmDeleteTemplate(t)}>
      <ThemedView type="backgroundElement" style={styles.templateCard}>
        <ThemedText type="small" numberOfLines={1} style={styles.templateName}>
          ☆ {t.name}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {t.items.length} items · {fmtKcal(templateKcal(t))} kcal
        </ThemedText>
      </ThemedView>
    </Pressable>
  );

  return (
    <ThemedView style={styles.root}>
      <TextInput
        style={[
          styles.searchInput,
          { backgroundColor: theme.backgroundElement, color: theme.text },
        ]}
        placeholder="Search foods…"
        placeholderTextColor={theme.textSecondary}
        value={query}
        onChangeText={setQuery}
        autoFocus
        autoCorrect={false}
        returnKeyType="search"
      />

      <View style={styles.actionRow}>
        <Pressable
          style={[styles.actionButton, { backgroundColor: theme.backgroundElement }]}
          onPress={() => router.push({ pathname: '/scan', params: { day, meal } })}>
          <ThemedText type="small">📷 Scan barcode</ThemedText>
        </Pressable>
        <Pressable
          style={[styles.actionButton, { backgroundColor: theme.backgroundElement }]}
          onPress={() =>
            router.push({ pathname: '/custom-food', params: { day, meal, prefillName: query } })
          }>
          <ThemedText type="small">＋ Custom food</ThemedText>
        </Pressable>
      </View>

      {/* Cold-start AI offer: appears after the 3rd lifetime manual search,
          gone forever once dismissed (or once the model is downloaded). */}
      {aiOffer && (
        <ThemedView type="backgroundElement" style={styles.aiOfferCard}>
          <Pressable style={styles.aiOfferBody} onPress={() => router.push('/settings')}>
            <ThemedText type="small">
              ✨ You could have typed “eggs and toast” — want the on-device AI? It’s a
              one-time download.
            </ThemedText>
          </Pressable>
          <Pressable
            hitSlop={8}
            onPress={() => {
              setAiOffer(false);
              dismissAiOffer();
            }}>
            <ThemedText type="small" themeColor="textSecondary">
              ✕
            </ThemedText>
          </Pressable>
        </ThemedView>
      )}

      {templateUndo && (
        <View style={[styles.undoBar, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.flex}>
            Logged {templateUndo.count} item{templateUndo.count === 1 ? '' : 's'}
          </ThemedText>
          <Pressable hitSlop={8} onPress={undoTemplate}>
            <ThemedText type="smallBold" style={{ color: MacroColors.kcal }}>
              Undo
            </ThemedText>
          </Pressable>
        </View>
      )}

      <FlatList
        data={data}
        keyExtractor={(f) => f.ref}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          showingRecents ? (
            <View>
              <View style={styles.sectionHeaderRow}>
                <ThemedText type="smallBold" themeColor="textSecondary">
                  Recipes — tap to log a serving
                </ThemedText>
                <Pressable hitSlop={8} onPress={() => router.push('/recipe')}>
                  <ThemedText type="smallBold" style={{ color: MacroColors.kcal }}>
                    ＋ New
                  </ThemedText>
                </Pressable>
              </View>
              {recipes.map(renderRecipeRow)}
              {templates.length > 0 && (
                <>
                  <ThemedText type="smallBold" themeColor="textSecondary" style={styles.listHeader}>
                    Templates — tap to log the whole meal
                  </ThemedText>
                  {templates.map(renderTemplateRow)}
                </>
              )}
              {recents.length > 0 && (
                <ThemedText type="smallBold" themeColor="textSecondary" style={styles.listHeader}>
                  Recent
                </ThemedText>
              )}
            </View>
          ) : (
            <View>
              {/* Still reachable while searching: collapsed with a count. */}
              {recipes.length > 0 && (
                <>
                  <Pressable
                    style={styles.collapseHeader}
                    hitSlop={4}
                    onPress={() => setExpandRecipes((v) => !v)}>
                    <ThemedText type="smallBold" themeColor="textSecondary">
                      Recipes ({recipes.length}) {expandRecipes ? '▴' : '▾'}
                    </ThemedText>
                  </Pressable>
                  {expandRecipes && recipes.map(renderRecipeRow)}
                </>
              )}
              {templates.length > 0 && (
                <>
                  <Pressable
                    style={styles.collapseHeader}
                    hitSlop={4}
                    onPress={() => setExpandTemplates((v) => !v)}>
                    <ThemedText type="smallBold" themeColor="textSecondary">
                      Templates ({templates.length}) {expandTemplates ? '▴' : '▾'}
                    </ThemedText>
                  </Pressable>
                  {expandTemplates && templates.map(renderTemplateRow)}
                </>
              )}
              {matchingRecents.length > 0 && (
                <>
                  <ThemedText type="smallBold" themeColor="textSecondary" style={styles.listHeader}>
                    Recent
                  </ThemedText>
                  {matchingRecents.map((f) => (
                    <View key={f.ref} style={styles.recentMatch}>
                      <FoodRow food={f} onPress={() => openFood(f)} />
                    </View>
                  ))}
                </>
              )}
              {data.length > 0 &&
                (recipes.length > 0 || templates.length > 0 || matchingRecents.length > 0) && (
                  <ThemedText type="smallBold" themeColor="textSecondary" style={styles.listHeader}>
                    All foods
                  </ThemedText>
                )}
            </View>
          )
        }
        ListEmptyComponent={
          <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
            {showingRecents
              ? 'Foods you log will show up here for quick re-adding.'
              : 'No matches. Try fewer words, or create a custom food.'}
          </ThemedText>
        }
        renderItem={({ item }) => <FoodRow food={item} onPress={() => openFood(item)} />}
        ItemSeparatorComponent={() => <View style={{ height: Spacing.two }} />}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  searchInput: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 4,
    fontSize: 16,
  },
  actionRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  actionButton: {
    flex: 1,
    borderRadius: Spacing.three,
    paddingVertical: Spacing.two + 2,
    alignItems: 'center',
  },
  aiOfferCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
  },
  aiOfferBody: {
    flex: 1,
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
  listContent: {
    paddingBottom: Spacing.five,
    paddingTop: Spacing.one,
  },
  listHeader: {
    marginBottom: Spacing.two,
    marginTop: Spacing.one,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.two,
  },
  collapseHeader: {
    paddingVertical: Spacing.two,
  },
  recentMatch: {
    marginBottom: Spacing.two,
  },
  templateRow: {
    marginBottom: Spacing.two,
  },
  templateCard: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  templateName: {
    flex: 1,
  },
  empty: {
    textAlign: 'center',
    marginTop: Spacing.five,
    paddingHorizontal: Spacing.four,
  },
});
