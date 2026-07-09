import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

import { getAppearance, subscribeAppearance } from '@/lib/appearance';

const emptySubscribe = () => () => {};

/**
 * Web variant: same override-aware resolution as native, but returns a stable
 * 'light' during server/static render and re-computes on the client after
 * hydration (see https://docs.expo.dev/guides/color-schemes/).
 */
export function useColorScheme() {
  // false during server/static render, true after hydration
  const hasHydrated = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

  const pref = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const os = useRNColorScheme();

  if (!hasHydrated) return 'light';
  if (pref === 'light' || pref === 'dark') return pref;
  return os;
}
