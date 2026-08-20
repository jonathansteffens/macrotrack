/**
 * One-slot hand-off from the barcode scanner to the recipe editor.
 *
 * Scanning an ingredient must RETURN to the recipe screen (which holds
 * unsaved state — navigating forward would remount and lose it), so the
 * scanner stashes the resolved food ref here, goes back, and the recipe
 * screen consumes it on focus. Module-level because it spans two screens for
 * a moment; `take` clears it so a stale ref can never resurface later.
 */

let pendingRef: string | null = null;

export function setPendingIngredient(ref: string): void {
  pendingRef = ref;
}

export function takePendingIngredient(): string | null {
  const ref = pendingRef;
  pendingRef = null;
  return ref;
}
