import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));

import { flushObr, hub, resetObrMock, type ObrClient } from "../test/obrMock";
import { createAppStore, createWriterId, type AppStore } from "./store";
import { createSyncEngine, STATE_KEY, type SyncEngine, type SyncObr } from "./syncEngine";
import { encodeEncounterState, parseEncounterState } from "./stateCodec";
import { initializeEmptyState } from "./initialState";
import { renameParticipant, setEncounterState, setHold, setPrivacy } from "./swadeSlice";
import { LocalUndoStore, TabLease, UNDO_LEASE_KEY, UNDO_STORAGE_PREFIX, UNDO_TAB_ID_KEY, type UndoChannel, type UndoCheckpoint } from "./localUndoStore";
import type { EncounterState } from "./types";

const ROOM = "room-1";
const KEY = `${UNDO_STORAGE_PREFIX}${ROOM}`;

/** One browser tab's sessionStorage (shared by the extension iframes of that tab). */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

/** Same-origin BroadcastChannel stand-in: delivers to the other channels of that name, async. */
function channelBus() {
  const channels = new Map<string, Set<UndoChannel>>();
  return (name: string): UndoChannel => {
    const peers = channels.get(name) ?? new Set<UndoChannel>();
    channels.set(name, peers);
    const channel: UndoChannel = {
      onmessage: null,
      postMessage: (data) => {
        for (const peer of peers) {
          if (peer !== channel) queueMicrotask(() => peer.onmessage?.(new MessageEvent("message", { data })));
        }
      },
      close: () => void peers.delete(channel),
    };
    peers.add(channel);
    return channel;
  };
}

let bus = channelBus();

function seedState(revision: number): EncounterState {
  const state = initializeEmptyState();
  state.rows = [
    { id: "r1", name: "Hero", type: "PC", inactive: false, onHold: false, revealed: true, candidateIds: [] },
    { id: "r2", name: "Orc", type: "NPC", inactive: false, onHold: false, revealed: false, candidateIds: [] },
  ];
  return { ...state, revision, writerId: "seed" };
}

interface Iframe {
  store: AppStore;
  engine: SyncEngine;
  undo: LocalUndoStore;
  writerId: string;
  state: () => EncounterState;
}

const engines: SyncEngine[] = [];
const undos: LocalUndoStore[] = [];

/** One extension iframe (popover, modal or background) of the tab that owns `storage`. */
async function iframe(obr: ObrClient, storage: Storage, eventDelayMs = 0): Promise<Iframe> {
  const writerId = createWriterId();
  const store = createAppStore({ writerId, getMinRevision: () => engine.getMaxSeenRevision() });
  // eventDelayMs: this iframe gets room events that much later than the others.
  const syncObr: SyncObr = eventDelayMs
    ? {
        ...(obr as unknown as SyncObr),
        room: {
          getMetadata: () => obr.room.getMetadata(),
          setMetadata: (patch) => obr.room.setMetadata(patch),
          onMetadataChange: (cb) => obr.room.onMetadataChange((m) => void setTimeout(() => cb(m), eventDelayMs)),
        },
      }
    : (obr as unknown as SyncObr);
  const engine = createSyncEngine({
    store,
    obr: syncObr,
    writerId,
    isGm: () => obr.state.player.role === "GM",
  });
  engines.push(engine);
  await engine.start();
  await settle();
  const undo = new LocalUndoStore({
    store,
    writerId,
    roomId: ROOM,
    storage,
    eventTarget: null,
    channel: bus,
    legacyStorage: null,
    getRoomIdentity: () => engine.getRoomIdentity(),
  }).start();
  undos.push(undo);
  return { store, engine, undo, writerId, state: () => store.getState().swade };
}

const settle = (ms = 10_000) => vi.advanceTimersByTimeAsync(ms);

const room = (): EncounterState => {
  const result = parseEncounterState(hub().roomMetadata[STATE_KEY]);
  if (result.kind !== "ok") throw new Error(`room holds ${result.kind}`);
  return result.state;
};

function seedRoom(state: EncounterState) {
  hub().roomMetadata = { ...hub().roomMetadata, [STATE_KEY]: encodeEncounterState(state) };
}

/** Capture + dispatch in one task, like an event handler. */
function act(f: Iframe, description: string, action: Parameters<AppStore["dispatch"]>[0]) {
  f.undo.captureCheckpoint(description);
  f.store.dispatch(action);
}

const stored = (storage: Storage): UndoCheckpoint[] => JSON.parse(storage.getItem(KEY) ?? "[]");

beforeEach(() => {
  bus = channelBus();
  vi.useFakeTimers();
  resetObrMock();
  seedRoom(seedState(10));
});

afterEach(() => {
  for (const undo of undos.splice(0)) undo.destroy();
  for (const engine of engines.splice(0)) engine.stop();
  vi.useRealTimers();
});

