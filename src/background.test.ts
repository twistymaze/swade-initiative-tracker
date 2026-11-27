import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("./test/obrMock").then((m) => m.createSdkModule()));

import OBR, { type Item } from "@owlbear-rodeo/sdk";
import * as obrMock from "./test/obrMock";
import type { EncounterState } from "./store/types";

// Importing the SDK here binds the mocked module to this test's obrMock instance; it stays
// bound across vi.resetModules (the mock registry is not reset).
void OBR;

const MENU_IDS = [
  "rodeo.owlbear.swade-initiative/context-menu-pc",
  "rodeo.owlbear.swade-initiative/context-menu-npc",
  "rodeo.owlbear.swade-initiative/context-menu-extra",
];

const token = (id: string, name: string) =>
  ({ id, name, type: "IMAGE", layer: "CHARACTER", image: { url: `https://x.test/${id}.png` } }) as unknown as Item;

type Mock = typeof obrMock;
let stopEngine: (() => void) | null = null;

/**
 * Load a fresh module graph, as in a newly loaded background iframe (own store and sync
 * engine). `setup` runs before the page starts.
 */
async function loadBackground(setup: (mock: Mock) => void = () => {}) {
  vi.resetModules();
  sessionStorage.clear();
  const mock = obrMock;
  const { STATE_KEY } = await import("./store/syncEngine");
  const { encodeEncounterState, parseEncounterState } = await import("./store/stateCodec");
  const { initializeEmptyState } = await import("./store/initialState");
  const { UNDO_STORAGE_PREFIX } = await import("./store/localUndoStore");
  mock.resetObrMock();
  mock.hub().roomMetadata = {
    [STATE_KEY]: encodeEncounterState({ ...initializeEmptyState(), revision: 1, writerId: "seed" }),
  };
  setup(mock);

  await import("./background");
  const store = await import("./store/store");
  stopEngine = () => store.syncEngine.stop();
  await mock.flushObr();
  await store.startSync();

  const room = (): EncounterState => {
    const result = parseEncounterState(mock.hub().roomMetadata[STATE_KEY]);
    if (result.kind !== "ok") throw new Error(`room holds ${result.kind}`);
    return result.state;
  };
  const undoStack = () => JSON.parse(sessionStorage.getItem(`${UNDO_STORAGE_PREFIX}${mock.hub().roomId}`) ?? "[]");
  return { obr: mock.obr(), mock, store, room, undoStack, STATE_KEY };
}

afterEach(() => {
  vi.unstubAllGlobals();
  obrMock.FakeBroadcastChannel.reset();
  stopEngine?.();
  stopEngine = null;
});

describe("background page", () => {
  it("registers exactly the three menus on start", async () => {
    const { obr } = await loadBackground();
    expect(obr.contextMenu.create).toHaveBeenCalledTimes(3);
    expect([...obr.state.contextMenus.keys()]).toEqual(MENU_IDS);
  });

  it("a GM click with two tokens adds two rows in one room write and one undo checkpoint", async () => {
    const { obr, room, undoStack } = await loadBackground();
    const writesBefore = obr.room.setMetadata.mock.calls.length;

    await obr.clickContextMenu(MENU_IDS[1], [token("a", "Orc"), token("b", "Goblin")]);
    await vi.waitFor(() => expect(room().rows).toHaveLength(2));

    expect(obr.room.setMetadata.mock.calls.length - writesBefore).toBe(1);
    expect(room().rows.map((r) => [r.name, r.type, r.imageUrl])).toEqual(expect.arrayContaining([
      ["Orc", "NPC", "https://x.test/a.png"],
      ["Goblin", "NPC", "https://x.test/b.png"],
    ]));

    // The shared (sessionStorage, per tab) undo stack gets one checkpoint for the popover to use.
    const stack = undoStack();
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({ description: "Add 2 NPCs from tokens", after: { revision: room().revision } });
    expect(stack[0].before.rows).toHaveLength(0);
  });

  it("drops a token image that is not https (the room would drop it too)", async () => {
    const { obr, mock, store, room } = await loadBackground();
    const httpToken = { ...token("a", "Orc"), image: { url: "http://x.test/a.png" } } as unknown as Item;

    await obr.clickContextMenu(MENU_IDS[1], [httpToken]);
    await vi.waitFor(() => expect(room().rows).toHaveLength(1));
    await mock.flushObr();

    expect(store.store.getState().swade.rows[0].imageUrl).toBeUndefined();
    expect(store.store.getState().swade.rows[0].name).toBe("Orc");
  });

  it("a click on a player client writes nothing", async () => {
    const { obr, mock, store } = await loadBackground((m) => m.obr().setRole("PLAYER"));

    await obr.clickContextMenu(MENU_IDS[0], [token("a", "Hero")]);
    await mock.flushObr();

    expect(obr.room.setMetadata).not.toHaveBeenCalled();
    expect(store.store.getState().swade.rows).toHaveLength(0);
  });

  it("does not add rows while the room holds invalid data", async () => {
    const { obr, mock, store } = await loadBackground((m) => {
      m.hub().roomMetadata = { "rodeo.owlbear.swade-initiative/state": { garbage: true } };
    });

    await obr.clickContextMenu(MENU_IDS[0], [token("a", "Hero")]);
    await mock.flushObr();

    expect(obr.room.setMetadata).not.toHaveBeenCalled();
    expect(store.store.getState().swade.rows).toHaveLength(0);
    expect(obr.state.notifications).toHaveLength(1);
  });

  it("dispatches and saves an Add Combatant request from a modal of this connection", async () => {
    vi.stubGlobal("BroadcastChannel", obrMock.FakeBroadcastChannel);
    const { room, undoStack } = await loadBackground();
    const { sendToBackground } = await import("./actionChannel");
    const { createParticipant } = await import("./store/swadeSlice");

    const outcome = await sendToBackground({
      op: "dispatch",
      description: "Add Combatant: Goblin",
      actions: [createParticipant({ name: "Goblin", type: "NPC" })],
    });

    expect(outcome).toBe("saved");
    expect(room().rows.map((r) => r.name)).toEqual(["Goblin"]);
    expect(undoStack()).toMatchObject([{ description: "Add Combatant: Goblin" }]);
  });

  it("rejects a modal request while the room holds invalid data (the modal falls back)", async () => {
    vi.stubGlobal("BroadcastChannel", obrMock.FakeBroadcastChannel);
    const { obr } = await loadBackground((m) => {
      m.hub().roomMetadata = { "rodeo.owlbear.swade-initiative/state": { garbage: true } };
    });
    const { sendToBackground } = await import("./actionChannel");
    expect(await sendToBackground({ op: "dispatch", description: "", actions: [] })).toBe("unavailable");
    expect(obr.room.setMetadata).not.toHaveBeenCalled();
  });
});
