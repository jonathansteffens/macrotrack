import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GoalCalculator } from '@/components/goal-calculator';
import { NutrientRow } from '@/components/nutrient-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MacroColors, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useTrackingEditor } from '@/hooks/use-tracking-editor';
import { CORE_NUTRIENT_KEYS, NUTRIENTS } from '@/lib/nutrients';
import { markOnboardingDone } from '@/lib/onboarding';
import { setTracking } from '@/lib/tracking';

/**
 * First-launch walkthrough: what the app does, which nutrients to track (with
 * goals), and a few things worth knowing. Shown once; everything here can be
 * changed later in Settings.
 */

const STEP_COUNT = 3;

const PRIMARY_NUTRIENTS = NUTRIENTS.filter((n) => CORE_NUTRIENT_KEYS.includes(n.key));
const MORE_NUTRIENTS = NUTRIENTS.filter((n) => !CORE_NUTRIENT_KEYS.includes(n.key));

export default function OnboardingScreen() {
  const theme = useTheme();
  const [step, setStep] = useState(0);
  const editor = useTrackingEditor();

  const finish = async (saveConfig: boolean) => {
    if (saveConfig) {
      const config = editor.buildConfig();
      if (!config) {
        Alert.alert('Invalid goal', 'Goals must be numbers, or left blank for no target.');
        return;
      }
      await setTracking(config);
    }
    await markOnboardingDone();
    router.replace('/(tabs)');
  };

  return (
    <ThemedView style={styles.root}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
          {step === 0 && <WelcomeStep />}
          {step === 1 && <NutrientsStep editor={editor} />}
          {step === 2 && <TipsStep />}
        </ScrollView>

        {/* Progress dots + navigation */}
        <View style={styles.footer}>
          <View style={styles.dots}>
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  {
                    backgroundColor:
                      i === step ? MacroColors.kcal : theme.backgroundSelected,
                  },
                ]}
              />
            ))}
          </View>
          <View style={styles.navRow}>
            {step > 0 ? (
              <Pressable
                style={[styles.navButton, { backgroundColor: theme.backgroundElement }]}
                onPress={() => setStep((s) => s - 1)}>
                <ThemedText type="smallBold">Back</ThemedText>
              </Pressable>
            ) : (
              <View style={styles.navButton} />
            )}
            <Pressable
              style={[styles.navButton, styles.nextButton, { backgroundColor: MacroColors.kcal }]}
              onPress={() => (step < STEP_COUNT - 1 ? setStep((s) => s + 1) : finish(true))}>
              <ThemedText type="smallBold" style={styles.nextText}>
                {step < STEP_COUNT - 1 ? 'Next' : 'Get started'}
              </ThemedText>
            </Pressable>
          </View>
          {/* Full-width escape hatch — keeps defaults, straight into the app. */}
          <Pressable
            style={[styles.skipButton, { backgroundColor: theme.backgroundElement }]}
            onPress={() => finish(false)}>
            <ThemedText type="smallBold" themeColor="textSecondary">
              Set up later
            </ThemedText>
          </Pressable>
        </View>
      </SafeAreaView>
    </ThemedView>
  );
}

function WelcomeStep() {
  return (
    <View style={styles.step}>
      <ThemedText type="title" style={styles.centered}>
        MacroTrack
      </ThemedText>
      <ThemedText themeColor="textSecondary" style={styles.centered}>
        Simple, private macro tracking.
      </ThemedText>
      <View style={styles.features}>
        <Feature emoji="🔍" title="Log anything">
          Search thousands of foods, save your own, or build multi-ingredient recipes.
        </Feature>
        <Feature emoji="📷" title="Scan barcodes">
          Point the camera at a package and the label fills itself in.
        </Feature>
        <Feature emoji="💬" title="Describe your meal">
          “Two eggs and a slice of toast.” The AI estimates portions and logs it, all on
          your phone.
        </Feature>
        <Feature emoji="📊" title="See your trends">
          Daily totals, goals, moving averages, and weight over time.
        </Feature>
        <Feature emoji="🔒" title="Private by design">
          No account, no cloud. Your data never leaves your device.
        </Feature>
      </View>
    </View>
  );
}

function NutrientsStep({ editor }: { editor: ReturnType<typeof useTrackingEditor> }) {
  const theme = useTheme();
  const [showCalculator, setShowCalculator] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const renderRow = (n: (typeof NUTRIENTS)[number]) => (
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
  );
  return (
    <View style={styles.step}>
      <ThemedText type="subtitle">What do you want to track?</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        The core macros are on by default. Set a daily goal for each, or leave it blank to
        track the number without a target. You can change all of this later in Settings.
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
      <View style={styles.nutrientList}>{PRIMARY_NUTRIENTS.map(renderRow)}</View>
      <Pressable
        style={[styles.calcButton, { backgroundColor: theme.backgroundElement }]}
        onPress={() => setShowMore((s) => !s)}>
        <ThemedText type="small">
          More nutrients (fiber, sugar, sodium) {showMore ? '▴' : '▾'}
        </ThemedText>
      </Pressable>
      {showMore && <View style={styles.nutrientList}>{MORE_NUTRIENTS.map(renderRow)}</View>}
    </View>
  );
}

function TipsStep() {
  return (
    <View style={styles.step}>
      <ThemedText type="subtitle">Good to know</ThemedText>
      <View style={styles.features}>
        <Feature emoji="💬" title="Enable the AI assistant">
          The on-device model is a one-time download. Get it in Settings on Wi-Fi, then it
          works offline.
        </Feature>
        <Feature emoji="⭐" title="Reuse whole meals">
          Star a meal on the Today screen to save it as a template, then log it again in
          one tap.
        </Feature>
        <Feature emoji="🍲" title="Cook in batches">
          Save a recipe with its ingredients and servings. Logging “1 serving” does the
          math for you.
        </Feature>
        <Feature emoji="🎯" title="Goals are flexible">
          Track a nutrient with no target, or change goals any time in Settings.
        </Feature>
      </View>
    </View>
  );
}

function Feature({
  emoji,
  title,
  children,
}: {
  emoji: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.feature}>
      <ThemedText style={styles.featureEmoji}>{emoji}</ThemedText>
      <View style={styles.featureBody}>
        <ThemedText type="smallBold">{title}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {children}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
  },
  safeArea: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  content: {
    padding: Spacing.three,
    paddingBottom: Spacing.four,
    gap: Spacing.three,
  },
  step: {
    gap: Spacing.three,
  },
  centered: {
    textAlign: 'center',
  },
  features: {
    gap: Spacing.three,
    marginTop: Spacing.two,
  },
  feature: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  featureEmoji: {
    fontSize: 22,
    width: 30,
    textAlign: 'center',
  },
  featureBody: {
    flex: 1,
    gap: 2,
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
  footer: {
    padding: Spacing.three,
    gap: Spacing.three,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  navRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  navButton: {
    flex: 1,
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  nextButton: {
    flex: 2,
  },
  nextText: {
    color: '#ffffff',
  },
  skipButton: {
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
});
