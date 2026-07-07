import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { localEstimate } from '@/lib/ai/local';
import { recordAiEvent, type LoggedCorrection } from '@/lib/ai/events';
import {
  displayName,
  resolveClaim,
  resolvedMacros,
  type ResolvedItem,
} from '@/lib/ai/resolver';
import type { EstimateTurn, FoodClaim } from '@/lib/ai/types';
import { todayKey } from '@/lib/dates';
import { logFood, logAiEstimate } from '@/lib/log';
import { fmtGrams, fmtKcal, parseDecimal } from '@/lib/macros';
import { MEAL_LABELS, MEALS, type FoodItem, type MealType } from '@/lib/types';

type Phase = 'input' | 'estimating' | 'review';

type ReviewItem = ResolvedItem & { gramsText: string; showAlternatives: boolean };

export default function AssistScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ day?: string; meal?: string }>();
  const day = params.day ?? todayKey();

  const [phase, setPhase] = useState<Phase>('input');
  const [text, setText] = useState('');
  const [image, setImage] = useState<{ uri: string; base64: string } | null>(null);
  const [turns, setTurns] = useState<EstimateTurn[]>([]);
  const [claim, setClaim] = useState<FoodClaim | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [meal, setMeal] = useState<MealType>((params.meal as MealType) ?? 'snack');
  const [clarifyText, setClarifyText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const pickImage = async (from: 'camera' | 'library') => {
    const perm =
      from === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Enable access in system settings to add a photo.');
      return;
    }
    const result =
      from === 'camera'
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
    if (result.canceled || !result.assets[0]) return;

    // Cap the long side at 768 px before encoding. This matches the on-device
    // model's training resolution (~640x480) and keeps the vision pass ~1.3k
    // tokens; larger images are both slower on-device and a train/inference
    // mismatch that hurts accuracy. Resize by whichever dimension is longer so
    // portrait photos are capped too (resizing one dimension preserves aspect).
    const asset = result.assets[0];
    const context = ImageManipulator.manipulate(asset.uri);
    const w = asset.width ?? 0;
    const h = asset.height ?? 0;
    if (Math.max(w, h) > 768) {
      context.resize(w >= h ? { width: 768 } : { height: 768 });
    }
    const rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({
      base64: true,
      compress: 0.7,
      format: SaveFormat.JPEG,
    });
    if (saved.base64) setImage({ uri: saved.uri, base64: saved.base64 });
  };

  const runEstimate = async (newTurns: EstimateTurn[]) => {
    setPhase('estimating');
    setError(null);
    const res = await localEstimate(newTurns);
    if (!res.ok) {
      setError(res.message);
      setPhase(claim ? 'review' : 'input');
      if (res.needsModel) {
        Alert.alert('Model not downloaded', res.message, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => router.push('/settings') },
        ]);
      }
      return;
    }
    const resolved = await resolveClaim(res.claim);
    setTurns([...newTurns, { role: 'assistant', claim: res.claim }]);
    setClaim(res.claim);
    setItems(
      resolved.map((r) => ({ ...r, gramsText: String(r.grams), showAlternatives: false }))
    );
    if (!claim) setMeal((params.meal as MealType) ?? res.claim.meal_guess);
    setClarifyText('');
    setPhase('review');
  };

  const submit = () => {
    if (!text.trim() && !image) return;
    runEstimate([{ role: 'user', input: { text, imageBase64: image?.base64 } }]);
  };

  const sendClarification = () => {
    if (!clarifyText.trim()) return;
    runEstimate([...turns, { role: 'user', input: { text: clarifyText } }]);
  };

  const updateItem = (idx: number, patch: Partial<ReviewItem>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const setItemGrams = (idx: number, gramsText: string) => {
    const g = parseDecimal(gramsText);
    updateItem(idx, { gramsText, ...(g != null && g > 0 ? { grams: g } : {}) });
  };

  const chooseMatch = (idx: number, match: FoodItem | null) => {
    updateItem(idx, { match, showAlternatives: false });
  };

  const removeItem = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const logAll = async () => {
    if (items.length === 0 || saving) return;
    setSaving(true);
    try {
      const corrections: LoggedCorrection[] = [];
      for (const item of items) {
        const macros = resolvedMacros(item);
        if (item.match) {
          await logFood(item.match, {
            day,
            meal,
            grams: item.grams,
            quantityDesc: `${fmtGrams(item.grams)} g`,
          });
        } else {
          await logAiEstimate({ day, meal, name: item.claim.name, grams: item.grams, macros });
        }
        corrections.push({
          name: displayName(item),
          matchedRef: item.match?.ref ?? null,
          claimedGrams: item.claim.grams,
          loggedGrams: item.grams,
          kcal: macros.kcal,
        });
      }
      await recordAiEvent(turns, corrections);
      router.dismissAll();
    } finally {
      setSaving(false);
    }
  };

  const totalKcal = items.reduce((s, it) => s + resolvedMacros(it).kcal, 0);
  const inputStyle = [styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }];

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ThemedView style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {phase === 'input' && (
            <>
              <ThemedText type="small" themeColor="textSecondary">
                Describe what you ate, attach a photo, or both. You can answer follow-up
                questions before anything is logged.
              </ThemedText>
              <TextInput
                style={[...inputStyle, styles.multiline]}
                value={text}
                onChangeText={setText}
                placeholder="e.g. 2 eggs scrambled in butter and a slice of sourdough toast"
                placeholderTextColor={theme.textSecondary}
                multiline
                autoFocus
              />
              {image && (
                <View style={styles.imageRow}>
                  <Image source={{ uri: image.uri }} style={styles.thumbnail} />
                  <Pressable hitSlop={8} onPress={() => setImage(null)}>
                    <ThemedText type="small" themeColor="textSecondary">
                      Remove photo
                    </ThemedText>
                  </Pressable>
                </View>
              )}
              <View style={styles.buttonRow}>
                <ActionButton label="📷 Camera" onPress={() => pickImage('camera')} />
                <ActionButton label="🖼 Photo library" onPress={() => pickImage('library')} />
              </View>
              {error && (
                <ThemedText type="small" style={{ color: MacroColors.protein }}>
                  {error}
                </ThemedText>
              )}
              <PrimaryButton
                label="Estimate nutrition"
                disabled={!text.trim() && !image}
                onPress={submit}
              />
            </>
          )}

          {phase === 'estimating' && (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color={MacroColors.kcal} />
              <ThemedText type="small" themeColor="textSecondary">
                Analyzing your meal…
              </ThemedText>
            </View>
          )}

          {phase === 'review' && claim && (
            <>
              {claim.needs_clarification && (
                <ThemedView type="backgroundElement" style={styles.clarifyCard}>
                  <ThemedText type="smallBold">Quick question</ThemedText>
                  {claim.questions.map((q, i) => (
                    <ThemedText key={i} type="small">
                      {q}
                    </ThemedText>
                  ))}
                  <TextInput
                    style={[styles.input, { backgroundColor: theme.background, color: theme.text }]}
                    value={clarifyText}
                    onChangeText={setClarifyText}
                    placeholder="Type your answer…"
                    placeholderTextColor={theme.textSecondary}
                    returnKeyType="send"
                    onSubmitEditing={sendClarification}
                  />
                  <View style={styles.buttonRow}>
                    <ActionButton label="Answer" onPress={sendClarification} />
                    <ActionButton
                      label="Skip — use estimates"
                      onPress={() => setClaim({ ...claim, needs_clarification: false })}
                    />
                  </View>
                </ThemedView>
              )}

              {items.map((item, idx) => (
                <ItemCard
                  key={idx}
                  item={item}
                  onGramsChange={(t) => setItemGrams(idx, t)}
                  onToggleAlternatives={() =>
                    updateItem(idx, { showAlternatives: !item.showAlternatives })
                  }
                  onChooseMatch={(m) => chooseMatch(idx, m)}
                  onRemove={() => removeItem(idx)}
                />
              ))}

              {error && (
                <ThemedText type="small" style={{ color: MacroColors.protein }}>
                  {error}
                </ThemedText>
              )}

              <View style={styles.mealChips}>
                {MEALS.map((m) => (
                  <Chip key={m} label={MEAL_LABELS[m]} selected={meal === m} onPress={() => setMeal(m)} />
                ))}
              </View>

              <PrimaryButton
                label={
                  saving
                    ? 'Logging…'
                    : `Log ${items.length} item${items.length === 1 ? '' : 's'} · ${fmtKcal(totalKcal)} kcal`
                }
                disabled={items.length === 0}
                onPress={logAll}
              />
              <Pressable
                style={styles.startOver}
                onPress={() => {
                  setPhase('input');
                  setClaim(null);
                  setItems([]);
                  setTurns([]);
                  setError(null);
                }}>
                <ThemedText type="small" themeColor="textSecondary">
                  Start over
                </ThemedText>
              </Pressable>
            </>
          )}
        </ScrollView>
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

