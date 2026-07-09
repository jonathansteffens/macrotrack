import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { AppState, StyleSheet, useColorScheme } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { releaseLocalContext } from '@/lib/ai/local-model';
import { syncCheckinNotification } from '@/lib/checkin';
import { loadDayEndHour } from '@/lib/day-end';
import { initDb } from '@/lib/db';
import { isOnboardingDone } from '@/lib/onboarding';

SplashScreen.preventAutoHideAsync();

/**
 * Grace period before the on-device model is unloaded on backgrounding. A brief
 * app switch (checking a recipe, answering a text) shouldn't force a
 * multi-hundred-MB reload, so we wait rather than releasing immediately.
 */
const MODEL_RELEASE_DELAY_MS = 5 * 60 * 1000;

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [ready, setReady] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initDb()
      .then(() => loadDayEndHour())
      .then(() => isOnboardingDone())
      .then((done) => {
        setNeedsOnboarding(!done);
        setReady(true);
        // Fire-and-forget: reconcile the evening check-in schedule on launch.
        syncCheckinNotification().catch(() => {});
      })
      .catch((e) => setError(String(e)));
  }, []);

  // First launch: show the intro/setup walkthrough instead of the Today screen.
  useEffect(() => {
    if (ready && needsOnboarding) router.replace('/onboarding');
  }, [ready, needsOnboarding]);

  // Manage the on-device model's ~0.6 GB working set across foreground/
  // background. Chosen semantics:
  //  - Backgrounded/inactive → schedule release after MODEL_RELEASE_DELAY_MS.
  //    Returning to the foreground before then CANCELS it, so the model stays
  //    warm across quick app switches.
  //  - `memoryWarning` (iOS) → release immediately, grace period or not.
  // Background JS timers are best-effort (the OS may defer/suspend them), which
  // is acceptable: a suspended app's memory is also reclaimable by the OS, and
  // the memory-warning path is the hard backstop under real pressure. No-op on
  // web and when no model is loaded.
  useEffect(() => {
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelPending = () => {
      if (releaseTimer) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
    };
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        cancelPending();
      } else {
        cancelPending();
        releaseTimer = setTimeout(() => {
          releaseTimer = null;
          void releaseLocalContext();
        }, MODEL_RELEASE_DELAY_MS);
      }
    });
    const memSub = AppState.addEventListener('memoryWarning', () => {
      cancelPending();
      void releaseLocalContext();
    });
    return () => {
      cancelPending();
      sub.remove();
      memSub.remove();
    };
  }, []);

  useEffect(() => {
    if (ready || error) SplashScreen.hideAsync();
  }, [ready, error]);

  if (error) {
    return (
      <ThemedView style={styles.errorContainer}>
        <ThemedText type="subtitle">Database error</ThemedText>
        <ThemedText themeColor="textSecondary">{error}</ThemedText>
      </ThemedView>
    );
  }
  if (!ready) return null;

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="onboarding"
          options={{ headerShown: false, gestureEnabled: false }}
        />
        <Stack.Screen name="add" options={{ presentation: 'modal', title: 'Add food' }} />
        <Stack.Screen name="assist" options={{ presentation: 'modal', title: 'AI assistant' }} />
        <Stack.Screen name="food" options={{ presentation: 'modal', title: 'Log food' }} />
        <Stack.Screen name="entry" options={{ presentation: 'modal', title: 'Edit entry' }} />
        <Stack.Screen
          name="scan"
          options={{ presentation: 'fullScreenModal', title: 'Scan barcode', headerShown: false }}
        />
        <Stack.Screen
          name="custom-food"
          options={{ presentation: 'modal', title: 'Custom food' }}
        />
        <Stack.Screen name="recipe" options={{ presentation: 'modal', title: 'Recipe' }} />
        <Stack.Screen name="settings" options={{ presentation: 'modal', title: 'Settings' }} />
        <Stack.Screen name="about" options={{ presentation: 'modal', title: 'About' }} />
      </Stack>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.four,
  },
});
