import Constants from 'expo-constants';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { LOCAL_MODEL_TOTAL_BYTES } from '@/lib/ai/local-model';

/**
 * Static about + attribution screen. Credits every external tool and data
 * source the app ships or relies on — the Open Food Facts line in particular
 * is an ODbL attribution obligation, so keep it. Also the canonical home for
 * the on-device model's specifics (name + download size).
 */

const APP_NAME = (Constants.expoConfig?.name ?? 'MacroTrack').trim();
const APP_VERSION = Constants.expoConfig?.version ?? '—';
const MODEL_MB = Math.round(LOCAL_MODEL_TOTAL_BYTES / (1024 * 1024));

type Credit = { title: string; body: string };

const CREDITS: Credit[] = [
  {
    title: 'Open Food Facts',
    body: 'Barcode and packaged-food data © Open Food Facts contributors, licensed under the Open Database License (ODbL).',
  },
  {
    title: 'USDA FoodData Central',
    body: 'Generic food & nutrient database — SR Legacy, FNDDS, and Foundation Foods. Public domain.',
  },
  {
    title: 'MenuStat',
    body: 'Restaurant menu nutrition data (MenuStat Annual Data, Harvard Dataverse, doi:10.7910/DVN/K4NYTR).',
  },
  {
    title: 'On-device AI model',
    body:
      `The meal estimator is fine-tuned from Qwen3.5-0.8B (Alibaba Cloud, Apache 2.0) and runs ` +
      `on-device via llama.cpp / llama.rn (MIT). Shipped as “macrotrack-text-0.8b” — a one-time ` +
      `~${MODEL_MB} MB download.`,
  },
  {
    title: 'Expo & React Native',
    body: 'Built with Expo and React Native (MIT).',
  },
];

export default function AboutScreen() {
  return (
    <ThemedView style={styles.flex}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <ThemedText type="subtitle">{APP_NAME}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Version {APP_VERSION}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Simple, private macro tracking — your data never leaves your device.
          </ThemedText>
        </View>

        <ThemedText type="smallBold" style={styles.sectionTitle}>
          Attributions & licenses
        </ThemedText>
        {CREDITS.map((c) => (
          <View key={c.title} style={styles.credit}>
            <ThemedText type="smallBold">{c.title}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {c.body}
            </ThemedText>
          </View>
        ))}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
    paddingBottom: Spacing.six,
  },
  header: {
    gap: Spacing.one,
  },
  sectionTitle: {
    marginTop: Spacing.two,
  },
  credit: {
    gap: 2,
  },
});
