import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { FoodRow } from '@/components/food-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { todayKey } from '@/lib/dates';
import { recentFoods, searchFoods } from '@/lib/foods';
import { fmtKcal } from '@/lib/macros';
import { listRecipes, recipePerServing, type Recipe } from '@/lib/recipes';
import {
  deleteTemplate,
  listTemplates,
  logTemplate,
  templateKcal,
  type MealTemplate,
} from '@/lib/templates';
import type { FoodItem, MealType } from '@/lib/types';

export default function AddFoodScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ day?: string; meal?: string }>();
  const day = params.day ?? todayKey();
  const meal = params.meal ?? 'snack';

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FoodItem[]>([]);
  const [recents, setRecents] = useState<FoodItem[]>([]);
  const [templates, setTemplates] = useState<MealTemplate[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const searchId = useRef(0);

  // Reload on focus so a recipe/template created in a pushed modal shows on return.
  useFocusEffect(
    useCallback(() => {
      recentFoods().then(setRecents);
      listTemplates().then(setTemplates);
      listRecipes().then(setRecipes);
    }, [])
  );

  useEffect(() => {
    const id = ++searchId.current;
    const q = query.trim();
    const t = setTimeout(
      async () => {
        const found = q ? await searchFoods(q) : [];
        if (searchId.current === id) setResults(found);
      },
      q ? 200 : 0
    );
    return () => clearTimeout(t);
  }, [query]);

  const openFood = (food: FoodItem) =>
    router.push({ pathname: '/food', params: { ref: food.ref, day, meal } });

  const applyTemplate = async (t: MealTemplate) => {
    await logTemplate(t, day, meal as MealType);
    router.back();
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
              {recipes.map((r) => (
                <Pressable
                  key={r.id}
                  style={styles.templateRow}
                  onPress={() =>
                    router.push({ pathname: '/food', params: { ref: `recipe:${r.id}`, day, meal } })
                  }
                  onLongPress={() =>
                    router.push({ pathname: '/recipe', params: { id: String(r.id) } })
                  }>
                  <ThemedView type="backgroundElement" style={styles.templateCard}>
                    <ThemedText type="small" numberOfLines={1} style={styles.templateName}>
                      🍲 {r.name}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {r.servings} servings · {fmtKcal(recipePerServing(r).kcal)} kcal ea
                    </ThemedText>
                  </ThemedView>
                </Pressable>
              ))}
              {templates.length > 0 && (
                <>
                  <ThemedText type="smallBold" themeColor="textSecondary" style={styles.listHeader}>
                    Templates — tap to log the whole meal
                  </ThemedText>
                  {templates.map((t) => (
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
                  ))}
                </>
              )}
              {recents.length > 0 && (
                <ThemedText type="smallBold" themeColor="textSecondary" style={styles.listHeader}>
                  Recent
                </ThemedText>
              )}
            </View>
          ) : matchingRecents.length > 0 ? (
            <View>
              <ThemedText type="smallBold" themeColor="textSecondary" style={styles.listHeader}>
                Recent
              </ThemedText>
              {matchingRecents.map((f) => (
                <View key={f.ref} style={styles.recentMatch}>
                  <FoodRow food={f} onPress={() => openFood(f)} />
                </View>
              ))}
              {data.length > 0 && (
                <ThemedText type="smallBold" themeColor="textSecondary" style={styles.listHeader}>
                  All foods
                </ThemedText>
              )}
            </View>
          ) : null
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
