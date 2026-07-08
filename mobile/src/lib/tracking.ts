import { getUserDb } from './db';
import { NUTRIENTS, type NutrientKey } from './nutrients';

/**
 * Per-nutrient tracking state, stored as JSON under the 'tracking' setting key.
 * `enabled` controls whether the nutrient shows on Today / Trends; `goal` is its
 * optional target (null = track the amount without a target).
 */
export type NutrientConfig = { enabled: boolean; goal: number | null };
export type TrackingConfig = Record<NutrientKey, NutrientConfig>;

export function defaultTracking(): TrackingConfig {
  const out = {} as TrackingConfig;
  for (const n of NUTRIENTS) out[n.key] = { enabled: n.defaultEnabled, goal: n.defaultGoal };
  return out;
}

export async function getTracking(): Promise<TrackingConfig> {
  const db = getUserDb();
  const base = defaultTracking();

  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'tracking'"
  );
  if (row) {
    try {
      const stored = JSON.parse(row.value) as Partial<
        Record<NutrientKey, Partial<NutrientConfig>>
      >;
      for (const n of NUTRIENTS) {
        const s = stored[n.key];
        if (!s) continue;
        base[n.key] = {
          enabled: typeof s.enabled === 'boolean' ? s.enabled : base[n.key].enabled,
          // 'goal' present-but-null means "enabled, no target" — keep the null.
          goal: 'goal' in s ? (s.goal ?? null) : base[n.key].goal,
        };
      }
    } catch {
      /* fall through to defaults */
    }
    return base;
  }

  // First run after the upgrade: migrate the legacy per-macro goals
  // (kcal/protein/carbs/fat/fiber). Every key that existed becomes an enabled
  // nutrient carrying its old goal (which may itself be null = no target).
  const legacy = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'goals'"
  );
  if (legacy) {
    try {
      const g = JSON.parse(legacy.value) as Partial<Record<NutrientKey, number | null>>;
      for (const n of NUTRIENTS) {
        if (n.key in g) base[n.key] = { enabled: true, goal: g[n.key] ?? null };
      }
    } catch {
      /* ignore malformed legacy goals */
    }
  }
  return base;
}

export async function setTracking(config: TrackingConfig): Promise<void> {
  await getUserDb().runAsync(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('tracking', ?)",
    JSON.stringify(config)
  );
}
