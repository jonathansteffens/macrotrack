import { Platform, StyleSheet, Switch, TextInput, View } from 'react-native';

import { ThemedText } from './themed-text';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * One trackable nutrient: an on/off switch plus, when on, its optional daily
 * goal. Used by Settings and the first-launch onboarding.
 */
export function NutrientRow({
  label,
  unit,
  color,
  enabled,
  goal,
  onToggle,
  onGoal,
}: {
  label: string;
  unit: string;
  color: string;
  enabled: boolean;
  goal: string;
  onToggle: () => void;
  onGoal: (v: string) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.nutrientRow}>
      <Switch
        value={enabled}
        onValueChange={onToggle}
        trackColor={{ true: color }}
        thumbColor={Platform.OS === 'android' ? (enabled ? color : undefined) : undefined}
      />
      <ThemedText
        type="small"
        themeColor={enabled ? 'text' : 'textSecondary'}
        style={styles.nutrientLabel}>
        {label}
      </ThemedText>
      {enabled && (
        <View style={styles.goalEntry}>
          <TextInput
            style={[
              styles.goalInput,
              { backgroundColor: theme.backgroundElement, color: theme.text },
            ]}
            value={goal}
            onChangeText={onGoal}
            keyboardType="number-pad"
            placeholder="no goal"
            placeholderTextColor={theme.textSecondary}
          />
          {unit ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.goalUnit}>
              {unit}
            </ThemedText>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  nutrientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  nutrientLabel: {
    flex: 1,
  },
  goalEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  goalInput: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
    minWidth: 84,
    textAlign: 'right',
  },
  goalUnit: {
    width: 26,
  },
});
