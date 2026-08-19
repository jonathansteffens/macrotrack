import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useUnitPrefs } from '@/hooks/use-unit-prefs';
import { parseDecimal } from '@/lib/macros';
import type { FoodItem } from '@/lib/types';
import {
  amountUnitOptions,
  formatAmountValue,
  gramsToUnit,
  toGrams,
  type AmountUnit,
  type UnitChoice,
} from '@/lib/units';

/**
 * An amount field denominated in the food's own unit.
 *
 * Showing "3 nuggets" and then making the user type 48 grams to change it is the
 * same mismatch the display work removed, only moved one step later — so a field
 * opens in whatever unit the food reads in (servings for packaged foods and
 * recipes, pieces for countable ones, fl oz for drinks, oz for solids in US
 * mode), honouring the Settings → Units system and per-class overrides.
 *
 * Grams remain the stored value: what the caller receives is always grams,
 * converted at this boundary. Grams also remain selectable — the last chip is
 * always `g`, so the unit is a default rather than a constraint.
 *
 * Single component rather than per-screen copies because the conversion,
 * rounding and re-sync rules have to agree everywhere an amount is typed.
 */
export function AmountInput({
  grams,
  onGramsChange,
  name,
  match = null,
  liquid,
  autoFocus,
  compact,
  preferGrams,
}: {
  grams: number | null;
  onGramsChange: (grams: number | null) => void;
  name: string;
  match?: FoodItem | null;
  /** Force the drink class when there is no FoodItem to classify from. */
  liquid?: boolean;
  autoFocus?: boolean;
  /** Tighter layout for list rows (recipe ingredients, assist items). */
  compact?: boolean;
  /** Grams first (AI review rows: the model already converted the user's
   *  phrase to grams — that conversion is the number being reviewed). */
  preferGrams?: boolean;
}) {
  const theme = useTheme();
  const prefs = useUnitPrefs();
  let options = amountUnitOptions({ name, match, prefs, liquid });
  if (preferGrams) {
    const gIdx = options.findIndex((o) => o.choice === 'g' || o.choice === 'ml');
    if (gIdx > 0) options = [options[gIdx], ...options.slice(0, gIdx), ...options.slice(gIdx + 1)];
  }
  // The chosen unit is stored as a choice, not an object, and resolved against
  // the current options each render — so a chip whose per-unit weight has gone
  // away (food swapped, preference changed) can never stay selected.
  const [choice, setChoice] = useState<UnitChoice | null>(null);
  const unit = options.find((o) => o.choice === choice) ?? options[0];

  // The text is DERIVED from grams, except while the user is mid-edit. The
  // draft carries the grams it produced, so it can win exactly as long as the
  // parent is still showing this field's own value; anything else arriving (a
  // stepper, a portion chip, correction memory) is an external change and the
  // derived text takes over. Storing the pair rather than consulting a ref
  // keeps this a pure render — and deriving rather than syncing in an effect is
  // what stops the field rewriting a half-typed number under the user.
  const [draft, setDraft] = useState<{ text: string; grams: number | null } | null>(null);

  const derived = (() => {
    if (grams == null) return '';
    const v = gramsToUnit(grams, unit.choice, unit.perUnit);
    return v == null ? '' : formatAmountValue(v, unit.choice);
  })();
  const text = draft && draft.grams === grams ? draft.text : derived;

  const onText = (next: string) => {
    const v = parseDecimal(next);
    const g = v == null ? null : toGrams(v, unit.choice, unit.perUnit);
    const rounded = g == null ? null : Math.round(g * 10) / 10;
    setDraft({ text: next, grams: rounded });
    onGramsChange(rounded);
  };

  /** Switching units re-denominates the same amount rather than clearing it. */
  const chooseUnit = (next: AmountUnit) => {
    if (next.choice === unit.choice) return;
    setChoice(next.choice);
    setDraft(null); // fall back to the derived text in the new unit
  };

  return (
    <View style={compact ? styles.compactRoot : styles.root}>
      <View style={styles.row}>
        <TextInput
          style={[
            compact ? styles.inputCompact : styles.input,
            { backgroundColor: theme.background, color: theme.text },
          ]}
          value={text}
          onChangeText={onText}
          keyboardType="decimal-pad"
          selectTextOnFocus
          autoFocus={autoFocus}
        />
        <ThemedText type="small" themeColor="textSecondary">
          {unit.label}
        </ThemedText>
      </View>
      {options.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.chips}>
            {options.map((o) => {
              const selected = o.choice === unit.choice;
              return (
                <Pressable
                  key={o.choice}
                  onPress={() => chooseUnit(o)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: selected ? theme.tintSurface : theme.backgroundElement,
                      borderColor: selected ? theme.tint : 'transparent',
                    },
                  ]}>
                  <ThemedText type="small" themeColor={selected ? 'tint' : 'textSecondary'}>
                    {o.label}
                  </ThemedText>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: Spacing.two },
  compactRoot: { gap: Spacing.one },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
    minWidth: 110,
    textAlign: 'center',
  },
  inputCompact: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    fontSize: 16,
    minWidth: 84,
    textAlign: 'center',
  },
  chips: { flexDirection: 'row', gap: Spacing.two },
  chip: {
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
});
