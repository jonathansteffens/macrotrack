import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

import { getAppearance, subscribeAppearance } from '@/lib/appearance';

/**
 * The app's effective color scheme: the manual Appearance override when set to
 * 'light'/'dark', otherwise the OS setting. Every themed surface reads through
 * here, so flipping the override in Settings re-themes the app immediately.
 */
export function useColorScheme() {
  const pref = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const os = useRNColorScheme();
  if (pref === 'light' || pref === 'dark') return pref;
  return os;
}
