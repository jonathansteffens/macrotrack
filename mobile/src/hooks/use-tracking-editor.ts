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
  // Snapshot of the last-persisted state, so callers can tell whether there are
  // unsaved edits (drives the sticky "Save goals" footer in Settings).
  const [baseline, setBaseline] = useState<{
    enabled: Record<NutrientKey, boolean>;
    goalText: Record<NutrientKey, string>;
  } | null>(null);

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
      setBaseline({ enabled: en, goalText: gt });
    });
  }, []);

  const dirty =
    baseline != null &&
    NUTRIENTS.some(
      (n) =>
        enabled[n.key] !== baseline.enabled[n.key] || goalText[n.key] !== baseline.goalText[n.key]
    );

  /** Reset the "unsaved edits" baseline to the current state (call after save). */
  const markSaved = () => setBaseline({ enabled: { ...enabled }, goalText: { ...goalText } });

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
   * Prefill calculated goals (see GoalCalculator): enables each nutrient and
   * overwrites its goal text. Still just editor state — Save persists it.
   */
  const applyGoals = (goals: Partial<Record<NutrientKey, number>>) => {
    const entries = Object.entries(goals) as [NutrientKey, number][];
    setEnabled((prev) => {
      const next = { ...prev };
      for (const [k] of entries) next[k] = true;
      return next;
    });
    setGoalText((prev) => {
      const next = { ...prev };
      for (const [k, v] of entries) next[k] = String(Math.round(v));
      return next;
    });
  };

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

  return { enabled, goalText, toggle, setGoal, applyGoals, buildConfig, dirty, markSaved };
}
