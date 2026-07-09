/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function useTheme() {
  const scheme = useColorScheme();
  // Anything that isn't an explicit 'dark' (null/undefined/'unspecified'/'light')
  // resolves to the light palette, so indexing Colors is always safe.
  return Colors[scheme === 'dark' ? 'dark' : 'light'];
}
