import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  ACTIVITY_LEVELS,
  CM_PER_IN,
  GOAL_AIMS,
  KG_PER_LB,
  suggestGoals,
  type ActivityKey,
  type AimKey,
  type GoalSuggestion,
  type Sex,
} from '@/lib/goal-calc';
import { fmtKcal, parseDecimal } from '@/lib/macros';

/**
 * "Calculate for me" form: estimates calorie + macro goals from age, sex,
 * size, activity, and aim (see lib/goal-calc.ts for the math). Applying just
 * prefills the goal fields — nothing is locked in.
 */
export function GoalCalculator({ onApply }: { onApply: (goals: GoalSuggestion) => void }) {
  const theme = useTheme();
  const [sex, setSex] = useState<Sex | null>(null);
  const [units, setUnits] = useState<'metric' | 'imperial'>('metric');
  const [ageText, setAgeText] = useState('');
  const [heightCmText, setHeightCmText] = useState('');
  const [heightFtText, setHeightFtText] = useState('');
  const [heightInText, setHeightInText] = useState('');
  const [weightText, setWeightText] = useState('');
  const [activity, setActivity] = useState<ActivityKey>('light');
  const [aim, setAim] = useState<AimKey>('maintain');

  const age = parseDecimal(ageText);
  const weight = parseDecimal(weightText);
  const weightKg = weight != null ? (units === 'metric' ? weight : weight * KG_PER_LB) : null;
  let heightCm: number | null = null;
  if (units === 'metric') {
    heightCm = parseDecimal(heightCmText);
  } else {
    const ft = parseDecimal(heightFtText);
    const inches = parseDecimal(heightInText) ?? 0; // inches may be left blank
    if (ft != null) heightCm = (ft * 12 + inches) * CM_PER_IN;
  }

  const suggestion =
    sex != null &&
    age != null &&
    age > 0 &&
    weightKg != null &&
    weightKg > 0 &&
    heightCm != null &&
    heightCm > 0
      ? suggestGoals({ sex, ageYears: age, weightKg, heightCm, activity, aim })
      : null;

  const inputStyle = [styles.input, { backgroundColor: theme.background, color: theme.text }];

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <View style={styles.chipRow}>
        <Chip label="Female" selected={sex === 'female'} onPress={() => setSex('female')} />
        <Chip label="Male" selected={sex === 'male'} onPress={() => setSex('male')} />
        <View style={styles.spacer} />
        <Chip label="kg · cm" selected={units === 'metric'} onPress={() => setUnits('metric')} />
        <Chip label="lb · ft" selected={units === 'imperial'} onPress={() => setUnits('imperial')} />
      </View>

      <View style={styles.fieldRow}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.fieldLabel}>
          Age
        </ThemedText>
        <TextInput
          style={inputStyle}
          value={ageText}
          onChangeText={setAgeText}
          keyboardType="number-pad"
          placeholder="years"
          placeholderTextColor={theme.textSecondary}
        />
      </View>

      <View style={styles.fieldRow}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.fieldLabel}>
          Height
        </ThemedText>
        {units === 'metric' ? (
          <TextInput
            style={inputStyle}
            value={heightCmText}
            onChangeText={setHeightCmText}
            keyboardType="decimal-pad"
            placeholder="cm"
            placeholderTextColor={theme.textSecondary}
          />
        ) : (
          <>
            <TextInput
              style={inputStyle}
              value={heightFtText}
              onChangeText={setHeightFtText}
              keyboardType="number-pad"
              placeholder="ft"
              placeholderTextColor={theme.textSecondary}
            />
            <TextInput
              style={inputStyle}
              value={heightInText}
              onChangeText={setHeightInText}
              keyboardType="number-pad"
              placeholder="in"
              placeholderTextColor={theme.textSecondary}
            />
          </>
        )}
      </View>

      <View style={styles.fieldRow}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.fieldLabel}>
          Weight
        </ThemedText>
        <TextInput
          style={inputStyle}
          value={weightText}
          onChangeText={setWeightText}
          keyboardType="decimal-pad"
          placeholder={units === 'metric' ? 'kg' : 'lb'}
          placeholderTextColor={theme.textSecondary}
        />
      </View>

      <ThemedText type="small" themeColor="textSecondary">
        Activity level
      </ThemedText>
      <View style={styles.chipRow}>
        {ACTIVITY_LEVELS.map((a) => (
          <Chip
            key={a.key}
            label={a.label}
            selected={activity === a.key}
            onPress={() => setActivity(a.key)}
          />
        ))}
      </View>

      <ThemedText type="small" themeColor="textSecondary">
        Aim (lose ≈ −500 kcal/day, gain +300)
      </ThemedText>
      <View style={styles.chipRow}>
        {GOAL_AIMS.map((a) => (
          <Chip key={a.key} label={a.label} selected={aim === a.key} onPress={() => setAim(a.key)} />
        ))}
      </View>

      {suggestion && (
        <ThemedText type="small">
          Suggests {fmtKcal(suggestion.kcal)} kcal: protein {suggestion.protein} g, carbs{' '}
          {suggestion.carbs} g, fat {suggestion.fat} g
        </ThemedText>
      )}
      <Pressable
        disabled={!suggestion}
        style={[
          styles.applyButton,
          { backgroundColor: theme.tintSolid, opacity: suggestion ? 1 : 0.4 },
        ]}
        onPress={() => suggestion && onApply(suggestion)}>
        <ThemedText type="smallBold" style={styles.applyText}>
          Use these goals
        </ThemedText>
      </Pressable>
      <ThemedText type="small" themeColor="textSecondary">
        Estimates only. The goal fields stay editable.
      </ThemedText>
    </ThemedView>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: selected ? theme.tintSurface : theme.background,
          borderColor: selected ? theme.tint : 'transparent',
        },
      ]}>
      <ThemedText type="small" themeColor={selected ? 'tint' : 'textSecondary'}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.card,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.two,
  },
  spacer: {
    flex: 1,
  },
  chip: {
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderWidth: 1,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  fieldLabel: {
    width: 56,
  },
  input: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
    textAlign: 'center',
  },
  applyButton: {
    borderRadius: Radius.control,
    paddingVertical: Spacing.two + 2,
    alignItems: 'center',
  },
  applyText: {
    color: '#ffffff',
  },
});
