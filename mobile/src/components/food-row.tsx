import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { Spacing } from '@/constants/theme';
import { fmtGrams, fmtKcal } from '@/lib/macros';
import type { FoodItem } from '@/lib/types';

const SOURCE_BADGE: Record<FoodItem['source'], string | null> = {
  usda: null,
  custom: 'custom',
  barcode: 'scanned',
  recipe: 'recipe',
};

export function FoodRow({ food, onPress }: { food: FoodItem; onPress: () => void }) {
  const badge = SOURCE_BADGE[food.source];
  return (
    <Pressable onPress={onPress}>
      {({ pressed }) => (
        <ThemedView
          type={pressed ? 'backgroundSelected' : 'backgroundElement'}
          style={styles.card}>
          <View style={styles.nameRow}>
            <ThemedText type="small" numberOfLines={2} style={styles.name}>
              {food.name}
              {food.brand ? ` (${food.brand})` : ''}
            </ThemedText>
            {badge && (
              <ThemedText type="small" themeColor="textSecondary">
                {badge}
              </ThemedText>
            )}
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {fmtKcal(food.per100.kcal)} kcal · P {fmtGrams(food.per100.protein)} · C{' '}
            {fmtGrams(food.per100.carbs)} · F {fmtGrams(food.per100.fat)} per 100 {food.unit ?? 'g'}
          </ThemedText>
        </ThemedView>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    gap: 2,
  },
  nameRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  name: {
    flex: 1,
  },
});
