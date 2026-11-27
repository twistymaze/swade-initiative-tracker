import { flushSync, retrySync } from "../store/store";

/**
 * Write pending changes before a modal closes (closing destroys its iframe).
 * After a failed or too-large write (e.g. "Try again"), the change is written again.
 * Resolves to false when the changes were not saved.
 */
export async function saveChanges(context: string): Promise<boolean> {
  try {
    await retrySync(); // no-op unless the last write failed
    return await flushSync();
  } catch (error) {
    console.error(`[SWADE] Failed to save ${context}`, error);
    return false;
  }
}

/** How long a modal that saved its change itself waits before it closes (fallback path). */
export const SETTLE_MS = 1500;

/**
 * Fallback when no background page took a modal's change (see actionChannel.ts): the modal
 * dispatched it in its own store, so its own engine must stay alive long enough to replay
 * it if another GM's write that misses it lands right after ours. Save, wait SETTLE_MS,
 * then save again (writes a rebase that happened meanwhile). A conflicting write that lands
 * after the modal closed can still drop the change; this is the known limit of the fallback.
 */
export async function saveAndSettle(context: string): Promise<boolean> {
  if (!(await saveChanges(context))) return false;
  console.warn(`[SWADE] No background page answered; saved ${context} from the modal`);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return saveChanges(context);
}
