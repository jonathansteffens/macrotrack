import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { FoodRow } from '@/components/food-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { todayKey } from '@/lib/dates';
import { recentFoods, searchFoods } from '@/lib/foods';
import { fmtKcal } from '@/lib/macros';
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
  const searchId = useRef(0);

  useEffect(() => {
    recentFoods().then(setRecents);
    listTemplates().then(setTemplates);
  }, []);

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
  const data = showingRecents ? recents : results;

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
