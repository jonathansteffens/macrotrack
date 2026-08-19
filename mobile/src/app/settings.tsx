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
import { hairlineColor, MacroColors, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useTrackingEditor } from '@/hooks/use-tracking-editor';
import {
  APPEARANCE_OPTIONS,
  appearanceLabel,
  getAppearance,
  setAppearance,
  type AppearancePref,
} from '@/lib/appearance';
import { setEnergyUnit, setUnitOverride, setUnitSystem } from '@/lib/unit-prefs';
import {
  UNIT_CHOICES,
  foodClassLabel,
  unitChoiceLabel,
  type EnergyUnit,
  type FoodClass,
  type UnitChoice,
  type UnitSystem,
} from '@/lib/units';
import { useUnitPrefs } from '@/hooks/use-unit-prefs';
import {
  deleteLocalModel,
  downloadLocalModel,
  getLocalModelStatus,
  LOCAL_MODEL_TOTAL_BYTES,
  type LocalModelStatus,
} from '@/lib/ai/local-model';
import { exportBackup, getLastBackupAt, parseBackup, restoreBackup } from '@/lib/backup';
import {
  checkinPermissionMissing,
  checkinSupported,
  formatCheckinTime,
  getCheckinPref,
  requestCheckinPermission,
  setCheckinPref,
  type CheckinPref,
} from '@/lib/checkin';
import { DAY_END_OPTIONS, dayEndLabel, getDayEndHour, setDayEndHour } from '@/lib/day-end';
import { isDevMode } from '@/lib/dev-mode';
import { exportBarcodeCorrections, exportFoodLog, exportTrainingData } from '@/lib/export';
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
  const [checkin, setCheckin] = useState<CheckinPref | null>(null);
  const [checkinPermMissing, setCheckinPermMissing] = useState(false);
  const [devMode, setDevModeState] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [appearance, setAppearanceState] = useState<AppearancePref>(getAppearance);
  const unitPrefs = useUnitPrefs();

  useEffect(() => {
    getFoodDbInfo().then(setDbInfo);
    getLocalModelStatus().then(setModelStatus);
    getDayEndHour().then(setDayEnd);
    getCheckinPref().then(setCheckin);
    isDevMode().then(setDevModeState);
    checkinPermissionMissing().then(setCheckinPermMissing);
    getLastBackupAt().then(setLastBackup);
  }, []);

  // Persisted immediately — no Save step needed for this one.
  const chooseDayEnd = (hour: number) => {
    setDayEnd(hour);
    setDayEndHour(hour);
  };

  // Persisted immediately; the whole app re-themes on the spot.
  const chooseAppearance = (pref: AppearancePref) => {
    setAppearanceState(pref);
    setAppearance(pref);
  };

  // Also persisted immediately. Turning it on asks for permission right away;
  // a denial keeps the time saved but shows the "permission needed" state.
  const applyCheckin = async (next: CheckinPref) => {
    setCheckin(next);
    if (next.enabled) {
      const granted = await requestCheckinPermission();
      setCheckinPermMissing(!granted);
    } else {
      setCheckinPermMissing(false);
    }
    await setCheckinPref(next);
  };

  // ±15-minute steps, wrapping around midnight. Stepping also turns the
  // check-in on — adjusting a time means you want the reminder.
  const stepCheckin = (dir: 1 | -1) => {
    if (!checkin) return;
    const mins =
      (checkin.time.hour * 60 + checkin.time.minute + dir * 15 + 24 * 60) % (24 * 60);
    applyCheckin({ enabled: true, time: { hour: Math.floor(mins / 60), minute: mins % 60 } });
  };

  const downloadModel = async () => {
    setDownloadPct(0);
    try {
      await downloadLocalModel((f) => setDownloadPct(f));
      setModelStatus(await getLocalModelStatus());
    } catch (e) {
      Alert.alert('Download failed', e instanceof Error ? e.message : 'Try again.');
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
      Alert.alert('Backup failed', e instanceof Error ? e.message : 'Try again.');
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
          'Restoring replaces everything currently in the app. This cannot be undone.',
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
      Alert.alert('Restore failed', e instanceof Error ? e.message : 'Couldn’t read that file.');
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
            Toggle what you want to track. For anything on, set a daily goal, or
            leave it blank to track the amount without a target.
          </ThemedText>
          <Pressable
            style={[styles.calcButton, { backgroundColor: theme.backgroundElement }]}
            onPress={() => setShowCalculator((s) => !s)}>
            <ThemedText type="small">
              Calculate goals for me {showCalculator ? '▴' : '▾'}
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
            Appearance
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Follow your device’s light/dark setting, or pin the app to one look.
          </ThemedText>
          <View style={styles.modelChips}>
            {APPEARANCE_OPTIONS.map((pref) => (
              <Pressable
                key={pref}
                onPress={() => chooseAppearance(pref)}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      appearance === pref ? theme.tintSurface : theme.backgroundElement,
                    borderColor: appearance === pref ? theme.tint : 'transparent',
                  },
                ]}>
                <ThemedText
                  type="small"
                  themeColor={appearance === pref ? 'tint' : 'textSecondary'}>
                  {appearanceLabel(pref)}
                </ThemedText>
              </Pressable>
            ))}
          </View>

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Units
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            How amounts are written. Drinks read as fl oz, countable foods as
            pieces (&ldquo;3 eggs&rdquo;), everything else by weight, with grams
            always shown alongside. Estimates and amounts you&rsquo;re editing
            re-read straight away; entries already in your log keep the wording
            they were saved with. Your logged amounts and macros never change.
          </ThemedText>
          <View style={styles.modelChips}>
            {(['us', 'metric'] as UnitSystem[]).map((sys) => (
              <Pressable
                key={sys}
                onPress={() => setUnitSystem(sys)}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      unitPrefs.system === sys ? theme.tintSurface : theme.backgroundElement,
                    borderColor: unitPrefs.system === sys ? theme.tint : 'transparent',
                  },
                ]}>
                <ThemedText
                  type="small"
                  themeColor={unitPrefs.system === sys ? 'tint' : 'textSecondary'}>
                  {sys === 'us' ? 'US (oz, fl oz)' : 'Metric (g, mL)'}
                </ThemedText>
              </Pressable>
            ))}
          </View>

          <ThemedText type="small" themeColor="textSecondary" style={styles.unitClassLabel}>
            Energy
          </ThemedText>
          <View style={styles.modelChips}>
            {(['Cal', 'kcal'] as EnergyUnit[]).map((en) => {
              const active = (unitPrefs.energy ?? 'Cal') === en;
              return (
                <Pressable
                  key={en}
                  onPress={() => setEnergyUnit(en)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active ? theme.tintSurface : theme.backgroundElement,
                      borderColor: active ? theme.tint : 'transparent',
                    },
                  ]}>
                  <ThemedText type="small" themeColor={active ? 'tint' : 'textSecondary'}>
                    {en === 'Cal' ? 'Calories (Cal)' : 'kcal'}
                  </ThemedText>
                </Pressable>
              );
            })}
          </View>

          {(Object.keys(UNIT_CHOICES) as FoodClass[]).map((cls) => (
            <View key={cls}>
              <ThemedText type="small" themeColor="textSecondary" style={styles.unitClassLabel}>
                {foodClassLabel(cls)}
              </ThemedText>
              <View style={styles.modelChips}>
                {UNIT_CHOICES[cls].map((choice: UnitChoice) => {
                  const active = (unitPrefs.overrides[cls] ?? 'auto') === choice;
                  return (
                    <Pressable
                      key={choice}
                      onPress={() => setUnitOverride(cls, choice)}
                      style={[
                        styles.chip,
                        {
                          backgroundColor: active ? theme.tintSurface : theme.backgroundElement,
                          borderColor: active ? theme.tint : 'transparent',
                        },
                      ]}>
                      <ThemedText type="small" themeColor={active ? 'tint' : 'textSecondary'}>
                        {unitChoiceLabel(choice)}
                      </ThemedText>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Day ends at
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Anything logged before this hour counts toward the previous day, so a
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
                      dayEnd === h ? theme.tintSurface : theme.backgroundElement,
                    borderColor: dayEnd === h ? theme.tint : 'transparent',
                  },
                ]}>
                <ThemedText type="small" themeColor={dayEnd === h ? 'tint' : 'textSecondary'}>
                  {dayEndLabel(h)}
                </ThemedText>
              </Pressable>
            ))}
          </View>

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Evening check-in
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            An optional once-a-day reminder to log. It stays silent on days you’ve
            already logged something.
          </ThemedText>
          {checkinSupported() ? (
            <>
              <View style={styles.modelChips}>
                {/* Off is a STATE toggle, never an eraser: the time chip keeps
                    showing the remembered time either way, and toggling back
                    on returns to it. Tap-only throughout — two rounds of
                    free-text entry proved unreliable on-device. */}
                <Pressable
                  onPress={() =>
                    checkin && applyCheckin({ ...checkin, enabled: !checkin.enabled })
                  }
                  style={[
                    styles.chip,
                    {
                      backgroundColor:
                        checkin?.enabled === false ? theme.tintSurface : theme.backgroundElement,
                      borderColor: checkin?.enabled === false ? theme.tint : 'transparent',
                    },
                  ]}>
                  <ThemedText
                    type="small"
                    themeColor={checkin?.enabled === false ? 'tint' : 'textSecondary'}>
                    Off
                  </ThemedText>
                </Pressable>
                <Pressable
                  hitSlop={6}
                  onPress={() => stepCheckin(-1)}
                  style={[styles.chip, { backgroundColor: theme.backgroundElement, borderColor: 'transparent' }]}>
                  <ThemedText type="small">−15m</ThemedText>
                </Pressable>
                <View
                  style={[
                    styles.chip,
                    {
                      backgroundColor: checkin?.enabled ? theme.tintSurface : theme.backgroundElement,
                      borderColor: checkin?.enabled ? theme.tint : 'transparent',
                    },
                  ]}>
                  <ThemedText type="small" themeColor={checkin?.enabled ? 'tint' : 'textSecondary'}>
                    {checkin ? formatCheckinTime(checkin.time) : '—'}
                  </ThemedText>
                </View>
                <Pressable
                  hitSlop={6}
                  onPress={() => stepCheckin(1)}
                  style={[styles.chip, { backgroundColor: theme.backgroundElement, borderColor: 'transparent' }]}>
                  <ThemedText type="small">+15m</ThemedText>
                </Pressable>
              </View>
              {checkin?.enabled && (
                <ThemedText type="small" themeColor="textSecondary">
                  Daily at {formatCheckinTime(checkin.time)} on days with nothing logged.
                </ThemedText>
              )}
              {checkinPermMissing && (
                <ThemedText type="small" style={{ color: MacroColors.carbs }}>
                  ⚠ Notifications are blocked for MacroTrack. Allow them in your device
                  settings to get the check-in.
                </ThemedText>
              )}
            </>
          ) : (
            <ThemedText type="small" themeColor="textSecondary">
              Reminders need the iOS/Android app. Not available on web.
            </ThemedText>
          )}

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            AI assistant
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Meals are estimated by a model that runs entirely on your phone. No network, no
            API cost, nothing leaves the device. Download it once to enable AI logging.
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
              : 'No backup yet. The backup file holds your logs, foods, recipes, and settings.'}
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

          {/* Developer-only: the training export is a dead end for ordinary
              users (the file goes nowhere) — unlocked by long-pressing the
              version line on the About screen. */}
          {devMode && (
            <>
              <ThemedText type="small" themeColor="textSecondary" style={styles.sectionTitle}>
                Developer
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
                <Pressable
                  style={[styles.chip, { backgroundColor: theme.backgroundElement, borderColor: 'transparent' }]}
                  onPress={async () => {
                    const n = await exportBarcodeCorrections();
                    Alert.alert(
                      n === 0 ? 'Nothing to export' : `Exported ${n} product${n === 1 ? '' : 's'}`,
                      n === 0
                        ? 'No label-corrected barcode products yet.'
                        : 'Label corrections ready to contribute back to Open Food Facts.'
                    );
                  }}>
                  <ThemedText type="small">Export barcode fixes (for Open Food Facts)</ThemedText>
                </Pressable>
              </View>
            </>
          )}

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
              style={[styles.saveButton, { backgroundColor: theme.tintSolid }]}
              onPress={save}>
              <ThemedText type="smallBold" style={{ color: theme.tintText }}>
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
        On-device AI needs an iOS/Android dev build. Not available on web.
      </ThemedText>
    );
  }

  if (downloadPct != null) {
    return (
      <View style={styles.modelRow}>
        <ActivityIndicator color={theme.tint} />
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
        One-time download. The model runs on your phone; a typical estimate takes a few
        seconds.
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
    borderRadius: Radius.control,
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
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderWidth: 1,
  },
  checkinInput: {
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 14,
    minWidth: 110,
    textAlign: 'center',
  },
  saveButton: {
    borderRadius: Radius.control,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  saveFooter: {
    padding: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: hairlineColor,
  },
  unitClassLabel: { marginTop: 10 },
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
