import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  deleteLocalModel,
  downloadLocalModel,
  getLocalModelStatus,
  LOCAL_MODEL_TOTAL_BYTES,
  type LocalModelStatus,
} from '@/lib/ai/local-model';
import { exportFoodLog, exportTrainingData } from '@/lib/export';
import { getFoodDbInfo } from '@/lib/foods';
import { parseDecimal } from '@/lib/macros';
import { NUTRIENTS, NUTRIENTS_BY_KEY, type NutrientKey } from '@/lib/nutrients';
import { getTracking, setTracking, type TrackingConfig } from '@/lib/tracking';

type GoalText = Record<NutrientKey, string>;

const emptyGoalText = () =>
  Object.fromEntries(NUTRIENTS.map((n) => [n.key, ''])) as GoalText;

export default function SettingsScreen() {
  const theme = useTheme();
  const [enabled, setEnabled] = useState<Record<NutrientKey, boolean>>(() =>
    Object.fromEntries(NUTRIENTS.map((n) => [n.key, n.defaultEnabled])) as Record<
      NutrientKey,
      boolean
    >
  );
  const [goalText, setGoalText] = useState<GoalText>(emptyGoalText);
  const [dbInfo, setDbInfo] = useState<{ count: number; sources: string } | null>(null);
  const [modelStatus, setModelStatus] = useState<LocalModelStatus | null>(null);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);

  useEffect(() => {
    getTracking().then((cfg) => {
      const en = {} as Record<NutrientKey, boolean>;
      const gt = emptyGoalText();
      for (const n of NUTRIENTS) {
        en[n.key] = cfg[n.key].enabled;
        gt[n.key] = cfg[n.key].goal != null ? String(Math.round(cfg[n.key].goal!)) : '';
      }
      setEnabled(en);
      setGoalText(gt);
    });
    getFoodDbInfo().then(setDbInfo);
    getLocalModelStatus().then(setModelStatus);
  }, []);

  const toggle = (key: NutrientKey) => {
    const turningOn = !enabled[key];
    setEnabled((prev) => ({ ...prev, [key]: turningOn }));
    // Seed a suggested goal the first time a nutrient is switched on.
    if (turningOn && !goalText[key]) {
      const def = NUTRIENTS_BY_KEY[key].defaultGoal;
      if (def != null) setGoalText((prev) => ({ ...prev, [key]: String(def) }));
    }
  };

  const downloadModel = async () => {
    setDownloadPct(0);
    try {
      await downloadLocalModel((f) => setDownloadPct(f));
      setModelStatus(await getLocalModelStatus());
    } catch (e) {
      Alert.alert('Download failed', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setDownloadPct(null);
    }
  };

  const removeModel = () => {
    Alert.alert('Delete on-device model?', 'You can re-download it later.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteLocalModel();
          setModelStatus(await getLocalModelStatus());
        },
      },
    ]);
  };

  const save = async () => {
    // For enabled nutrients, a blank goal means "no target"; a non-blank goal
    // must be a number. Disabled nutrients keep whatever goal they had.
    const num = (t: string): number | null => (t.trim() ? parseDecimal(t) : null);
    const invalid = (t: string) => t.trim() !== '' && parseDecimal(t) == null;
    if (NUTRIENTS.some((n) => enabled[n.key] && invalid(goalText[n.key]))) {
      Alert.alert('Invalid goal', 'Goals must be numbers, or left blank for no target.');
      return;
    }
    const config = {} as TrackingConfig;
    for (const n of NUTRIENTS) {
      config[n.key] = { enabled: enabled[n.key], goal: num(goalText[n.key]) };
    }
    await setTracking(config);
    router.back();
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ThemedView style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <ThemedText type="smallBold">Nutrients & goals</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Toggle what you want to track. For anything on, set a daily goal — or
            leave it blank to track the amount without a target.
          </ThemedText>
          <View style={styles.nutrientList}>
            {NUTRIENTS.map((n) => (
              <NutrientRow
                key={n.key}
                label={n.label}
                unit={n.unit}
                color={n.color}
                enabled={enabled[n.key]}
                goal={goalText[n.key]}
                onToggle={() => toggle(n.key)}
                onGoal={(t) => setGoalText((prev) => ({ ...prev, [n.key]: t }))}
              />
            ))}
          </View>

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            AI assistant
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Meals are estimated by the fine-tuned model running entirely on your phone — no
            network, no API cost, nothing leaves the device. Download it once to enable AI
            logging.
          </ThemedText>
          <OnDeviceModel
            status={modelStatus}
            downloadPct={downloadPct}
            onDownload={downloadModel}
            onDelete={removeModel}
          />

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

function OnDeviceModel({
  status,
  downloadPct,
  onDownload,
  onDelete,
}: {
  status: LocalModelStatus | null;
  downloadPct: number | null;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const sizeGb = (LOCAL_MODEL_TOTAL_BYTES / 1e9).toFixed(1);

  if (status == null) return null;
  if (status === 'unsupported') {
    return (
      <ThemedText type="small" themeColor="textSecondary">
        On-device AI needs an iOS/Android dev build — not available on web.
      </ThemedText>
    );
  }

  if (downloadPct != null) {
    return (
      <View style={styles.modelRow}>
        <ActivityIndicator color={MacroColors.kcal} />
        <ThemedText type="small" themeColor="textSecondary">
          Downloading model… {Math.round(downloadPct * 100)}%
        </ThemedText>
      </View>
    );
  }

  if (status === 'ready') {
    return (
      <View style={styles.modelRow}>
        <ThemedText type="small">On-device model installed ✓</ThemedText>
        <Pressable hitSlop={8} onPress={onDelete}>
          <ThemedText type="small" style={{ color: MacroColors.protein }}>
            Delete
          </ThemedText>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ gap: Spacing.two }}>
      <Pressable
        style={[styles.chip, { backgroundColor: theme.backgroundElement, borderColor: 'transparent' }]}
        onPress={onDownload}>
        <ThemedText type="small">Download on-device model ({sizeGb} GB, Wi-Fi recommended)</ThemedText>
      </Pressable>
      <ThemedText type="small" style={{ color: MacroColors.carbs }}>
        ⚠ One-time download, and the model runs entirely on your phone. On a recent
        device an estimate takes a few seconds; on older or lower-memory phones it
        may be slower.
      </ThemedText>
    </View>
  );
}

function NutrientRow({
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
  flex: { flex: 1 },
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
  },
  nutrientList: {
    gap: Spacing.two,
  },
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
  sectionTitle: {
    marginTop: Spacing.three,
  },
  modelChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
