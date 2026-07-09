import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
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

import { EstimatingIndicator } from '@/components/estimating-indicator';
import { FoodSearchModal } from '@/components/food-search-modal';
import { FractionChips } from '@/components/fraction-chips';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { localEstimate } from '@/lib/ai/local';
import { ensureLoaded } from '@/lib/ai/local-model';
import {
  recordAiEvent,
  usualGramsFor,
  type LoggedCorrection,
  type SavedAiItem,
} from '@/lib/ai/events';
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
import { MEAL_LABELS, MEALS, mealForTime, type FoodItem, type MealType } from '@/lib/types';

type Phase = 'input' | 'estimating' | 'review';

type ReviewItem = ResolvedItem & {
  gramsText: string;
  showAlternatives: boolean;
  /** Model's grams when the amount was pre-adjusted to the user's usual. */
  usualFrom: number | null;
  /** Grams of one serving when a discrete serving is known (enables the count
   *  stepper); null → no stepper for this item. */
  serving: number | null;
  /** Current stepper count; null = "custom" (a manual gram edit broke the
   *  count × serving derivation — the next ± press re-derives). */
  stepCount: number | null;
  /** Whether the count began fractional (allows 0.5 steps below 1). */
  stepFractional: boolean;
};

type StepInfo = { serving: number; fractional: boolean };

const MAX_COUNT = 24;

/**
 * Grams-per-serving + step granularity for the count stepper, when a discrete
 * serving is known: (a) the model's own whole-unit count ("10 tacos"), else
 * (b) a branded DB match whose portions[0] is the real serving weight. null →
 * no stepper. (a) takes priority so a model-stated count wins over the DB row.
 */
function stepInfoFor(item: ResolvedItem): StepInfo | null {
  const c = item.claim;
  if (typeof c.count === 'number' && Number.isFinite(c.count) && c.count > 0) {
    // unit_grams is the model's per-unit serving; grams/count is the fallback
    // (matches how resolver.ts seeds the amount).
    const serving = c.unit_grams && c.unit_grams > 0 ? c.unit_grams : c.grams / c.count;
    if (serving > 0) return { serving, fractional: !Number.isInteger(c.count) };
  }
  if (item.match?.dataType === 'branded') {
    const g = item.match.portions[0]?.grams;
    if (g && g > 0) return { serving: g, fractional: false };
  }
  return null;
}

function clampCount(n: number, fractional: boolean): number {
  return Math.min(MAX_COUNT, Math.max(fractional ? 0.5 : 1, n));
}

/** Nearest valid serving count for a gram amount — used to re-derive when the
 *  user typed a custom amount and then steps. */
function countFromGrams(grams: number, info: StepInfo): number {
  const raw = grams / info.serving;
  const q = info.fractional ? Math.round(raw * 2) / 2 : Math.round(raw);
  return clampCount(q, info.fractional);
}

/** Next count in a direction. Half-steps only in the sub-1 range and only for
 *  counts that began fractional; everything else steps by whole units. */
function nextCount(cur: number, dir: 1 | -1, fractional: boolean): number {
  const half = fractional && (dir < 0 ? cur <= 1 : cur < 1);
  const step = half ? 0.5 : 1;
  return clampCount(Math.round((cur + dir * step) * 2) / 2, fractional);
}

/** Initial stepper count for a seeded item, or null ("custom") when the seeded
 *  grams isn't already ~a whole number of servings (e.g. a correction-memory
 *  "usual" amount) — the stepper then snaps on the first ± press. */
function initCount(grams: number, info: StepInfo): number | null {
  const c = countFromGrams(grams, info);
  return Math.abs(c * info.serving - grams) < 0.5 ? c : null;
}

