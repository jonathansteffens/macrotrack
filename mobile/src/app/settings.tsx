import { router } from 'expo-router';
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

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { AI_MODELS, getAiModel, getApiKey, setAiModel, setApiKey } from '@/lib/ai/config';
import {
  ENGINE_MODES,
  getEngineMode,
  setEngineMode,
  type EngineMode,
} from '@/lib/ai/engine';
import { exportFoodLog, exportTrainingData } from '@/lib/export';
import { getFoodDbInfo } from '@/lib/foods';
import { getGoals, setGoals } from '@/lib/goals';
import { parseDecimal } from '@/lib/macros';

export default function SettingsScreen() {
  const theme = useTheme();
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [dbInfo, setDbInfo] = useState<{ count: number; sources: string } | null>(null);
  const [apiKey, setApiKeyState] = useState('');
  const [model, setModel] = useState<string>(AI_MODELS[0].id);
  const [engine, setEngine] = useState<EngineMode>('cloud');

  useEffect(() => {
    getGoals().then((g) => {
      setKcal(String(Math.round(g.kcal)));
      setProtein(String(Math.round(g.protein)));
      setCarbs(String(Math.round(g.carbs)));
      setFat(String(Math.round(g.fat)));
    });
    getFoodDbInfo().then(setDbInfo);
    getApiKey().then((k) => setApiKeyState(k ?? ''));
    getAiModel().then(setModel);
    getEngineMode().then(setEngine);
  }, []);

  const save = async () => {
    const g = {
      kcal: parseDecimal(kcal),
      protein: parseDecimal(protein),
      carbs: parseDecimal(carbs),
      fat: parseDecimal(fat),
    };
    if (g.kcal == null || g.protein == null || g.carbs == null || g.fat == null) {
      Alert.alert('Invalid goals', 'All four goals must be numbers.');
      return;
    }
    await setGoals({ kcal: g.kcal, protein: g.protein, carbs: g.carbs, fat: g.fat });
    await setApiKey(apiKey);
    await setAiModel(model);
    await setEngineMode(engine);
    router.back();
  };

  const inputStyle = [
    styles.input,
    { backgroundColor: theme.backgroundElement, color: theme.text },
  ];

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ThemedView style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <ThemedText type="smallBold">Daily goals</ThemedText>
          <View style={styles.grid}>
            <GoalField label="Calories" value={kcal} onChange={setKcal} style={inputStyle} />
            <GoalField label="Protein (g)" value={protein} onChange={setProtein} style={inputStyle} />
            <GoalField label="Carbs (g)" value={carbs} onChange={setCarbs} style={inputStyle} />
            <GoalField label="Fat (g)" value={fat} onChange={setFat} style={inputStyle} />
          </View>

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            AI assistant
          </ThemedText>
          <View style={styles.goalField}>
            <ThemedText type="small" themeColor="textSecondary">
              Anthropic API key (stored in device keychain)
            </ThemedText>
            <TextInput
              style={inputStyle}
              value={apiKey}
              onChangeText={setApiKeyState}
              placeholder="sk-ant-…"
              placeholderTextColor={theme.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            Cloud model
          </ThemedText>
          <View style={styles.modelChips}>
            {AI_MODELS.map((m) => (
              <Pressable
                key={m.id}
                onPress={() => setModel(m.id)}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      model === m.id ? theme.backgroundSelected : theme.backgroundElement,
                    borderColor: model === m.id ? MacroColors.kcal : 'transparent',
                  },
                ]}>
                <ThemedText type="small" themeColor={model === m.id ? 'text' : 'textSecondary'}>
                  {m.label}
                </ThemedText>
              </Pressable>
            ))}
          </View>

          <ThemedText type="small" themeColor="textSecondary">
            Estimator engine — “Local stand-in” runs a pipeline of small Haiku calls in place of
            the future on-device model; “Auto” tries it first and escalates to cloud when it
            isn’t confident.
          </ThemedText>
          <View style={styles.modelChips}>
            {ENGINE_MODES.map((m) => (
              <Pressable
                key={m.id}
                onPress={() => setEngine(m.id)}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      engine === m.id ? theme.backgroundSelected : theme.backgroundElement,
                    borderColor: engine === m.id ? MacroColors.kcal : 'transparent',
                  },
                ]}>
                <ThemedText type="small" themeColor={engine === m.id ? 'text' : 'textSecondary'}>
                  {m.label}
                </ThemedText>
              </Pressable>
            ))}
          </View>

          <Pressable style={[styles.saveButton, { backgroundColor: MacroColors.kcal }]} onPress={save}>
            <ThemedText type="smallBold" style={styles.saveText}>
              Save
            </ThemedText>
          </Pressable>

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Your data
          </ThemedText>
          <View style={styles.modelChips}>
            <Pressable
              style={[styles.chip, { backgroundColor: theme.backgroundElement, borderColor: 'transparent' }]}
              onPress={async () => {
                const n = await exportTrainingData();
                if (n === 0) Alert.alert('Nothing to export', 'No AI interactions recorded yet.');
              }}>
              <ThemedText type="small">Export AI training data</ThemedText>
            </Pressable>
            <Pressable
              style={[styles.chip, { backgroundColor: theme.backgroundElement, borderColor: 'transparent' }]}
              onPress={() => exportFoodLog()}>
              <ThemedText type="small">Export food log</ThemedText>
            </Pressable>
          </View>

          {dbInfo && (
            <View style={styles.aboutSection}>
              <ThemedText type="smallBold">Food database</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {dbInfo.count.toLocaleString()} generic foods bundled offline ({dbInfo.sources}).
                Barcode scans use Open Food Facts and are cached on this device. All of your log
                data stays local.
              </ThemedText>
            </View>
          )}
        </ScrollView>
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

function GoalField({
  label,
  value,
  onChange,
  style,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  style: any;
}) {
  return (
    <View style={styles.goalField}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <TextInput style={style} value={value} onChangeText={onChange} keyboardType="number-pad" />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  goalField: {
    width: '47%',
    flexGrow: 1,
    gap: Spacing.one,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  sectionTitle: {
    marginTop: Spacing.three,
  },
  modelChips: {
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
  saveButton: {
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.two,
  },
  saveText: { color: '#ffffff' },
  aboutSection: {
    marginTop: Spacing.four,
    gap: Spacing.one,
  },
});
