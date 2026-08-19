import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';

import { QrCode } from '@/components/recipe-qr';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useUnitPrefs } from '@/hooks/use-unit-prefs';
import { fmtKcal } from '@/lib/macros';
import { encodeRecipeShare } from '@/lib/recipe-share';
import {
  deleteRecipe,
  duplicateRecipe,
  listRecipes,
  recipePerServing,
  type Recipe,
} from '@/lib/recipes';
import { energyLabel } from '@/lib/units';

/**
 * Recipe management: every recipe with edit / copy / share / delete in one
 * place (the Add-food screen only lists them for logging). Sharing renders a
 * QR the other person scans with MacroTrack's own scanner — the payload is the
 * recipe itself (see lib/recipe-share.ts), no server involved.
 */
export default function RecipesScreen() {
  const theme = useTheme();
  const unitPrefs = useUnitPrefs();
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [sharing, setSharing] = useState<{ recipe: Recipe; data: string } | null>(null);

  const load = useCallback(async () => {
    setRecipes(await listRecipes());
  }, []);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const share = (recipe: Recipe) => {
    const data = encodeRecipeShare(recipe);
    if (!data) {
      Alert.alert(
        'Too big for a QR code',
        'This recipe has too many ingredients to fit in a scannable code.'
      );
      return;
    }
    setSharing({ recipe, data });
  };

  const copy = async (recipe: Recipe) => {
    await duplicateRecipe(recipe.id);
    await load();
  };

  const confirmDelete = (recipe: Recipe) => {
    Alert.alert('Delete recipe', `Delete “${recipe.name}”? Logged days keep their numbers.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteRecipe(recipe.id);
          await load();
        },
      },
    ]);
  };

  const Action = ({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) => (
    <Pressable hitSlop={6} onPress={onPress}>
      <ThemedText type="small" style={danger ? { color: theme.danger } : undefined} themeColor={danger ? undefined : 'tint'}>
        {label}
      </ThemedText>
    </Pressable>
  );

  return (
    <ThemedView style={styles.root}>
      <FlatList
        data={recipes}
        keyExtractor={(r) => String(r.id)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
            No recipes yet. Create one from the Add food screen, or scan a friend’s recipe
            QR with the barcode scanner.
          </ThemedText>
        }
        renderItem={({ item: r }) => (
          <ThemedView type="backgroundElement" style={styles.card}>
            <ThemedText type="smallBold" numberOfLines={1}>
              {r.name}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {r.items.length} ingredient{r.items.length === 1 ? '' : 's'} · {r.servings} servings ·{' '}
              {fmtKcal(recipePerServing(r).kcal)} {energyLabel(unitPrefs)}/serving
            </ThemedText>
            <View style={styles.actions}>
              <Action
                label="Edit"
                onPress={() => router.push({ pathname: '/recipe', params: { id: String(r.id) } })}
              />
              <Action label="Copy" onPress={() => copy(r)} />
              <Action label="Share" onPress={() => share(r)} />
              <Action label="Delete" danger onPress={() => confirmDelete(r)} />
            </View>
          </ThemedView>
        )}
      />

      <Modal visible={sharing != null} transparent animationType="fade" onRequestClose={() => setSharing(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setSharing(null)}>
          <Pressable onPress={() => {}}>
            <ThemedView type="backgroundElement" style={styles.modalCard}>
              <ThemedText type="smallBold" numberOfLines={1}>
                {sharing?.recipe.name}
              </ThemedText>
              {sharing && <QrCode data={sharing.data} size={280} />}
              <ThemedText type="small" themeColor="textSecondary" style={styles.modalHint}>
                On the other phone: MacroTrack → scan barcode → point at this code. The
                recipe imports with all ingredients and macros.
              </ThemedText>
              <Pressable hitSlop={8} onPress={() => setSharing(null)}>
                <ThemedText type="small" themeColor="tint">
                  Done
                </ThemedText>
              </Pressable>
            </ThemedView>
          </Pressable>
        </Pressable>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { padding: Spacing.three, gap: Spacing.two },
  empty: { textAlign: 'center', paddingTop: Spacing.six },
  card: {
    borderRadius: Radius.card,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.four,
    paddingTop: Spacing.one,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCard: {
    borderRadius: Radius.card,
    padding: Spacing.four,
    gap: Spacing.three,
    alignItems: 'center',
    maxWidth: 340,
  },
  modalHint: {
    textAlign: 'center',
  },
});