describe("LocalUndoStore", () => {
  it("records a checkpoint whose after is the identity the action produced", async () => {
    const a = await iframe(hub().activeClient, memoryStorage());
    act(a, "Hold: Hero", setHold({ id: "r1", value: true }));

    expect(a.undo.canUndo()).toBe(true);
    expect(a.undo.getUndoDescription()).toBe("Hold: Hero");
    expect(a.state()).toMatchObject({ revision: 11, writerId: a.writerId });
  });

  it("A acts, then B acts: A's Undo turns off; A's next action starts a new history", async () => {
    const storageA = memoryStorage();
    const a = await iframe(hub().activeClient, storageA);
    const b = await iframe(hub().createClient({ role: "GM" }), memoryStorage());

    act(a, "Hold: Hero", setHold({ id: "r1", value: true }));
    await settle();
    expect(a.undo.canUndo()).toBe(true);

    act(b, "Rename", renameParticipant({ id: "r2", name: "Big Orc" }));
    await settle();

    expect(a.state().rows[1].name).toBe("Big Orc");
    expect(a.undo.canUndo()).toBe(false);
    expect(a.undo.performUndo()).toBe(false);
    expect(room().rows[1].name).toBe("Big Orc");

    act(a, "Rename again", renameParticipant({ id: "r2", name: "Orc" }));
    expect(stored(storageA).map((c) => c.description)).toEqual(["Rename again"]);
  });

  it("undo writes the old content to the room with a higher revision", async () => {
    const a = await iframe(hub().activeClient, memoryStorage());
    const b = await iframe(hub().createClient({ role: "PLAYER" }), memoryStorage());

    act(a, "Hold: Hero", setHold({ id: "r1", value: true }));
    await settle();
    expect(room().revision).toBe(11);

    expect(a.undo.performUndo()).toBe(true);
    await settle();

    expect(room()).toMatchObject({ revision: 12, writerId: a.writerId });
    expect(room().rows[0].onHold).toBe(false);
    expect(b.state().rows[0].onHold).toBe(false);
    expect(a.undo.canUndo()).toBe(false);
  });

  it("supports a two-step undo chain", async () => {
    const a = await iframe(hub().activeClient, memoryStorage());

    act(a, "Hold: Hero", setHold({ id: "r1", value: true }));
    act(a, "Rename: Orc", renameParticipant({ id: "r2", name: "Big Orc" }));
    expect(a.undo.getUndoDescription()).toBe("Rename: Orc");

    expect(a.undo.performUndo()).toBe(true);
    expect(a.state().rows[1].name).toBe("Orc");
    expect(a.state().rows[0].onHold).toBe(true);
    expect(a.undo.getUndoDescription()).toBe("Hold: Hero");

    expect(a.undo.performUndo()).toBe(true);
    expect(a.state().rows[0].onHold).toBe(false);
    expect(a.state().revision).toBe(14);
    expect(a.undo.canUndo()).toBe(false);
    await settle();
    expect(room()).toMatchObject({ revision: 14, writerId: a.writerId });
  });

  it("drops a capture that is not followed by a local change in the same task", async () => {
    const a = await iframe(hub().activeClient, memoryStorage());
    a.undo.captureCheckpoint("Add Combatant"); // e.g. opens a modal that is cancelled
    await Promise.resolve();
    a.store.dispatch(setPrivacy(false)); // later, uncaptured change

    expect(a.undo.canUndo()).toBe(false);
  });

  it("covers several local changes made in the same task with one checkpoint", async () => {
    const a = await iframe(hub().activeClient, memoryStorage());
    a.undo.captureCheckpoint("Add 2 tokens");
    a.store.dispatch(setHold({ id: "r1", value: true }));
    a.store.dispatch(setHold({ id: "r2", value: true }));

    expect(a.undo.getUndoDescription()).toBe("Add 2 tokens");
    a.undo.performUndo();
    expect(a.state().rows.map((r) => r.onHold)).toEqual([false, false]);
  });

  it("turns Undo off after an uncaptured local change", async () => {
    const a = await iframe(hub().activeClient, memoryStorage());
    act(a, "Hold: Hero", setHold({ id: "r1", value: true }));
    await Promise.resolve();
    a.store.dispatch(setPrivacy(false));
    expect(a.undo.canUndo()).toBe(false);
  });

  it("starts a new history when the stack does not lead to the current state", async () => {
    const storage = memoryStorage();
    const a = await iframe(hub().activeClient, storage);
    act(a, "Hold: Hero", setHold({ id: "r1", value: true }));
    await Promise.resolve();
    a.store.dispatch(setPrivacy(false)); // uncaptured
    act(a, "Rename", renameParticipant({ id: "r2", name: "X" }));

    expect(stored(storage).map((c) => c.description)).toEqual(["Rename"]);
  });

  it("on reload keeps a stack whose top matches the room state", async () => {
    const storage = memoryStorage();
    const a = await iframe(hub().activeClient, storage);
    act(a, "Hold: Hero", setHold({ id: "r1", value: true }));
    await settle();

    const reloaded = await iframe(hub().createClient({ role: "GM" }), storage);
    expect(reloaded.undo.canUndo()).toBe(true);
    expect(reloaded.undo.getUndoDescription()).toBe("Hold: Hero");
  });

  it("on reload, Undo is off when the stack does not match the room state", async () => {
    const storage = memoryStorage();
    const a = await iframe(hub().activeClient, storage);
    act(a, "Hold: Hero", setHold({ id: "r1", value: true }));
    await settle();
    seedRoom({ ...seedState(40), writerId: "someone-else" });

    const reloaded = await iframe(hub().createClient({ role: "GM" }), storage);
    expect(reloaded.undo.canUndo()).toBe(false);
    expect(reloaded.undo.performUndo()).toBe(false);
  });

  it("shows a checkpoint made in another iframe after its state arrives", async () => {
    const storage = memoryStorage(); // one browser: popover + background
    const popover = await iframe(hub().activeClient, storage);
    const background = await iframe(hub().activeClient, storage);
    const onChange = vi.fn();
    popover.undo.subscribe(onChange);

    act(background, "Add PC from token", setHold({ id: "r1", value: true }));
    await background.engine.flush();
    await settle();

    expect(popover.state().writerId).toBe(background.writerId);
    expect(popover.undo.canUndo()).toBe(true);
    expect(popover.undo.getUndoDescription()).toBe("Add PC from token");
    expect(onChange).toHaveBeenCalled();

    expect(popover.undo.performUndo()).toBe(true);
    await settle();
    expect(room().rows[0].onHold).toBe(false);
  });

  it("reloads the stack on a storage event", async () => {
    const storage = memoryStorage();
    const target = new EventTarget();
    const a = await iframe(hub().activeClient, storage);
    const b = new LocalUndoStore({
      store: a.store,
      writerId: a.writerId,
      roomId: ROOM,
      storage,
      eventTarget: target as unknown as Window,
    }).start();
    undos.push(b);
    expect(b.canUndo()).toBe(false);

    // Another instance writes the history (b does not see the store change as its own capture).
    act(a, "Hold: Hero", setHold({ id: "r1", value: true }));
    target.dispatchEvent(Object.assign(new Event("storage"), { key: KEY }));

    expect(b.canUndo()).toBe(true);
    expect(b.getUndoDescription()).toBe("Hold: Hero");
  });

  it("clearCheckpoints empties the stack", async () => {
    const storage = memoryStorage();
    const a = await iframe(hub().activeClient, storage);
    act(a, "Hold: Hero", setHold({ id: "r1", value: true }));
    a.undo.clearCheckpoints();
    expect(a.undo.canUndo()).toBe(false);
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("keeps at most maxCheckpoints", () => {
    const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
    store.dispatch(setEncounterState(seedState(1)));
    const undo = new LocalUndoStore({ store, writerId: "me", roomId: ROOM, storage: memoryStorage(), eventTarget: null, maxCheckpoints: 3 }).start();
    undos.push(undo);
    for (let i = 0; i < 5; i++) {
      undo.captureCheckpoint(`Rename ${i}`);
      store.dispatch(renameParticipant({ id: "r1", name: `N${i}` }));
    }
    let count = 0;
    while (undo.performUndo()) count++;
    expect(count).toBe(3);
    expect(store.getState().swade.rows[0].name).toBe("N1");
  });

  it("ignores corrupt stored data and removes old histories of other rooms", () => {
    const storage = memoryStorage();
    storage.setItem(KEY, "{not json");
    storage.setItem(`${UNDO_STORAGE_PREFIX}stale`, JSON.stringify([{ before: seedState(1), description: "x", after: { revision: 1, writerId: "w" }, timestamp: 0 }]));
    storage.setItem("other-extension", "keep");
    const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
    const undo = new LocalUndoStore({ store, writerId: "me", roomId: ROOM, storage, eventTarget: null, legacyStorage: null }).start();
    undos.push(undo);

    expect(undo.canUndo()).toBe(false);
    expect(storage.getItem(`${UNDO_STORAGE_PREFIX}stale`)).toBeNull();
    expect(storage.getItem("other-extension")).toBe("keep");
  });

  it("removes the old browser-wide (localStorage) histories without importing them", () => {
    const legacy = memoryStorage();
    const checkpoint: UndoCheckpoint = { before: seedState(1), description: "Other tab", after: { revision: 2, writerId: "seed" }, timestamp: Date.now() };
    legacy.setItem(KEY, JSON.stringify([checkpoint]));
    legacy.setItem("swade-undo-old-room", "[]");
    legacy.setItem("other-extension", "keep");
    const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
    store.dispatch(setEncounterState({ ...seedState(2), writerId: "seed" }));
    const session = memoryStorage();
    const undo = new LocalUndoStore({ store, writerId: "me", roomId: ROOM, storage: session, legacyStorage: legacy, eventTarget: null }).start();
    undos.push(undo);

    expect(undo.canUndo()).toBe(false);
    expect(session.getItem(KEY)).toBeNull();
    expect(legacy.getItem(KEY)).toBeNull();
    expect(legacy.getItem("swade-undo-old-room")).toBeNull();
    expect(legacy.getItem("other-extension")).toBe("keep");
  });

  it("falls back to memory when sessionStorage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
      store.dispatch(setEncounterState(seedState(1)));
      const undo = new LocalUndoStore({ store, writerId: "me", roomId: ROOM, eventTarget: null }).start();
      undos.push(undo);
      undo.captureCheckpoint("Hold");
      store.dispatch(setHold({ id: "r1", value: true }));
      expect(undo.canUndo()).toBe(true);
      expect(undo.performUndo()).toBe(true);
      expect(store.getState().swade.rows[0].onHold).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("LocalUndoStore per-tab history", () => {
  it("two tabs of one browser do not see each other's checkpoints", async () => {
    const tabA = memoryStorage();
    const tabB = memoryStorage();
    const a = await iframe(hub().activeClient, tabA);
    const b = await iframe(hub().activeClient, tabB);

    act(b, "Hold: Hero", setHold({ id: "r1", value: true }));
    await b.engine.flush();
    await settle();

    expect(a.state().writerId).toBe(b.writerId); // A adopted B's change
    expect(b.undo.canUndo()).toBe(true);
    expect(a.undo.canUndo()).toBe(false);
    expect(a.undo.performUndo()).toBe(false);
    expect(stored(tabA)).toEqual([]);
    expect(room().rows[0].onHold).toBe(true);
  });

  it("iframes of one tab share the history and notify each other", async () => {
    const tab = memoryStorage();
    const popover = await iframe(hub().activeClient, tab);
    // A sibling on the same store and writer: the store change does not make it re-read
    // the stack, so only the channel message can.
    const modal = new LocalUndoStore({ store: popover.store, writerId: popover.writerId, roomId: ROOM, storage: tab, eventTarget: null, legacyStorage: null, channel: bus }).start();
    undos.push(modal);
    const onChange = vi.fn();
    modal.subscribe(onChange);

    act(popover, "Hold: Hero", setHold({ id: "r1", value: true }));
    expect(modal.canUndo()).toBe(false);
    await Promise.resolve();

    expect(modal.canUndo()).toBe(true);
    expect(modal.getUndoDescription()).toBe("Hold: Hero");
    expect(onChange).toHaveBeenCalled();
  });

  it("a checkpoint of another tab does not reach this tab's channel", async () => {
    const a = await iframe(hub().activeClient, memoryStorage());
    const b = await iframe(hub().activeClient, memoryStorage());
    const onChange = vi.fn();
    a.undo.subscribe(onChange);
    act(b, "Hold: Hero", setHold({ id: "r1", value: true }));
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a reload of the tab (new instance, same session storage) restores the history", async () => {
    const tab = memoryStorage();
    const a = await iframe(hub().activeClient, tab);
    act(a, "Hold: Hero", setHold({ id: "r1", value: true }));
    await settle();
    a.undo.destroy();

    const reloaded = await iframe(hub().activeClient, tab);
    expect(reloaded.undo.getUndoDescription()).toBe("Hold: Hero");
    expect(reloaded.undo.performUndo()).toBe(true);
    await settle();
    expect(room().rows[0].onHold).toBe(false);
  });

  it("keeps one tab id per session storage and closes the channel on destroy", () => {
    const tab = memoryStorage();
    const names: string[] = [];
    const closed = vi.fn();
    const channel = (name: string): UndoChannel => {
      names.push(name);
      return { onmessage: null, postMessage: () => {}, close: closed };
    };
    const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
    const first = new LocalUndoStore({ store, writerId: "me", roomId: ROOM, storage: tab, eventTarget: null, legacyStorage: null, channel }).start();
    const second = new LocalUndoStore({ store, writerId: "me", roomId: ROOM, storage: tab, eventTarget: null, legacyStorage: null, channel }).start();
    const otherTab = new LocalUndoStore({ store, writerId: "me", roomId: ROOM, storage: memoryStorage(), eventTarget: null, legacyStorage: null, channel }).start();
    expect(names[0]).toBe(names[1]);
    expect(names[2]).not.toBe(names[0]);
    for (const undo of [first, second, otherTab]) undo.destroy();
    expect(closed).toHaveBeenCalledTimes(3);
  });

  it("works without a channel and survives a failing one", () => {
    const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
    store.dispatch(setEncounterState(seedState(1)));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failing = new LocalUndoStore({
        store, writerId: "me", roomId: ROOM, storage: memoryStorage(), eventTarget: null, legacyStorage: null,
        channel: () => ({ onmessage: null, postMessage: () => { throw new Error("closed"); }, close: () => {} }),
      }).start();
      undos.push(failing);
      failing.captureCheckpoint("Hold");
      store.dispatch(setHold({ id: "r1", value: true }));
      expect(failing.canUndo()).toBe(true);

      const throwing = new LocalUndoStore({
        store, writerId: "me", roomId: ROOM, storage: memoryStorage(), eventTarget: null, legacyStorage: null,
        channel: () => { throw new Error("no channel"); },
      }).start();
      undos.push(throwing);
      const none = new LocalUndoStore({ store, writerId: "me", roomId: ROOM, storage: memoryStorage(), eventTarget: null, legacyStorage: null, channel: null }).start();
      undos.push(none);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("LocalUndoStore review fixes", () => {
  it("a late event in another iframe of the same browser does not clear the shared history", async () => {
    const storage = memoryStorage(); // one browser: popover + background
    const popover = await iframe(hub().activeClient, storage);
    const background = await iframe(hub().createClient({ role: "GM" }), storage, 100);

    act(popover, "Hold: Hero", setHold({ id: "r1", value: true }));
    await settle(60); // written; the background sees it 100 ms later
    act(popover, "Rename: Orc", renameParticipant({ id: "r2", name: "Big Orc" }));
    await settle();

    expect(background.state()).toEqual(popover.state());
    expect(stored(storage)).toHaveLength(2);
    expect(popover.undo.performUndo()).toBe(true);
    expect(popover.undo.performUndo()).toBe(true);
    await settle();
    expect(room().rows.map((r) => [r.name, r.onHold])).toEqual([["Hero", false], ["Orc", false]]);
  });

  it("re-stamping a pending change above a foreign revision keeps Undo", async () => {
    const a = await iframe(hub().activeClient, memoryStorage());
    act(a, "Hold: Hero", setHold({ id: "r1", value: true })); // debounced, rev 11
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...seedState(15), writerId: "other" }) });
    await settle();

    expect(room()).toMatchObject({ revision: 16, writerId: a.writerId });
    expect(a.undo.canUndo()).toBe(true);
    expect(a.undo.performUndo()).toBe(true);
    await settle();
    expect(room().rows[0].onHold).toBe(false);
  });

  it("refuses to undo while a newer foreign state was seen but not adopted", async () => {
    const a = await iframe(hub().activeClient, memoryStorage());
    act(a, "Hold: Hero", setHold({ id: "r1", value: true })); // pending write, rev 11
    hub().writeRoomMetadata({
      [STATE_KEY]: encodeEncounterState({ ...seedState(15), writerId: "other", rows: [seedState(15).rows[0]] }),
    });
    await flushObr();

    expect(a.state().revision).toBe(11); // recorded, not adopted
    expect(a.undo.performUndo()).toBe(false);
    expect(a.state().rows[0].onHold).toBe(true);
  });

  it("trims the history when localStorage is full", async () => {
    const storage = memoryStorage();
    const setItem = storage.setItem.bind(storage);
    const limit = 3; // only this many checkpoints fit
    storage.setItem = (key, value) => {
      if (key === KEY && (JSON.parse(value) as unknown[]).length > limit) {
        throw new DOMException("full", "QuotaExceededError");
      }
      setItem(key, value);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await iframe(hub().activeClient, storage);
    for (let i = 0; i < 6; i++) act(a, `Rename ${i}`, renameParticipant({ id: "r1", name: `N${i}` }));

    expect(stored(storage).map((c) => c.description)).toEqual(["Rename 4", "Rename 5"]);
    expect(a.undo.performUndo()).toBe(true);
    expect(a.state().rows[0].name).toBe("N4");

    // Nothing fits at all: the history is not saved and a warning is logged.
    storage.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    act(a, "Rename again", renameParticipant({ id: "r1", name: "X" }));
    expect(warn).toHaveBeenCalledWith("[Undo] Storage full; undo history not saved");
    warn.mockRestore();
  });
});

describe("LocalUndoStore round 2 fixes", () => {
  it("discardOwnTopCheckpoint drops an unsaved modal checkpoint and keeps the shared history (R2-L1)", async () => {
    const storage = memoryStorage(); // one browser: popover + modal
    const popover = await iframe(hub().activeClient, storage);
    const modal = await iframe(hub().createClient({ role: "GM" }), storage);

    act(popover, "Hold: Hero", setHold({ id: "r1", value: true }));
    await settle();
    expect(modal.state()).toEqual(popover.state());

    modal.engine.stop(); // the modal's write never lands
    act(modal, "Add Combatant: Goblin", renameParticipant({ id: "r2", name: "Goblin" }));
    expect(stored(storage).map((c) => c.description)).toEqual(["Hold: Hero", "Add Combatant: Goblin"]);

    expect(modal.undo.discardOwnTopCheckpoint()).toBe(true);
    expect(stored(storage).map((c) => c.description)).toEqual(["Hold: Hero"]);
    expect(modal.undo.discardOwnTopCheckpoint()).toBe(false); // the new top did not lead here

    expect(popover.undo.performUndo()).toBe(true);
    await settle();
    expect(room().rows[0].onHold).toBe(false);
  });

  it("discardOwnTopCheckpoint leaves a checkpoint made by another iframe alone", async () => {
    const storage = memoryStorage();
    const popover = await iframe(hub().activeClient, storage);
    const other = await iframe(hub().createClient({ role: "GM" }), storage);
    act(popover, "Hold: Hero", setHold({ id: "r1", value: true }));
    await settle();

    expect(other.undo.discardOwnTopCheckpoint()).toBe(false);
    expect(stored(storage)).toHaveLength(1);
  });

  it("refuses to undo while the room holds a foreign state with the same revision (R2-S3)", () => {
    const writerId = "me";
    const store = createAppStore({ writerId, getMinRevision: () => 10 });
    store.dispatch(setEncounterState(seedState(10)));
    const undo = new LocalUndoStore({
      store,
      writerId,
      roomId: ROOM,
      storage: memoryStorage(),
      eventTarget: null,
      getRoomIdentity: () => ({ revision: 11, writerId: "other" }),
    }).start();
    undos.push(undo);
    undo.captureCheckpoint("Hold: Hero");
    store.dispatch(setHold({ id: "r1", value: true }));
    expect(store.getState().swade).toMatchObject({ revision: 11, writerId: "me" });

    expect(undo.performUndo()).toBe(false);
    expect(store.getState().swade.rows[0].onHold).toBe(true);
  });
});

describe("LocalUndoStore validates stored snapshots (R4-A5)", () => {
  /** A store at seedState(5) and an undo store whose stored top checkpoint leads to it with `before`. */
  function withStoredBefore(before: unknown) {
    const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
    store.dispatch(setEncounterState(seedState(5)));
    const storage = memoryStorage();
    storage.setItem(KEY, JSON.stringify([{ before, description: "Tampered", after: { revision: 5, writerId: "seed" }, timestamp: Date.now() }]));
    const undo = new LocalUndoStore({ store, writerId: "me", roomId: ROOM, storage, eventTarget: null }).start();
    undos.push(undo);
    return { store, undo, storage };
  }

  it("refuses a snapshot that does not parse and drops it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, undo, storage } = withStoredBefore({ rows: [], phase: "bogus", round: -1 });
    const before = store.getState().swade;
    expect(undo.performUndo()).toBe(false);
    expect(store.getState().swade).toBe(before);
    expect(undo.canUndo()).toBe(false);
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("refuses a snapshot from a newer version", () => {
    const { store, undo } = withStoredBefore({ ...seedState(1), version: 99 });
    const before = store.getState().swade;
    expect(undo.performUndo()).toBe(false);
    expect(store.getState().swade).toBe(before);
  });

  it("restores the repaired form of a snapshot with bad cards", () => {
    const tampered = seedState(1);
    // KS is held by a row but listed in remaining (not in play); and an unknown card.
    tampered.rows[0] = { ...tampered.rows[0], currentCardId: "KS", candidateIds: ["KS", "ZZ"] };
    tampered.rows[1] = { ...tampered.rows[1], name: "Renamed" };
    const { store, undo } = withStoredBefore(tampered);
    expect(undo.performUndo()).toBe(true);
    const s = store.getState().swade;
    expect(s.rows[1].name).toBe("Renamed");
    expect(s.rows[0].currentCardId).toBeUndefined();
    expect(s.rows[0].candidateIds).toEqual([]);
    const all = [...s.deck.remaining, ...s.deck.inPlay, ...s.deck.discard];
    expect(new Set(all).size).toBe(54);
    expect(all).toHaveLength(54);
  });
});

describe("LocalUndoStore duplicated tabs (liveness lease)", () => {
  const checkpoint = (): UndoCheckpoint => ({ before: seedState(1), description: "Hold: Hero", after: { revision: 2, writerId: "w" }, timestamp: Date.now() });
  const leases: TabLease[] = [];
  afterEach(() => {
    for (const lease of leases.splice(0)) lease.dispose();
  });

  interface Doc {
    window: EventTarget;
    lease: TabLease;
    undo: LocalUndoStore;
  }

  /** One document (iframe) of the tab whose sessionStorage is `storage`: its lease registers now. */
  function doc(storage: Storage, options: { channel?: ((name: string) => UndoChannel) | null; timeoutMs?: number } = {}): Doc {
    const window = new EventTarget();
    const channel = options.channel === undefined ? bus : options.channel;
    const lease = new TabLease({ storage, eventTarget: window, channel, timeoutMs: options.timeoutMs });
    leases.push(lease);
    const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
    store.dispatch(setEncounterState({ ...seedState(2), writerId: "w" }));
    const undo = new LocalUndoStore({ store, writerId: "me", roomId: ROOM, storage, eventTarget: null, legacyStorage: null, channel, lease }).start();
    undos.push(undo);
    return { window, lease, undo };
  }

  const pagehide = (d: Doc) => d.window.dispatchEvent(new Event("pagehide"));
  const pageshow = (d: Doc, persisted: boolean) => d.window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));
  const listed = (storage: Storage): string[] => JSON.parse(storage.getItem(UNDO_LEASE_KEY) ?? "[]");

  /** A tab with one stored checkpoint. */
  function tabWithHistory() {
    const tab = memoryStorage();
    tab.setItem(UNDO_TAB_ID_KEY, `tab-${Math.random()}`);
    tab.setItem(KEY, JSON.stringify([checkpoint()]));
    return tab;
  }

  /** A copy of a tab's session storage, as a browser makes for a duplicated tab. */
  function copyOf(tab: Storage) {
    const copy = memoryStorage();
    for (let i = 0; i < tab.length; i++) copy.setItem(tab.key(i)!, tab.getItem(tab.key(i)!)!);
    return copy;
  }

  it("the first document of a tab (no other live document) keeps the history at once", () => {
    const tab = tabWithHistory();
    const first = doc(tab);
    expect(first.lease.verdict).toBe("kept");
    expect(first.undo.canUndo()).toBe(true);
    expect(listed(tab)).toEqual([first.lease.docId]);
  });

  it("a tab duplicated right after the original loaded (no wait) gets a new tab id and an empty history", async () => {
    const tab = tabWithHistory();
    const original = doc(tab);
    const dupTab = copyOf(tab); // same task: the original has not run any async step
    const duplicate = doc(dupTab);
    expect(duplicate.undo.canUndo()).toBe(false); // not shown while checking
    await duplicate.undo.ready;

    expect(duplicate.lease.verdict).toBe("duplicate");
    expect(duplicate.undo.canUndo()).toBe(false);
    expect(dupTab.getItem(KEY)).toBeNull();
    expect(dupTab.getItem(UNDO_TAB_ID_KEY)).not.toBe(tab.getItem(UNDO_TAB_ID_KEY));
    expect(listed(dupTab)).toEqual([duplicate.lease.docId]); // the original's copied id is dropped
    // The original keeps its history and tab id.
    expect(original.undo.canUndo()).toBe(true);
    expect(stored(tab)).toHaveLength(1);
    expect(listed(tab)).toEqual([original.lease.docId]);
  });

  it("a reload (pagehide, then the new document) keeps the history", () => {
    const tab = tabWithHistory();
    const tabId = tab.getItem(UNDO_TAB_ID_KEY);
    const original = doc(tab);
    pagehide(original);
    expect(listed(tab)).toEqual([]);
    original.undo.destroy();
    const reloaded = doc(tab);
    expect(reloaded.lease.verdict).toBe("kept");
    expect(reloaded.undo.canUndo()).toBe(true);
    expect(tab.getItem(UNDO_TAB_ID_KEY)).toBe(tabId);
  });

  it("sibling iframes of one tab share the history", async () => {
    const tab = tabWithHistory();
    const popover = doc(tab);
    const tabId = tab.getItem(UNDO_TAB_ID_KEY);
    const modal = doc(tab);
    const background = doc(tab);
    await Promise.all([modal.undo.ready, background.undo.ready]);
    expect(modal.lease.verdict).toBe("kept");
    expect(background.lease.verdict).toBe("kept");
    for (const d of [popover, modal, background]) expect(d.undo.canUndo()).toBe(true);
    expect(tab.getItem(UNDO_TAB_ID_KEY)).toBe(tabId);
    expect(listed(tab)).toHaveLength(3);
  });

  it("a sibling that closes during the check counts as this tab's; the original closing counts as another tab's", async () => {
    // A document that says bye on pagehide but does not answer `who`.
    const deaf = (name: string): UndoChannel => {
      const inner = bus(name);
      return { onmessage: null, postMessage: (data) => inner.postMessage(data), close: () => inner.close() };
    };
    const tab = tabWithHistory();
    const popover = doc(tab, { channel: deaf });
    const modal = doc(tab);
    pagehide(popover); // removes itself from this tab's lease, then says bye
    await modal.undo.ready;
    expect(modal.lease.verdict).toBe("kept");
    expect(modal.undo.canUndo()).toBe(true);

    const tab2 = tabWithHistory();
    const original = doc(tab2, { channel: deaf });
    const dupTab = copyOf(tab2);
    const duplicate = doc(dupTab);
    pagehide(original); // still listed in the duplicate's copy
    await duplicate.undo.ready;
    expect(duplicate.lease.verdict).toBe("duplicate");
    expect(listed(dupTab)).toEqual([duplicate.lease.docId]);
  });

  it("siblings in a duplicate agree on one new tab id", async () => {
    const tab = tabWithHistory();
    doc(tab);
    const dupTab = copyOf(tab);
    const first = doc(dupTab);
    const second = doc(dupTab);
    await Promise.all([first.undo.ready, second.undo.ready]);
    expect(first.lease.verdict).toBe("duplicate");
    expect(second.lease.verdict).toBe("duplicate");
    const newId = dupTab.getItem(UNDO_TAB_ID_KEY);
    expect(newId).not.toBe(tab.getItem(UNDO_TAB_ID_KEY));
    expect(first.undo.canUndo()).toBe(false);
    expect(second.undo.canUndo()).toBe(false);
    expect(listed(dupTab).sort()).toEqual([first.lease.docId, second.lease.docId].sort());
  });

  it("a bfcache restore re-adds the document to the lease", async () => {
    const tab = tabWithHistory();
    const original = doc(tab);
    pagehide(original);
    pagehide(original); // no second bye
    expect(listed(tab)).toEqual([]);
    pageshow(original, false); // a normal load is not a restore
    expect(listed(tab)).toEqual([]);
    pageshow(original, true);
    pageshow(original, true);
    expect(listed(tab)).toEqual([original.lease.docId]);

    const dupTab = copyOf(tab);
    const duplicate = doc(dupTab);
    await duplicate.undo.ready;
    expect(duplicate.lease.verdict).toBe("duplicate");
  });

  it("a listed document that never answers (crashed) is dropped after the time-out", async () => {
    const tab = tabWithHistory();
    tab.setItem(UNDO_LEASE_KEY, JSON.stringify(["crashed"]));
    const alone = doc(tab, { timeoutMs: 500 });
    await settle(499);
    expect(alone.lease.verdict).toBeNull();
    await settle(1);
    expect(alone.lease.verdict).toBe("duplicate"); // no sign of this tab: the safe side
    expect(alone.undo.canUndo()).toBe(false);
    expect(listed(tab)).toEqual([alone.lease.docId]);

    const tab2 = tabWithHistory();
    const live = doc(tab2);
    tab2.setItem(UNDO_LEASE_KEY, JSON.stringify(["crashed", live.lease.docId]));
    const sibling = doc(tab2, { timeoutMs: 500 });
    await settle(500);
    expect(sibling.lease.verdict).toBe("kept");
    expect(sibling.undo.canUndo()).toBe(true);
    expect(listed(tab2).sort()).toEqual([live.lease.docId, sibling.lease.docId].sort());
  });

  it("without a lease channel there is no check (the plain history)", () => {
    const tab = tabWithHistory();
    doc(tab);
    const noChannel = doc(copyOf(tab), { channel: null });
    expect(noChannel.lease.verdict).toBe("kept");
    expect(noChannel.undo.canUndo()).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failing = doc(copyOf(tab), { channel: () => { throw new Error("no channel"); } });
      expect(failing.lease.verdict).toBe("kept");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to memory when the tab storage throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const broken: Storage = {
        length: 0,
        clear: () => {},
        key: () => null,
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
        removeItem: () => { throw new Error("blocked"); },
      };
      const lease = new TabLease({ storage: broken, eventTarget: null, channel: bus });
      leases.push(lease);
      expect(lease.verdict).toBe("kept");
      await expect(lease.check()).resolves.toBe("kept");

      // The probe cannot be written: no check.
      const tab = memoryStorage();
      const original = doc(tab);
      const flaky = copyOf(tab);
      const setItem = flaky.setItem.bind(flaky);
      let writes = 0;
      flaky.setItem = (k, v) => {
        if (++writes > 1) throw new Error("full");
        setItem(k, v);
      };
      const d = new TabLease({ storage: flaky, eventTarget: null, channel: bus });
      leases.push(d);
      await expect(d.check()).resolves.toBe("kept");
      expect(original.lease.verdict).toBe("kept");

      // The store itself uses memory when sessionStorage throws.
      const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      try {
        const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
        store.dispatch(setEncounterState(seedState(1)));
        const undo = new LocalUndoStore({ store, writerId: "me", roomId: ROOM, eventTarget: null }).start();
        undos.push(undo);
        undo.captureCheckpoint("Hold");
        store.dispatch(setHold({ id: "r1", value: true }));
        expect(undo.canUndo()).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("joins a new tab id that a sibling took, on the storage event", () => {
    const tab = memoryStorage();
    const names: string[] = [];
    const channel = (name: string): UndoChannel => {
      names.push(name);
      return { onmessage: null, postMessage: () => {}, close: () => {} };
    };
    const window = new EventTarget() as unknown as Window;
    const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
    const undo = new LocalUndoStore({ store, writerId: "me", roomId: ROOM, storage: tab, eventTarget: window, legacyStorage: null, channel, lease: null }).start();
    undos.push(undo);
    tab.setItem(UNDO_TAB_ID_KEY, "new-id");
    window.dispatchEvent(Object.assign(new Event("storage"), { key: UNDO_TAB_ID_KEY }));
    expect(names.at(-1)).toBe("swade-undo:new-id");
  });

  it("stops waiting for the check when destroyed", async () => {
    const tab = tabWithHistory();
    doc(tab);
    const dupTab = copyOf(tab);
    const duplicate = doc(dupTab);
    duplicate.undo.destroy();
    await duplicate.lease.check();
    expect(duplicate.undo.canUndo()).toBe(false);
  });
});
