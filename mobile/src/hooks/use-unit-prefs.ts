import { useSyncExternalStore } from 'react';

import { getUnitPrefs, subscribeUnitPrefs } from '@/lib/unit-prefs';
import type { UnitPrefs } from '@/lib/units';

/**
 * The app's display-unit preferences. Every screen that renders an amount reads
 * through here, so changing units in Settings re-labels the app immediately —
 * the same external-store shape as useColorScheme.
 */
export function useUnitPrefs(): UnitPrefs {
  return useSyncExternalStore(subscribeUnitPrefs, getUnitPrefs, getUnitPrefs);
}
