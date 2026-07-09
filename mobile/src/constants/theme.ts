/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
    // Danger/error/over-budget — a saturated red distinct from the softer
    // protein salmon (#E4645C) so "over" / destructive / error never reads as
    // just another macro. Used ONLY for those three meanings.
    danger: '#D93B30',
    // ── Brand accent (iris) ────────────────────────────────────────────────
    // The single interactive-accent for the whole app: primary buttons, active
    // tab, selected chips/toggles, links, focus states, the goal ring. Iris was
    // chosen to own a lane no major tracker holds (MFP=blue, MacroFactor=coral,
    // Cronometer=gold, Lose It!/Noom=orange, Lifesum/Yazio=green). It never
    // collides with the nutrient MacroColors (data-only) or danger (over-budget).
    // Revert the whole app's accent by editing these four values.
    tint: '#5B5BD6', // on-surface accent: links, borders, active states, ring (5.4:1 on white)
    tintSolid: '#5B5BD6', // solid fill for primary buttons; white text sits on it
    tintText: '#FFFFFF', // text/icon placed ON a tintSolid fill
    tintSurface: '#EEEEFB', // subtle iris-tinted container (Describe action, tab indicator)
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
    danger: '#FF6B60',
    // Lighter iris on true black keeps links/labels well above AA (≈10:1),
    // while primary buttons keep the darker solid so white text stays legible.
    tint: '#B1A9FF',
    tintSolid: '#5B5BD6',
    tintText: '#FFFFFF',
    tintSurface: '#1D1B2C',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/** Accent colors for calories and each tracked nutrient, used in bars and charts. */
export const MacroColors = {
  kcal: '#208AEF',
  protein: '#E4645C',
  carbs: '#E8A33D',
  fat: '#3FA98E',
  // Nudged pinker (#8E7CC3 → #9B79C0) so it reads as its own data swatch and
  // not a washed-out version of the iris brand accent (Δhue 15° → 29°).
  fiber: '#9B79C0',
  sugar: '#EC6F9E',
  sodium: '#4FA8C4',
  satFat: '#C58B5C',
  cholesterol: '#C56AC0',
  calcium: '#6B7FD0',
  iron: '#B15A45',
  potassium: '#4FA576',
} as const;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

/**
 * Corner-radius scale. One source of truth so cards, chips, and buttons share a
 * consistent rounding rhythm: pill for chips/quick-actions, card for containers,
 * control for buttons/inputs.
 */
export const Radius = {
  control: 12,
  card: 16,
  pill: 999,
} as const;

/** Hairline border used for refined 1px edges instead of heavy shadows. */
export const hairlineColor = 'rgba(128,128,128,0.22)';

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
