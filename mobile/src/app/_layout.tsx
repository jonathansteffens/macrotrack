import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { AppState, StyleSheet, useColorScheme } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { releaseLocalContext } from '@/lib/ai/local-model';
import { initDb } from '@/lib/db';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initDb()
      .then(() => setReady(true))
      .catch((e) => setError(String(e)));
  }, []);

  // Unload the on-device model (~2.5 GB) when the app leaves the foreground —
  // essential on iOS, where a large resident set gets the app killed. No-op on
  // web and when no model is loaded.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') void releaseLocalContext();
    });
    return () => sub.remove();
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
        <Stack.Screen name="settings" options={{ presentation: 'modal', title: 'Goals' }} />
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
