import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RecipeManager } from '@/components/recipe-manager';
import { SettingsGear } from '@/components/settings-gear';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useUnitPrefs } from '@/hooks/use-unit-prefs';
import { listCustomFoods } from '@/lib/foods';
import { fmtKcal } from '@/lib/macros';
import { energyLabel } from '@/lib/units';
import type { FoodItem } from '@/lib/types';

/**
 * The Library tab: everything the user has made — recipes (with edit / copy /
 * share-QR / delete) and custom foods — in one visible place instead of
 * buried behind the Add-food flow.
 */
export default function LibraryScreen() {
  const theme = useTheme();
  const unitPrefs = useUnitPrefs();
  const [manualFoods, setManualFoods] = useState<FoodItem[]>([]);
  const [barcodeFoods, setBarcodeFoods] = useState<FoodItem[]>([]);

  useFocusEffect(
    useCallback(() => {
      listCustomFoods('manual').then(setManualFoods);
      listCustomFoods('barcode').then(setBarcodeFoods);
    }, [])
  );

  const FoodRowCard = ({ f }: { f: FoodItem }) => (
    <ThemedView type="backgroundElement" style={styles.foodCard}>
      <View style={styles.flex}>
        <ThemedText type="small" numberOfLines={1}>
          {f.name}
          {f.brand ? ` (${f.brand})` : ''}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {fmtKcal(f.per100.kcal)} {energyLabel(unitPrefs)}/100 {f.unit ?? 'g'}
        </ThemedText>
      </View>
      <Pressable
        hitSlop={8}
        onPress={() => router.push({ pathname: '/food', params: { ref: f.ref } })}>
        <ThemedText type="small" themeColor="tint">
          Log
        </ThemedText>
      </Pressable>
      <Pressable
        hitSlop={8}
        onPress={() => router.push({ pathname: '/custom-food', params: { editRef: f.ref } })}>
        <ThemedText type="small" themeColor="tint">
          Edit
        </ThemedText>
      </Pressable>
    </ThemedView>
  );

  return (
    <ThemedView style={styles.root}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.header}>
          <ThemedText type="subtitle" style={styles.flex}>
            Library
          </ThemedText>
          <SettingsGear />
        </View>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Recipes
          </ThemedText>
          <RecipeManager />

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Manual entries
          </ThemedText>
          <Pressable
            style={[styles.newButton, { backgroundColor: theme.backgroundElement }]}
            onPress={() => router.push('/manual-entry')}>
            <ThemedText type="smallBold" themeColor="tint">
              ＋ Manual entry
            </ThemedText>
          </Pressable>
          {manualFoods.length === 0 && (
            <ThemedText type="small" themeColor="textSecondary">
              Foods you saved from a manual entry live here for re-logging.
            </ThemedText>
          )}
          {manualFoods.map((f) => (
            <FoodRowCard key={f.ref} f={f} />
          ))}

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Barcode scans
          </ThemedText>
          {barcodeFoods.length === 0 && (
            <ThemedText type="small" themeColor="textSecondary">
              Products you entered for barcodes the database didn’t know.
            </ThemedText>
          )}
          {barcodeFoods.map((f) => (
            <FoodRowCard key={f.ref} f={f} />
          ))}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  content: {
    paddingHorizontal: Spacing.three,
    paddingBottom: BottomTabInset + Spacing.five,
    gap: Spacing.two,
  },
  sectionTitle: {
    marginTop: Spacing.three,
  },
  newButton: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    alignItems: 'center',
  },
  foodCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
});
