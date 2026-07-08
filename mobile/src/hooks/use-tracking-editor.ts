import { useEffect, useState } from 'react';

import { parseDecimal } from '@/lib/macros';
import { NUTRIENTS, NUTRIENTS_BY_KEY, type NutrientKey } from '@/lib/nutrients';
import { getTracking, type TrackingConfig } from '@/lib/tracking';

/**
 * Editable per-nutrient tracking state (switch + goal text field), loaded from
 * the saved config. Shared by Settings and onboarding so the toggle/seed/
 * validate behavior is identical in both.
 */
export function useTrackingEditor() {
  const [enabled, setEnabled] = useState<Record<NutrientKey, boolean>>(
    () =>
      Object.fromEntries(NUTRIENTS.map((n) => [n.key, n.defaultEnabled])) as Record<
        NutrientKey,
        boolean
      >
  );
  const [goalText, setGoalText] = useState<Record<NutrientKey, string>>(
    () => Object.fromEntries(NUTRIENTS.map((n) => [n.key, ''])) as Record<NutrientKey, string>
  );

  useEffect(() => {
    getTracking().then((cfg) => {
      const en = {} as Record<NutrientKey, boolean>;
      const gt = {} as Record<NutrientKey, string>;
      for (const n of NUTRIENTS) {
        en[n.key] = cfg[n.key].enabled;
        gt[n.key] = cfg[n.key].goal != null ? String(Math.round(cfg[n.key].goal!)) : '';
      }
      setEnabled(en);
      setGoalText(gt);
    });
  }, []);

  const toggle = (key: NutrientKey) => {
    const turningOn = !enabled[key];
    setEnabled((prev) => ({ ...prev, [key]: turningOn }));
    // Seed a suggested goal the first time a nutrient is switched on.
    if (turningOn && !goalText[key]) {
      const def = NUTRIENTS_BY_KEY[key].defaultGoal;
      if (def != null) setGoalText((prev) => ({ ...prev, [key]: String(def) }));
    }
  };

  const setGoal = (key: NutrientKey, text: string) =>
    setGoalText((prev) => ({ ...prev, [key]: text }));

  /**
   * Validate and assemble the config to save. Returns null if any enabled
   * nutrient has a non-blank, non-numeric goal (blank = no target).
   */
  const buildConfig = (): TrackingConfig | null => {
    const num = (t: string): number | null => (t.trim() ? parseDecimal(t) : null);
    const invalid = (t: string) => t.trim() !== '' && parseDecimal(t) == null;
    if (NUTRIENTS.some((n) => enabled[n.key] && invalid(goalText[n.key]))) return null;
    const config = {} as TrackingConfig;
    for (const n of NUTRIENTS) {
      config[n.key] = { enabled: enabled[n.key], goal: num(goalText[n.key]) };
    }
    return config;
  };

  return { enabled, goalText, toggle, setGoal, buildConfig };
}
