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
import { getGoals, setGoals } from '@/lib/goals';
import { parseDecimal } from '@/lib/macros';

export default function SettingsScreen() {
  const theme = useTheme();
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [fiber, setFiber] = useState('');
  const [dbInfo, setDbInfo] = useState<{ count: number; sources: string } | null>(null);
  const [modelStatus, setModelStatus] = useState<LocalModelStatus | null>(null);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);

  useEffect(() => {
    getGoals().then((g) => {
      const s = (v: number | null) => (v != null ? String(Math.round(v)) : '');
      setKcal(s(g.kcal));
      setProtein(s(g.protein));
      setCarbs(s(g.carbs));
      setFat(s(g.fat));
      setFiber(s(g.fiber));
    });
    getFoodDbInfo().then(setDbInfo);
    getLocalModelStatus().then(setModelStatus);
  }, []);

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
    // A blank field means "no goal" (null); a non-blank field must be a number.
    const num = (t: string): number | null => (t.trim() ? parseDecimal(t) : null);
    const invalid = (t: string) => t.trim() !== '' && parseDecimal(t) == null;
    if ([kcal, protein, carbs, fat, fiber].some(invalid)) {
      Alert.alert('Invalid goal', 'Goals must be numbers, or left blank for no goal.');
      return;
    }
    await setGoals({
      kcal: num(kcal),
      protein: num(protein),
      carbs: num(carbs),
      fat: num(fat),
      fiber: num(fiber),
    });
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
            <GoalField label="Fiber (g)" value={fiber} onChange={setFiber} style={inputStyle} />
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            Leave a goal blank to still track it, but without a target.
          </ThemedText>

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