/**
 * Re-derive an item's count-stepper state (serving / fractional / stepCount)
 * for a newly chosen match — a DB food or the model's own estimate (null) —
 * keeping the current grams (same rule changeItemFood uses: the amount you
 * already dialled in carries over, the stepper just re-seeds against it). Shared
 * by the alternatives radio (chooseMatch) and the full-search swap
 * (changeItemFood) so the two can't diverge again.
 */
function reprojectMatch(it: ReviewItem, match: FoodItem | null): Partial<ReviewItem> {
  const info = stepInfoFor({ ...it, match });
  return {
    match,
    serving: info?.serving ?? null,
    stepFractional: info?.fractional ?? false,
    stepCount: info ? initCount(it.grams, info) : null,
  };
}

export default function AssistScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ day?: string; meal?: string }>();
  const day = params.day ?? todayKey();

  const [phase, setPhase] = useState<Phase>('input');
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<EstimateTurn[]>([]);
  const [claim, setClaim] = useState<FoodClaim | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  // No meal in the params → time-of-day guess, replaced by the model's
  // meal_guess once the first estimate lands (see runEstimate).
  const [meal, setMeal] = useState<MealType>(() => (params.meal as MealType) ?? mealForTime());
  // One answer per clarification question (the model asks ≤2).
  const [clarifyAnswers, setClarifyAnswers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Live decode preview: rows filled in as each item's JSON closes (Feature 2).
  const [streamItems, setStreamItems] = useState<{ name: string; grams: number }[]>([]);
  // The turns of the last estimate attempt, so "Try again" can re-run them.
  const [lastTurns, setLastTurns] = useState<EstimateTurn[]>([]);
  // Which review item (if any) has the "Change food" search sheet open.
  const [searchItemIdx, setSearchItemIdx] = useState<number | null>(null);

  // Warm the model up while the user is still typing, so the first estimate
  // doesn't pay the full context-load cost. Fire-and-forget; no-op if the model
  // isn't downloaded or the platform can't run it.
  useEffect(() => {
    ensureLoaded();
  }, []);

  const runEstimate = async (newTurns: EstimateTurn[], temperature = 0) => {
    setLastTurns(newTurns);
    setPhase('estimating');
    setError(null);
    setStreamItems([]);
    const res = await localEstimate(
      newTurns,
      (it) => {
        // Items stream in order; slot by index so a row updates in place if it
        // decodes in two chunks. If llama.rn never fires the callback this simply
        // stays empty and the indicator shows alone (graceful degrade).
        setStreamItems((prev) => {
          const next = prev.slice();
          next[it.index] = { name: it.name, grams: it.grams };
          return next;
        });
      },
      { temperature }
    );
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
    // Correction memory: foods the user has re-portioned ≥2 times before open
    // at their usual grams instead of the model's, with a revert affordance.
    const reviewItems: ReviewItem[] = [];
    for (const r of resolved) {
      const usual = await usualGramsFor(r.claim.name);
      const grams = usual != null && usual !== r.grams ? usual : r.grams;
      const info = stepInfoFor(r);
      reviewItems.push({
        ...r,
        grams,
        gramsText: String(grams),
        showAlternatives: false,
        usualFrom: grams === r.grams ? null : r.grams,
        serving: info?.serving ?? null,
        stepFractional: info?.fractional ?? false,
        stepCount: info ? initCount(grams, info) : null,
      });
    }
    setItems(reviewItems);
    if (!claim) setMeal((params.meal as MealType) ?? res.claim.meal_guess);
    setClarifyAnswers([]);
    setPhase('review');
  };

  const submit = () => {
    if (!text.trim()) return;
    runEstimate([{ role: 'user', input: { text } }]);
  };

  // Retry the last attempt with a little sampling temperature, so a deterministic
  // truncation/parse failure doesn't reproduce identically. n_predict is unchanged.
  const retry = () => {
    if (lastTurns.length === 0) submit();
    else runEstimate(lastTurns, 0.2);
  };

  // Failure is never a dead end — bail to the manual Add-food search.
  const searchManually = () => {
    router.dismissAll();
    router.push({ pathname: '/add', params: { day } });
  };

  const sendClarification = () => {
    const questions = claim?.questions ?? [];
    // Join answered questions into one natural reply turn ("<question> <answer>;
    // …"), so the model sees which answer maps to which question.
    const reply = questions
      .map((q, i) => (clarifyAnswers[i]?.trim() ? `${q} ${clarifyAnswers[i].trim()}` : null))
      .filter(Boolean)
      .join('; ');
    if (!reply.trim()) return;
    runEstimate([...turns, { role: 'user', input: { text: reply } }]);
  };

  const updateItem = (idx: number, patch: Partial<ReviewItem>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const setItemGrams = (idx: number, gramsText: string) => {
    const g = parseDecimal(gramsText);
    // A manual gram edit (TextInput or FractionChips) breaks the count × serving
    // derivation → drop the stepper into its "custom" state; a later ± re-derives.
    updateItem(idx, { gramsText, stepCount: null, ...(g != null && g > 0 ? { grams: g } : {}) });
  };

  // Count stepper: step the serving count, then set grams = count × serving.
  // From a "custom" (hand-typed) amount the first press only SNAPS to the
  // nearest whole-serving count — it doesn't also step (250 g with a 270 g
  // serving: + → 270, not 540). Once a count is established, presses step.
  const stepItem = (idx: number, dir: 1 | -1) => {
    const item = items[idx];
    if (item.serving == null) return;
    const info: StepInfo = { serving: item.serving, fractional: item.stepFractional };
    const n =
      item.stepCount == null
        ? countFromGrams(item.grams, info)
        : nextCount(item.stepCount, dir, info.fractional);
    const g = Math.round(n * info.serving);
    updateItem(idx, { stepCount: n, grams: g, gramsText: String(g) });
  };

  // Pick one of the model's alternatives (or "Use AI estimate", match=null).
  // Re-derives the stepper for the chosen food so it can't show a stale
  // serving; the amount and any "usual" adjustment carry over unchanged.
  const chooseMatch = (idx: number, match: FoodItem | null) => {
    setItems((prev) =>
      prev.map((it, i) =>
        i === idx ? { ...it, ...reprojectMatch(it, match), showAlternatives: false } : it
      )
    );
  };

  // Swap an item's match from the full food search (no re-run of the model).
  // Re-derives the stepper for the new food and drops any correction-memory
  // "usual" adjustment; the model's alternatives list is preserved.
  const changeItemFood = (idx: number, food: FoodItem) => {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== idx) return it;
        const alternatives = it.alternatives.some((a) => a.ref === food.ref)
          ? it.alternatives
          : [food, ...it.alternatives];
        return {
          ...it,
          ...reprojectMatch(it, food),
          alternatives,
          showAlternatives: false,
          usualFrom: null,
        };
      })
    );
    setSearchItemIdx(null);
  };

  const removeItem = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  // Put the model's own portion estimate back (undo the correction-memory
  // adjustment for this item).
  const revertUsual = (idx: number) => {
    const item = items[idx];
    const from = item?.usualFrom;
    if (from == null) return;
    // Reverting to the model's grams re-seeds the stepper against that amount.
    const info: StepInfo | null =
      item.serving != null ? { serving: item.serving, fractional: item.stepFractional } : null;
    updateItem(idx, {
      grams: from,
      gramsText: String(from),
      usualFrom: null,
      stepCount: info ? initCount(from, info) : null,
    });
  };

  const logAll = async () => {
    if (items.length === 0 || saving || !claim) return;
    setSaving(true);
    try {
      const corrections: LoggedCorrection[] = [];
      const savedItems: SavedAiItem[] = [];
      for (const item of items) {
        const macros = resolvedMacros(item);
        if (item.match) {
          const unit = item.match.unit ?? 'g';
          await logFood(item.match, {
            day,
            meal,
            grams: item.grams,
            quantityDesc: `${fmtGrams(item.grams)} ${unit}`,
            origin: 'assist',
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
        savedItems.push({
          claim: item.claim,
          name: displayName(item),
          grams: item.grams,
          matchedName: item.match?.name ?? null,
        });
      }
      await recordAiEvent(turns, corrections, { claim, items: savedItems, meal });
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
                Describe what you ate. You can answer follow-up questions before anything is
                logged.
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
              {error && <ErrorActions message={error} onRetry={retry} onSearch={searchManually} />}
              <PrimaryButton label="Estimate nutrition" disabled={!text.trim()} onPress={submit} />
            </>
          )}

          {phase === 'estimating' && (
            <>
              {streamItems.length > 0 && (
                <View style={styles.streamList}>
                  {streamItems.map((s, i) =>
                    s ? (
                      <ThemedView key={i} type="backgroundElement" style={styles.streamRow}>
                        <ThemedText type="small" numberOfLines={1} style={styles.flex}>
                          {s.name || '…'}
                        </ThemedText>
                        <ThemedText type="small" themeColor="textSecondary">
                          {fmtGrams(s.grams)} g
                        </ThemedText>
                      </ThemedView>
                    ) : null
                  )}
                </View>
              )}
              <EstimatingIndicator count={streamItems.filter(Boolean).length} />
            </>
          )}

          {phase === 'review' && claim && (
            <>
              {claim.needs_clarification && (
                <ThemedView type="backgroundElement" style={styles.clarifyCard}>
                  <ThemedText type="smallBold">
                    Quick question{claim.questions.length > 1 ? 's' : ''}
                  </ThemedText>
                  {claim.questions.map((q, i) => (
                    <View key={i} style={styles.clarifyQuestion}>
                      <ThemedText type="small">{q}</ThemedText>
                      <TextInput
                        style={[
                          styles.input,
                          { backgroundColor: theme.background, color: theme.text },
                        ]}
                        value={clarifyAnswers[i] ?? ''}
                        onChangeText={(t) =>
                          setClarifyAnswers((prev) => {
                            const next = prev.slice();
                            next[i] = t;
                            return next;
                          })
                        }
                        placeholder="Type your answer…"
                        placeholderTextColor={theme.textSecondary}
                        returnKeyType={i === claim.questions.length - 1 ? 'send' : 'next'}
                        onSubmitEditing={
                          i === claim.questions.length - 1 ? sendClarification : undefined
                        }
                      />
                    </View>
                  ))}
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
                  onStep={(dir) => stepItem(idx, dir)}
                  onToggleAlternatives={() =>
                    updateItem(idx, { showAlternatives: !item.showAlternatives })
                  }
                  onChooseMatch={(m) => chooseMatch(idx, m)}
                  onRemove={() => removeItem(idx)}
                  onRevertUsual={() => revertUsual(idx)}
                  onChangeFood={() => setSearchItemIdx(idx)}
                />
              ))}

              {error && <ErrorActions message={error} onRetry={retry} onSearch={searchManually} />}

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
        {searchItemIdx != null && items[searchItemIdx] && (
          <FoodSearchModal
            title="Change food"
            initialQuery={items[searchItemIdx].claim.name}
            onSelect={(food) => changeItemFood(searchItemIdx, food)}
            onClose={() => setSearchItemIdx(null)}
          />
        )}
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

/** Compact, legible cue pill for the review cards (trust cues / warnings). */
function Cue({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.cue, { borderColor: color }]}>
      <ThemedText style={[styles.cueText, { color }]}>{label}</ThemedText>
    </View>
  );
}

/** Error state that's never a dead end: retry (jittered) or bail to search. */
function ErrorActions({
  message,
  onRetry,
  onSearch,
}: {
  message: string;
  onRetry: () => void;
  onSearch: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.errorBox}>
      <ThemedText type="small" style={{ color: theme.danger }}>
        {message}
      </ThemedText>
      <View style={styles.buttonRow}>
        <ActionButton label="Try again" onPress={onRetry} />
        <ActionButton label="Search manually" onPress={onSearch} />
      </View>
    </View>
  );
}

function ItemCard({
  item,
  onGramsChange,
  onStep,
  onToggleAlternatives,
  onChooseMatch,
  onRemove,
  onRevertUsual,
  onChangeFood,
}: {
  item: ReviewItem;
  onGramsChange: (text: string) => void;
  onStep: (dir: 1 | -1) => void;
  onToggleAlternatives: () => void;
  onChooseMatch: (match: FoodItem | null) => void;
  onRemove: () => void;
  onRevertUsual: () => void;
  onChangeFood: () => void;
}) {
  const theme = useTheme();
  const macros = resolvedMacros(item);
  // Below the prompt's "real uncertainty" line — invite an edit, don't block.
  const lowConfidence = item.claim.confidence < 0.6;

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
          style={[
            styles.gramsInput,
            { backgroundColor: theme.background, color: theme.text },
            lowConfidence && styles.gramsInputUncertain,
          ]}
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

      {item.serving != null && (
        <View style={styles.stepperRow}>
          <StepperButton label="−" onPress={() => onStep(-1)} />
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.stepperLabel}
            numberOfLines={1}>
            {item.stepCount != null
              ? `${fmtGrams(item.stepCount)} × ${fmtGrams(item.serving)} g each`
              : `Custom · ${fmtGrams(item.serving)} g / serving`}
          </ThemedText>
          <StepperButton label="+" onPress={() => onStep(1)} />
        </View>
      )}

      {/* Trust cues as legible pills (not raw colored text). */}
      {(lowConfidence || item.match == null) && (
        <View style={styles.cueRow}>
          {item.match == null && <Cue label="AI estimate · no DB match" color={theme.danger} />}
          {lowConfidence && <Cue label="Low confidence — double-check" color={MacroColors.carbs} />}
        </View>
      )}

      {item.usualFrom != null && (
        <Pressable hitSlop={4} onPress={onRevertUsual}>
          <ThemedText type="small" themeColor="textSecondary">
            Adjusted to your usual · tap to use the model’s {fmtGrams(item.usualFrom)} g
          </ThemedText>
        </Pressable>
      )}

      <FractionChips
        value={parseDecimal(item.gramsText)}
        onValue={(v) => onGramsChange(fmtGrams(v))}
      />

      <View style={styles.matchRow}>
        <Pressable style={styles.flex} onPress={onToggleAlternatives}>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {item.match
              ? `≈ ${item.match.displayName ?? item.match.name}`
              : 'Using the model’s estimate'}
            {'  ›'}
          </ThemedText>
        </Pressable>
        <Pressable hitSlop={8} onPress={onChangeFood}>
          <ThemedText type="small" style={{ color: MacroColors.kcal }}>
            Change food
          </ThemedText>
        </Pressable>
      </View>

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
                {alt.displayName ?? alt.name} ({fmtKcal(alt.per100.kcal)} kcal/100g)
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

function StepperButton({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={[styles.stepperButton, { backgroundColor: theme.background }]}>
      <ThemedText type="smallBold">{label}</ThemedText>
    </Pressable>
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
  gramsInputUncertain: {
    borderWidth: 1,
    borderColor: MacroColors.carbs,
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  stepperLabel: {
    flex: 1,
    textAlign: 'center',
  },
  stepperButton: {
    minWidth: 44,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.two,
    alignItems: 'center',
  },
  streamList: {
    gap: Spacing.two,
  },
  streamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
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
  clarifyQuestion: {
    gap: Spacing.one,
  },
  errorBox: {
    gap: Spacing.two,
  },
  cueRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  cue: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: 1,
  },
  cueText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
  matchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
});