function ItemCard({
  item,
  onGramsChange,
  onToggleAlternatives,
  onChooseMatch,
  onRemove,
}: {
  item: ReviewItem;
  onGramsChange: (text: string) => void;
  onToggleAlternatives: () => void;
  onChooseMatch: (match: FoodItem | null) => void;
  onRemove: () => void;
}) {
  const theme = useTheme();
  const macros = resolvedMacros(item);

  return (
    <ThemedView type="backgroundElement" style={styles.itemCard}>
      <View style={styles.itemHeader}>
        <ThemedText type="smallBold" numberOfLines={2} style={styles.flex}>
          {item.claim.name}
          {item.claim.prep ? ` (${item.claim.prep})` : ''}
        </ThemedText>
        <Pressable hitSlop={8} onPress={onRemove}>
          <ThemedText type="small" themeColor="textSecondary">
            ✕
          </ThemedText>
        </Pressable>
      </View>

      <View style={styles.itemRow}>
        <TextInput
          style={[styles.gramsInput, { backgroundColor: theme.background, color: theme.text }]}
          value={item.gramsText}
          onChangeText={onGramsChange}
          keyboardType="decimal-pad"
          selectTextOnFocus
        />
        <ThemedText type="small" themeColor="textSecondary">
          g
        </ThemedText>
        <View style={styles.itemMacros}>
          <ThemedText type="small">
            {fmtKcal(macros.kcal)} kcal · P {fmtGrams(macros.protein)} · C {fmtGrams(macros.carbs)}{' '}
            · F {fmtGrams(macros.fat)}
          </ThemedText>
        </View>
      </View>

      <Pressable onPress={onToggleAlternatives}>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
          {item.match ? `≈ ${item.match.name}` : '⚠ No database match — AI estimate'}
          {'  ›'}
        </ThemedText>
      </Pressable>

      {item.showAlternatives && (
        <View style={styles.alternatives}>
          {item.alternatives.map((alt) => (
            <Pressable
              key={alt.ref}
              style={styles.alternativeRow}
              onPress={() => onChooseMatch(alt)}>
              <ThemedText
                type="small"
                themeColor={item.match?.ref === alt.ref ? 'text' : 'textSecondary'}
                numberOfLines={1}>
                {item.match?.ref === alt.ref ? '● ' : '○ '}
                {alt.name} ({fmtKcal(alt.per100.kcal)} kcal/100g)
              </ThemedText>
            </Pressable>
          ))}
          <Pressable style={styles.alternativeRow} onPress={() => onChooseMatch(null)}>
            <ThemedText
              type="small"
              themeColor={item.match == null ? 'text' : 'textSecondary'}>
              {item.match == null ? '● ' : '○ '}Use AI estimate (
              {fmtKcal(item.claim.est_per100.kcal)} kcal/100g)
            </ThemedText>
          </Pressable>
        </View>
      )}
    </ThemedView>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: selected ? theme.backgroundSelected : theme.backgroundElement,
          borderColor: selected ? MacroColors.kcal : 'transparent',
        },
      ]}>
      <ThemedText type="small" themeColor={selected ? 'text' : 'textSecondary'}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

