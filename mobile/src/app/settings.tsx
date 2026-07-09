import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
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
  View,
} from 'react-native';

import { GoalCalculator } from '@/components/goal-calculator';
import { NutrientRow } from '@/components/nutrient-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useTrackingEditor } from '@/hooks/use-tracking-editor';
import {
  deleteLocalModel,
  downloadLocalModel,
  getLocalModelStatus,
  LOCAL_MODEL_TOTAL_BYTES,
  type LocalModelStatus,
} from '@/lib/ai/local-model';
import { exportBackup, getLastBackupAt, parseBackup, restoreBackup } from '@/lib/backup';
import {
  CHECKIN_HOURS,
  checkinLabel,
  checkinPermissionMissing,
  checkinSupported,
  getCheckinHour,
  requestCheckinPermission,
  setCheckinHour,
} from '@/lib/checkin';
import { DAY_END_OPTIONS, dayEndLabel, getDayEndHour, setDayEndHour } from '@/lib/day-end';
import { exportFoodLog, exportTrainingData } from '@/lib/export';
import { getFoodDbInfo } from '@/lib/foods';
import { NUTRIENTS } from '@/lib/nutrients';
import { setTracking } from '@/lib/tracking';

export default function SettingsScreen() {
  const theme = useTheme();
  const editor = useTrackingEditor();
  const [dbInfo, setDbInfo] = useState<{ count: number; sources: string } | null>(null);
  const [modelStatus, setModelStatus] = useState<LocalModelStatus | null>(null);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [dayEnd, setDayEnd] = useState<number | null>(null);
  const [checkin, setCheckin] = useState<number | null>(null);
  const [checkinPermMissing, setCheckinPermMissing] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);
  const [lastBackup, setLastBackup] = useState<string | null>(null);

  useEffect(() => {
    getFoodDbInfo().then(setDbInfo);
    getLocalModelStatus().then(setModelStatus);
    getDayEndHour().then(setDayEnd);
    getCheckinHour().then(setCheckin);
    checkinPermissionMissing().then(setCheckinPermMissing);
    getLastBackupAt().then(setLastBackup);
  }, []);

  // Persisted immediately — no Save step needed for this one.
  const chooseDayEnd = (hour: number) => {
    setDayEnd(hour);
    setDayEndHour(hour);
  };

  // Also persisted immediately. Turning it on asks for permission right away;
  // a denial keeps the hour saved but shows the "permission needed" state.
  const chooseCheckin = async (hour: number | null) => {
    setCheckin(hour);
    if (hour != null) {
      const granted = await requestCheckinPermission();
      setCheckinPermMissing(!granted);
    } else {
      setCheckinPermMissing(false);
    }
    await setCheckinHour(hour);
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
    const config = editor.buildConfig();
    if (!config) {
      Alert.alert('Invalid goal', 'Goals must be numbers, or left blank for no target.');
      return;
    }
    await setTracking(config);
    // Stay on the screen and clear the dirty state — the sticky footer hides
    // itself once there's nothing unsaved.
    editor.markSaved();
  };

  const backupNow = async () => {
    try {
      await exportBackup();
      setLastBackup(await getLastBackupAt());
    } catch (e) {
      Alert.alert('Backup failed', e instanceof Error ? e.message : 'Please try again.');
    }
  };

  const restoreFromFile = async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: 'application/json',
        copyToCacheDirectory: true,
      });
      if (picked.canceled) return;
      const backup = parseBackup(await new File(picked.assets[0].uri).text());
      const madeOn = backup.exportedAt
        ? new Date(backup.exportedAt).toLocaleDateString()
        : 'an unknown date';
      Alert.alert(
        'Restore from backup?',
        `This backup from ${madeOn} has ${backup.data.log_entries.length} log entries. ` +
          'Restoring replaces everything currently in the app — this cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Replace & restore',
            style: 'destructive',
            onPress: async () => {
              try {
                await restoreBackup(backup);
                Alert.alert('Restore complete', 'Your data has been restored.', [
                  { text: 'OK', onPress: () => router.back() },
                ]);
              } catch (e) {
                Alert.alert(
                  'Restore failed',
                  e instanceof Error ? e.message : 'Nothing was changed.'
                );
              }
            },
          },
        ]
      );
    } catch (e) {
      Alert.alert('Restore failed', e instanceof Error ? e.message : 'Could not read that file.');
    }
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
          <Pressable
            style={[styles.calcButton, { backgroundColor: theme.backgroundElement }]}
            onPress={() => setShowCalculator((s) => !s)}>
            <ThemedText type="small">
              🧮 Calculate goals for me {showCalculator ? '▴' : '▾'}
            </ThemedText>
          </Pressable>
          {showCalculator && (
            <GoalCalculator
              onApply={(g) => {
                editor.applyGoals(g);
                setShowCalculator(false);
              }}
            />
          )}
          <View style={styles.nutrientList}>
            {NUTRIENTS.map((n) => (
              <NutrientRow
                key={n.key}
                label={n.label}
                unit={n.unit}
                color={n.color}
                enabled={editor.enabled[n.key]}
                goal={editor.goalText[n.key]}
                onToggle={() => editor.toggle(n.key)}
                onGoal={(t) => editor.setGoal(n.key, t)}
              />
            ))}
          </View>

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Day ends at
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Anything logged before this hour counts toward the previous day — so a
            half-past-midnight snack stays with that evening.
          </ThemedText>
          <View style={styles.modelChips}>
            {DAY_END_OPTIONS.map((h) => (
              <Pressable
                key={h}
                onPress={() => chooseDayEnd(h)}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      dayEnd === h ? theme.backgroundSelected : theme.backgroundElement,
                    borderColor: dayEnd === h ? MacroColors.kcal : 'transparent',
                  },
                ]}>
                <ThemedText type="small" themeColor={dayEnd === h ? 'text' : 'textSecondary'}>
                  {dayEndLabel(h)}
                </ThemedText>
              </Pressable>
            ))}
          </View>

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Evening check-in
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            An optional once-a-day reminder to log — it stays silent on days you’ve
            already logged something.
          </ThemedText>
          {checkinSupported() ? (
            <>
              <View style={styles.modelChips}>
                <Pressable
                  onPress={() => chooseCheckin(null)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor:
                        checkin == null ? theme.backgroundSelected : theme.backgroundElement,
                      borderColor: checkin == null ? MacroColors.kcal : 'transparent',
                    },
                  ]}>
                  <ThemedText type="small" themeColor={checkin == null ? 'text' : 'textSecondary'}>
                    Off
                  </ThemedText>
                </Pressable>
                {CHECKIN_HOURS.map((h) => (
                  <Pressable
                    key={h}
                    onPress={() => chooseCheckin(h)}
                    style={[
                      styles.chip,
                      {
                        backgroundColor:
                          checkin === h ? theme.backgroundSelected : theme.backgroundElement,
                        borderColor: checkin === h ? MacroColors.kcal : 'transparent',
                      },
                    ]}>
                    <ThemedText type="small" themeColor={checkin === h ? 'text' : 'textSecondary'}>
                      {checkinLabel(h)}
                    </ThemedText>
                  </Pressable>
                ))}
              </View>
              {checkinPermMissing && (
                <ThemedText type="small" style={{ color: MacroColors.carbs }}>
                  ⚠ Notifications are blocked for MacroTrack — allow them in your device
                  settings to get the check-in.
                </ThemedText>
              )}
            </>
          ) : (
            <ThemedText type="small" themeColor="textSecondary">
              Reminders need the iOS/Android app — not available on web.
            </ThemedText>
          )}

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

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Your data
          </ThemedText>
          <View style={styles.modelChips}>
            <Pressable
              style={[styles.chip, { backgroundColor: theme.backgroundElement, borderColor: 'transparent' }]}
              onPress={backupNow}>
              <ThemedText type="small">Export backup</ThemedText>
            </Pressable>
            <Pressable
              style={[styles.chip, { backgroundColor: theme.backgroundElement, borderColor: 'transparent' }]}
              onPress={restoreFromFile}>
              <ThemedText type="small">Restore from backup</ThemedText>
            </Pressable>
            <Pressable
              style={[styles.chip, { backgroundColor: theme.backgroundElement, borderColor: 'transparent' }]}
              onPress={() => exportFoodLog()}>
              <ThemedText type="small">Export food log</ThemedText>
            </Pressable>
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {lastBackup
              ? `Last backup: ${new Date(lastBackup).toLocaleDateString()}`
              : 'No backup yet — the backup file holds your logs, foods, recipes, and settings.'}
          </ThemedText>

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

          {/* Advanced — power-user export tucked under a subtle caption. */}
          <ThemedText type="small" themeColor="textSecondary" style={styles.sectionTitle}>
            Advanced
          </ThemedText>
          <View style={styles.modelChips}>
            <Pressable
              style={[styles.chip, { backgroundColor: theme.backgroundElement, borderColor: 'transparent' }]}
              onPress={async () => {
                const n = await exportTrainingData();
                if (n === 0) Alert.alert('Nothing to export', 'No AI interactions recorded yet.');
              }}>
              <ThemedText type="small">Export corrections (for model tuning)</ThemedText>
            </Pressable>
          </View>

          <Pressable
            style={styles.aboutRow}
            hitSlop={8}
            onPress={() => router.push('/about')}>
            <ThemedText type="small" themeColor="textSecondary">
              About & attributions ›
            </ThemedText>
          </Pressable>
        </ScrollView>

        {/* Sticky Save — only while goal edits are pending; other settings
            auto-save, so they don't need it. */}
        {editor.dirty && (
          <View style={[styles.saveFooter, { backgroundColor: theme.background }]}>
            <Pressable
              style={[styles.saveButton, { backgroundColor: MacroColors.kcal }]}
              onPress={save}>
              <ThemedText type="smallBold" style={styles.saveText}>
                Save goals
              </ThemedText>
            </Pressable>
          </View>
        )}
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
  // Derived from the byte-exact artifact size — never hardcode this.
  const sizeMb = Math.round(LOCAL_MODEL_TOTAL_BYTES / (1024 * 1024));

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
          <ThemedText type="small" style={{ color: theme.danger }}>
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
        <ThemedText type="small">Download on-device model ({sizeMb} MB, Wi-Fi recommended)</ThemedText>
      </Pressable>
      <ThemedText type="small" themeColor="textSecondary">
        One-time download; the model runs entirely on your phone. A typical estimate
        takes a few seconds on a modern phone.
      </ThemedText>
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
  calcButton: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    alignItems: 'center',
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
  },
  saveText: { color: '#ffffff' },
  saveFooter: {
    padding: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.3)',
  },
  aboutSection: {
    marginTop: Spacing.four,
    gap: Spacing.one,
  },
  aboutRow: {
    marginTop: Spacing.three,
    paddingVertical: Spacing.two,
    alignItems: 'center',
  },
});
