import { ScrollView, StyleSheet } from 'react-native';

import { RecipeManager } from '@/components/recipe-manager';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

/** Standalone recipes screen — the scanner's import flow lands here; day-to-day
 *  management lives on the Library tab (same component). */
export default function RecipesScreen() {
  return (
    <ThemedView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <RecipeManager />
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: Spacing.three },
});
