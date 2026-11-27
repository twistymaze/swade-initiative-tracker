// Background page: a hidden iframe that OBR keeps loaded while the room is open
// (manifest `background_url`). It owns the token context menus, so they work even
// when the action popover was never opened, and it dispatches the modals' changes
// (actionChannel.ts), so its engine can replay them after the modal closed. It has its
// own store and sync engine; only GM clients write (the engine checks the role, the
// menus are GM-only).
import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { registerContextMenus, tokenImageUrl, tokenName } from "./contextMenu";
import { startActionHandler } from "./actionChannel";
import { flushSync, getRole, startSync, store, syncEngine, writerId } from "./store/store";
import { createParticipant } from "./store/swadeSlice";
import { LocalUndoStore } from "./store/localUndoStore";
import { isSafeImageUrl } from "./store/stateCodec";
import { saveChanges } from "./utils/saveChanges";
import type { ParticipantType } from "./store/types";

let undo: LocalUndoStore | null = null;
let stopActionHandler: (() => void) | null = null;

function describe(items: Item[], type: ParticipantType): string {
  const label = type === "GROUP" ? "Extra" : type;
  return items.length === 1 ? `Add ${label} from token` : `Add ${items.length} ${label}s from tokens`;
}

/** True when this iframe has loaded the room state and may change it. */
function canAct(): boolean {
  const { loaded, status } = syncEngine.getSnapshot();
  return getRole() === "GM" && loaded && status !== "invalid" && status !== "too-new";
}

/** Add the clicked tokens as participants and write them to the room. */
export async function addTokens(items: Item[], type: ParticipantType): Promise<void> {
  try {
    await startSync();
    if (getRole() !== "GM" || items.length === 0) return;

    if (!canAct()) {
      await OBR.notification.show("Initiative tracker is not ready. Open it to see why.", "WARNING");
      return;
    }

    // Same task as the dispatches: the shared (sessionStorage, per tab) undo stack gets one checkpoint.
    undo?.captureCheckpoint(describe(items, type));
    for (const item of items) {
      // Only https images are synced (stateCodec); keep the local row equal to the room row.
      const imageUrl = tokenImageUrl(item);
      store.dispatch(createParticipant({ name: tokenName(item), type, imageUrl: isSafeImageUrl(imageUrl) ? imageUrl : undefined }));
    }
    await flushSync();
  } catch (error) {
    console.error("[SWADE] Failed to add tokens to initiative", error);
  }
}

/** Start syncing, handle modal requests and register the menus. Call after OBR.onReady. */
export function startBackground(): string[] {
  undo ??= new LocalUndoStore({
    store,
    writerId,
    roomId: OBR.room.id,
    getRoomIdentity: () => syncEngine.getRoomIdentity(),
  }).start();
  startSync().catch((error) => console.error("[sync] failed to start", error));
  stopActionHandler ??= startActionHandler({
    getConnectionId: () => OBR.player.getConnectionId(),
    whenReady: async () => {
      await startSync();
      return canAct();
    },
    dispatch: (action) => store.dispatch(action),
    undo: () => undo,
    save: () => saveChanges("a modal change"),
  });
  return registerContextMenus(OBR, addTokens);
}

if (OBR.isAvailable) {
  OBR.onReady(() => {
    startBackground();
  });
}
