/**
 * Which on-device model files are stale, given the release tag in use.
 *
 * Pure and import-free so it can be tested directly (tools/test-model-storage.mjs);
 * local-model.ts pulls in expo-file-system and cannot run outside the app.
 *
 * WHY THIS EXISTS. Model files used to live at documents/models/<filename> with
 * no tag in the path, and a file counted as installed when the name existed at
 * the expected byte size. That is a corruption guard, not a version check — and
 * the v8 (text-v2) and v10 (text-v3) GGUFs share BOTH the filename and the exact
 * size (529,296,704 bytes; only the sha differs). So on a phone that already had
 * v8, bumping the tag left Settings reporting "installed", no download ever ran,
 * the app kept executing v8 weights, and every ai_events row was stamped with
 * the new tag — silently corrupting the provenance of the training export.
 *
 * Files are now stored per tag, which makes a tag bump read as 'missing' and
 * trigger a real download. This module decides what to sweep up afterwards.
 */

/** One entry directly inside the models root. */
export type StorageEntry = { name: string; isDirectory: boolean };

/**
 * Names under documents/models/ that should be deleted once `currentTag` is
 * fully downloaded — other tags' directories, plus any bare file left by the
 * pre-fix untagged layout.
 *
 * The current tag's own directory is never returned. Deleting it would remove
 * the model that was just downloaded, so this function is the one place that
 * rule has to be right.
 */
export function stalePruneTargets(entries: StorageEntry[], currentTag: string): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.isDirectory) {
      // Another release's directory — the reclaimable ~529 MB.
      if (e.name !== currentTag) out.push(e.name);
    } else {
      // A file sitting directly in the models root can only be from the legacy
      // untagged layout: current-tag files live one level down, inside the tag
      // directory. It must go, both to reclaim space and so it can never again
      // be mistaken for an install of whatever tag is current.
      out.push(e.name);
    }
  }
  return out;
}