function ActionButton({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      style={[styles.actionButton, { backgroundColor: theme.backgroundElement }]}
      onPress={onPress}>
      <ThemedText type="small">{label}</ThemedText>
    </Pressable>
  );
}

function PrimaryButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.primaryButton, { backgroundColor: MacroColors.kcal, opacity: disabled ? 0.4 : 1 }]}
      disabled={disabled}
      onPress={onPress}>
      <ThemedText type="smallBold" style={styles.primaryButtonText}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
    paddingBottom: Spacing.six,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  multiline: {
    minHeight: 90,
    textAlignVertical: 'top',
  },
  imageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  thumbnail: {
    width: 84,
    height: 84,
    borderRadius: Spacing.two,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  actionButton: {
    flex: 1,
    borderRadius: Spacing.three,
    paddingVertical: Spacing.two + 2,
    alignItems: 'center',
  },
  primaryButton: {
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#ffffff' },
  loading: {
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.six,
  },
  clarifyCard: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
    borderWidth: 1,
    borderColor: MacroColors.carbs,
  },
  itemCard: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  itemHeader: {
    flexDirection: 'row',
    gap: Spacing.two,
    alignItems: 'flex-start',
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  gramsInput: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    fontSize: 16,
    minWidth: 64,
    textAlign: 'center',
  },
  itemMacros: {
    flex: 1,
    alignItems: 'flex-end',
  },
  alternatives: {
    gap: Spacing.one,
    paddingTop: Spacing.one,
  },
  alternativeRow: {
    paddingVertical: Spacing.one,
  },
  mealChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderWidth: 1,
  },
  startOver: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
});
