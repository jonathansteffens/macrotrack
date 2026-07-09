import { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FoodRow } from './food-row';
import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { searchFoods } from '@/lib/foods';
import type { FoodItem } from '@/lib/types';

/**
 * A self-contained "pick a different food" search sheet. Reuses the manual
 * search path (searchFoods 'common') and FoodRow, so swapping an item's match
 * looks identical to the Add-food screen — but returns the chosen FoodItem to
 * the caller instead of navigating. Used by the AI review screen (item-level
 * "Change food") and the history entry editor.
 *
 * Mount it only while open (`{open && <FoodSearchModal … />}`) — the initial
 * query seeds from `initialQuery` on mount, so a fresh instance opens with the
 * current food's name pre-filled.
 */
export function FoodSearchModal({
  title = 'Change food',
  initialQuery = '',
  onSelect,
  onClose,
}: {
  title?: string;
  initialQuery?: string;
  onSelect: (food: FoodItem) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<FoodItem[]>([]);
  const searchId = useRef(0);

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

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <ThemedView style={styles.root}>
        <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
          <KeyboardAvoidingView
            style={styles.flex}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.header}>
              <ThemedText type="smallBold" style={styles.flex}>
                {title}
              </ThemedText>
              <Pressable hitSlop={12} style={styles.close} onPress={onClose}>
                <ThemedText type="default" themeColor="textSecondary">
                  ✕
                </ThemedText>
              </Pressable>
            </View>
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
            <FlatList
              data={results}
              keyExtractor={(f) => f.ref}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.listContent}
              renderItem={({ item }) => <FoodRow food={item} onPress={() => onSelect(item)} />}
              ItemSeparatorComponent={() => <View style={{ height: Spacing.two }} />}
              ListEmptyComponent={
                <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
                  {query.trim() ? 'No matches. Try fewer words.' : 'Type to search for a food.'}
                </ThemedText>
              }
            />
          </KeyboardAvoidingView>
        </SafeAreaView>
      </ThemedView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
  },
  safeArea: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  close: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  searchInput: {
    marginHorizontal: Spacing.three,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 4,
    fontSize: 16,
  },
  listContent: {
    padding: Spacing.three,
    paddingBottom: Spacing.five,
  },
  empty: {
    textAlign: 'center',
    marginTop: Spacing.five,
    paddingHorizontal: Spacing.four,
  },
});
