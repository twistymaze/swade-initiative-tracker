// Modal → background action channel: the background page of the same connection dispatches
// and saves a modal's change, so its engine can replay it after the modal closed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("./test/obrMock").then((m) => m.createSdkModule()));

import { FakeBroadcastChannel, createClient, hub, obr, resetObrMock, simulateRemoteWrite, type ObrClient } from "./test/obrMock";
import { createAppStore, createWriterId, type AppStore } from "./store/store";
import { createSyncEngine, STATE_KEY, SYNC_PROTOCOL, type SyncEngine, type SyncObr } from "./store/syncEngine";
import { encodeEncounterState, parseEncounterState } from "./store/stateCodec";
import { initializeEmptyState } from "./store/initialState";
import { LocalUndoStore, UNDO_STORAGE_PREFIX } from "./store/localUndoStore";
import { addCandidateCard, createParticipant, dealRound, restoreSnapshot, selectKeeperCard, setEncounterState } from "./store/swadeSlice";
import {
  ACCEPT_TIMEOUT_MS,
  ACTION_CHANNEL,
  RESULT_TIMEOUT_MS,
  parseModalAction,
  sendToBackground,
  startActionHandler,
  type ActionHandlerDeps,
} from "./actionChannel";
import type { EncounterState } from "./store/types";

interface Frame {
  obr: ObrClient;
  store: AppStore;
  engine: SyncEngine;
  writerId: string;
  undo: LocalUndoStore;
}

const stops: (() => void)[] = [];

/** One iframe (own store, engine, undo store) on the given client connection. */
function frame(client: ObrClient): Frame {
  const writerId = createWriterId();
  const store = createAppStore({ writerId, getMinRevision: () => engine.getMaxSeenRevision() });
  const engine = createSyncEngine({
    store,
    obr: client as unknown as SyncObr,
    writerId,
    isGm: () => client.state.player.role === "GM",
    subscribeRole: (listener) => client.player.onChange(() => listener()),
  });
  const undo = new LocalUndoStore({ store, writerId, roomId: hub().roomId, getRoomIdentity: () => engine.getRoomIdentity() }).start();
  stops.push(() => engine.stop(), () => undo.destroy());
  return { obr: client, store, engine, writerId, undo };
}

/** A background page on this client: a frame plus the request handler. */
function background(client: ObrClient, overrides: Partial<ActionHandlerDeps> = {}): Frame {
  const bg = frame(client);
  stops.push(
    startActionHandler({
      getConnectionId: () => client.player.getConnectionId(),
      whenReady: async () => {
        await bg.engine.start();
        return client.state.player.role === "GM" && bg.engine.getSnapshot().loaded;
      },
      dispatch: (action) => bg.store.dispatch(action),
      undo: () => bg.undo,
      save: async () => {
        await bg.engine.retry();
        return bg.engine.flush();
      },
      ...overrides,
    })
  );
  return bg;
}

const settle = (ms = 30_000) => vi.advanceTimersByTimeAsync(ms);
const room = (): EncounterState => {
  const result = parseEncounterState(hub().roomMetadata[STATE_KEY]);
  if (result.kind !== "ok") throw new Error(`room holds ${result.kind}`);
  return result.state;
};
const names = (state: EncounterState) => state.rows.map((r) => r.name).sort();
const addOp = (name: string) => {
  const action = createParticipant({ name, type: "NPC" });
  return { op: "dispatch" as const, description: `Add Combatant: ${name}`, actions: [action], rowId: action.payload.id };
};
const undoStack = () => JSON.parse(sessionStorage.getItem(`${UNDO_STORAGE_PREFIX}${hub().roomId}`) ?? "[]");
/** Changes the store made by actions, not by adopting room states. */
const localDispatches = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([a]) => (a as { type: string }).type !== "swade/setEncounterState");
const hostError = () => ({ error: { name: "Unknown", message: "refused" } });

/** Listen on the channel like another page and record every message. */
function spyChannel() {
  const messages: unknown[] = [];
  const channel = new FakeBroadcastChannel(ACTION_CHANNEL);
  channel.onmessage = (event) => messages.push(event.data);
  stops.push(() => channel.close());
  return messages;
}

/**
 * Another GM's write made from the room state before P (it misses P) lands after P was
 * saved and the modal closed. Only a live engine that logged P can replay it.
 */
function lateWriteWithout(base: EncounterState, name: string) {
  const other = createAppStore({ writerId: "gm-b", getMinRevision: () => room().revision });
  other.dispatch(setEncounterState(base));
  other.dispatch(createParticipant({ name, type: "PC" }));
  simulateRemoteWrite("room", { [STATE_KEY]: encodeEncounterState(other.getState().swade, { revision: base.revision, writerId: base.writerId }, { syncProtocol: SYNC_PROTOCOL }) });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  sessionStorage.clear();
  resetObrMock();
  hub().roomMetadata = { [STATE_KEY]: encodeEncounterState({ ...initializeEmptyState(), revision: 1, writerId: "seed" }) };
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  FakeBroadcastChannel.reset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("background handles modal requests", () => {
  it("dispatches the modal's action once, writes once, replies saved; one undo checkpoint the popover can use", async () => {
    const bg = background(obr());
    const popover = frame(obr());
    await popover.engine.start();
    await settle(100);
    const writesBefore = obr().room.setMetadata.mock.calls.length;

    const { rowId, ...op } = addOp("Goblin");
    const outcome = sendToBackground(op);
    await settle();

    expect(await outcome).toBe("saved");
    expect(obr().room.setMetadata.mock.calls.length - writesBefore).toBe(1);
    expect(room().rows).toMatchObject([{ id: rowId, name: "Goblin", type: "NPC" }]);
    expect(room().writerId).toBe(bg.writerId);

    const stack = undoStack();
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({ description: "Add Combatant: Goblin", after: { revision: room().revision, writerId: bg.writerId } });
    // The popover adopted the room state, so its Undo is on for the background's checkpoint.
    expect(popover.store.getState().swade.rows).toHaveLength(1);
    expect(popover.undo.canUndo()).toBe(true);
    expect(popover.undo.getUndoDescription()).toBe("Add Combatant: Goblin");
  });

  it("a background page of another connection (second tab) ignores the request; the modal falls back", async () => {
    const otherTab = createClient({ role: "GM" });
    const bg = background(otherTab);
    await bg.engine.start();
    await settle(100);
    const dispatch = vi.spyOn(bg.store, "dispatch");

    const { rowId: _rowId, ...op } = addOp("Goblin");
    void _rowId;
    const outcome = sendToBackground(op);
    await settle(ACCEPT_TIMEOUT_MS - 1);
    expect(localDispatches(dispatch)).toEqual([]);
    await settle(1);

    expect(await outcome).toBe("unavailable");
    expect(otherTab.room.setMetadata).not.toHaveBeenCalled();
    expect(room().rows).toEqual([]);
  });

  it("two GMs: A adds via the modal (A's background), B adds directly with its write landing later; both survive", async () => {
    const b = createClient({ role: "GM" });
    background(obr());
    const gmB = frame(b);
    await gmB.engine.start();
    await settle(100);

    // B never sees the echo of its own write, so it cannot tell that it overwrote P.
    b.setOwnEcho("never");
    b.setWriteDelay(100);
    gmB.store.dispatch(createParticipant({ name: "Q", type: "PC" }));
    await settle(60); // B's write (from the old room state) is in flight
    const { rowId: _p, ...op } = addOp("P");
    void _p;
    const outcome = sendToBackground(op);
    await settle();

    expect(await outcome).toBe("saved");
    expect(names(room())).toEqual(["P", "Q"]);
    expect(names(gmB.store.getState().swade)).toEqual(["P", "Q"]);
    expect(obr().state.notifications).toEqual([]);
  });

  it("a write that misses the modal's add lands after the modal closed: the background replays it", async () => {
    background(obr());
    await settle(100);
    const before = room();

    const { rowId: _p, ...op } = addOp("P");
    void _p;
    const outcome = sendToBackground(op);
    await settle(100);
    expect(await outcome).toBe("saved"); // the modal closes now
    lateWriteWithout(before, "Q");
    await settle();

    expect(names(room())).toEqual(["P", "Q"]);
  });

  it("control: the same late write loses P when the modal's own engine wrote it and is gone", async () => {
    const modal = frame(obr());
    await modal.engine.start();
    await settle(100);
    const before = room();

    modal.store.dispatch(createParticipant({ name: "P", type: "NPC" }));
    expect(await modal.engine.flush()).toBe(true);
    modal.engine.stop(); // OBR.modal.close destroys the iframe
    lateWriteWithout(before, "Q");
    await settle();

    expect(names(room())).toEqual(["Q"]);
  });

  it("a failed save replies failed; a save-only retry writes it; cancel-add removes the row and its checkpoint", async () => {
    background(obr());
    await settle(100);

    obr().failRoom("setMetadata", hostError());
    const { rowId, ...op } = addOp("Orc");
    const first = sendToBackground(op);
    await settle();
    expect(await first).toBe("failed");
    expect(room().rows).toEqual([]);

    const retry = sendToBackground({ op: "dispatch", description: "", actions: [] });
    await settle();
    expect(await retry).toBe("saved");
    expect(names(room())).toEqual(["Orc"]);
    expect(undoStack()).toHaveLength(1); // the retry added no checkpoint

    obr().failRoom("setMetadata", hostError());
    const { rowId: secondId, ...second } = addOp("Elf");
    const failed = sendToBackground(second);
    await settle();
    expect(await failed).toBe("failed");
    expect(undoStack()).toHaveLength(2);

    const cancel = sendToBackground({ op: "cancel-add", rowId: secondId });
    await settle();
    expect(await cancel).toBe("saved");
    expect(room().rows.map((r) => r.id)).toEqual([rowId]);
    expect(undoStack()).toHaveLength(1);
    expect(undoStack()[0].description).toBe("Add Combatant: Orc");
  });

  it("no result after acceptance: the modal reports failed after the result timeout", async () => {
    background(obr(), { save: () => new Promise<boolean>(() => {}) });
    await settle(100);

    const { rowId: _r, ...op } = addOp("Orc");
    void _r;
    let outcome: string | null = null;
    void sendToBackground(op).then((o) => (outcome = o));
    await settle(RESULT_TIMEOUT_MS - 1);
    expect(outcome).toBeNull();
    await settle(1);
    expect(outcome).toBe("failed");
  });

  it("a background that may not act (player) rejects at once; nothing is dispatched", async () => {
    obr().setRole("PLAYER");
    const bg = background(obr());
    await settle(100);
    const dispatch = vi.spyOn(bg.store, "dispatch");

    const { rowId: _r, ...op } = addOp("Orc");
    void _r;
    const outcome = sendToBackground(op);
    await settle(10);
    expect(await outcome).toBe("unavailable");
    expect(localDispatches(dispatch)).toEqual([]);
  });

  it("a request older than the accept window is rejected, not dispatched", async () => {
    const bg = background(obr());
    await settle(100);
    const dispatch = vi.spyOn(bg.store, "dispatch");
    const messages = spyChannel();
    const connectionId = await obr().player.getConnectionId();

    const { rowId: _r, ...op } = addOp("Orc");
    void _r;
    FakeBroadcastChannel.post(ACTION_CHANNEL, { kind: "request", id: "old-1", connectionId, sentAt: Date.now() - 5000, op });
    await settle(10);

    expect(localDispatches(dispatch)).toEqual([]);
    expect(messages).toContainEqual({ kind: "rejected", id: "old-1", connectionId });
  });

  it("malformed messages and unknown actions are ignored (no dispatch, no reply)", async () => {
    const bg = background(obr());
    await settle(100);
    const dispatch = vi.spyOn(bg.store, "dispatch");
    const messages = spyChannel();
    const connectionId = await obr().player.getConnectionId();
    const request = (op: unknown, extra: object = {}) => ({ kind: "request", id: "x1", connectionId, sentAt: Date.now(), op, ...extra });
    const dispatchOp = (actions: unknown) => ({ op: "dispatch", description: "Hack", actions });

    for (const data of [
      null,
      "request",
      [1, 2],
      { kind: "request" },
      request(dispatchOp([]), { sentAt: "now" }),
      request(dispatchOp([]), { id: 7 }),
      request({ op: "drop-table" }),
      request({ op: "cancel-add" }),
      request(dispatchOp("all")),
      request(dispatchOp([restoreSnapshot(initializeEmptyState())])),
      request(dispatchOp([{ type: "swade/endInitiative" }])),
      request(dispatchOp([{ type: "swade/createParticipant", payload: { id: "a", name: "X", type: "BOSS" } }])),
      request(dispatchOp([{ type: "swade/createParticipant", payload: { id: "a", name: "", type: "PC" } }])),
      request(dispatchOp([{ type: "swade/selectKeeperCard", payload: { participantId: "a" } }])),
      request(dispatchOp([{ type: "swade/addCandidateCard", payload: { id: "a" } }])),
      request(dispatchOp(Array.from({ length: 11 }, () => ({ type: "swade/addCandidateCard", payload: "a" })))),
      request({ ...dispatchOp([]), description: "x".repeat(201) }),
    ]) {
      FakeBroadcastChannel.post(ACTION_CHANNEL, data);
    }
    await settle(10);

    expect(localDispatches(dispatch)).toEqual([]);
    expect(messages).toHaveLength(17); // only our own posts; no replies
  });

  it("rebuilds allowed actions from checked fields only", () => {
    expect(parseModalAction({ type: "swade/createParticipant", payload: { id: "a", name: "X", type: "PC", imageUrl: "https://i/x.png", extra: 1 }, meta: "m" })).toEqual({
      type: "swade/createParticipant",
      payload: { id: "a", name: "X", type: "PC", imageUrl: "https://i/x.png" },
    });
    expect(parseModalAction({ type: "swade/createParticipant", payload: { id: "a", name: "X", type: "PC", imageUrl: 5 } })).toBeNull();
    expect(parseModalAction({ type: "swade/selectKeeperCard", payload: { participantId: "a", cardId: "5H", x: 1 } })).toEqual({
      type: "swade/selectKeeperCard",
      payload: { participantId: "a", cardId: "5H" },
    });
    expect(parseModalAction({ type: "swade/undoLastDraw", payload: "a" })).toEqual({ type: "swade/undoLastDraw", payload: "a" });
    expect(parseModalAction({ type: "swade/discardExtraCandidates", payload: "a" })).toEqual({ type: "swade/discardExtraCandidates", payload: "a" });
  });

  it("without BroadcastChannel the modal reports unavailable and the handler does nothing", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const stop = startActionHandler({
      getConnectionId: async () => "c",
      whenReady: async () => true,
      dispatch: () => {},
      undo: () => null,
      save: async () => true,
    });
    stop();
    expect(await sendToBackground({ op: "dispatch", description: "", actions: [] })).toBe("unavailable");
  });

  it("a failing connection id read: the modal reports unavailable", async () => {
    obr().player.getConnectionId.mockRejectedValueOnce(new Error("not ready"));
    expect(await sendToBackground({ op: "dispatch", description: "", actions: [] })).toBe("unavailable");
  });
});

describe("review 7", () => {
  /** Room with Bob dealt one card (cards_dealt). */
  function seedDealtBob() {
    const seed = createAppStore({ writerId: "seed", getMinRevision: () => 0 });
    seed.dispatch(setEncounterState({ ...initializeEmptyState(), revision: 1, writerId: "seed" }));
    seed.dispatch(createParticipant({ name: "Bob", type: "PC" }));
    seed.dispatch(dealRound());
    hub().roomMetadata = { [STATE_KEY]: encodeEncounterState(seed.getState().swade) };
  }
  const allCards = (s: EncounterState) => [...s.deck.remaining, ...s.deck.inPlay, ...s.deck.discard];

  it("R7-1: a confirmed keeper whose draw is replayed onto a state where another GM took that card is not dropped silently", async () => {
    seedDealtBob();
    background(obr());
    await settle(100);
    const before = room();
    const bob = before.rows[0];

    const draw = sendToBackground({ op: "dispatch", description: "Draw", actions: [addCandidateCard(bob.id)] });
    await settle(100);
    expect(await draw).toBe("saved");
    const x = room().rows[0].candidateIds[1];
    const keep = sendToBackground({ op: "dispatch", description: "Choose", actions: [selectKeeperCard({ participantId: bob.id, cardId: x })] });
    await settle(100);
    expect(await keep).toBe("saved");
    expect(room().rows[0].currentCardId).toBe(x);

    // Another GM, from the state before the draw, adds a late joiner (dealt the top card, x).
    lateWriteWithout(before, "Late");
    await settle();

    const final = room();
    expect(final.rows.find((r) => r.name === "Late")?.currentCardId).toBe(x);
    expect(obr().state.notifications.map(({ message, variant }) => ({ message, variant }))).toEqual([
      { message: "Initiative tracker: a change in the room may have replaced your last change.", variant: "WARNING" },
    ]);
    expect(new Set(allCards(final)).size).toBe(54);
  });

  it("S1: the modal's fallback dispatch of an add the background already made does not add the row twice", async () => {
    seedDealtBob();
    background(obr());
    const modal = frame(obr());
    await modal.engine.start();
    await settle(100);

    const { rowId, ...op } = addOp("Orc");
    expect(await (async () => { const p = sendToBackground(op); await settle(100); return p; })()).toBe("saved");
    expect(modal.store.getState().swade.rows.map((r) => r.id)).toContain(rowId);
    const before = modal.store.getState().swade;

    // The modal's accept timer fired before it read "accepted" (blocked main thread): it falls back.
    modal.store.dispatch(op.actions[0]);
    await settle();

    expect(modal.store.getState().swade).toBe(before);
    expect(room().rows.filter((r) => r.id === rowId)).toHaveLength(1);
    expect(room().deck.discard).toEqual([]);
  });

  it("S2: cancel-add does not drop a newer checkpoint (a token add made while the modal showed the error)", async () => {
    const bg = background(obr());
    await settle(100);

    obr().failRoom("setMetadata", hostError());
    const { rowId, ...op } = addOp("Orc");
    const first = sendToBackground(op);
    await settle();
    expect(await first).toBe("failed");

    // A context-menu add on the same background page (background.ts addTokens).
    bg.undo.captureCheckpoint("Add NPC from token");
    bg.store.dispatch(createParticipant({ name: "Token", type: "NPC" }));
    expect(await bg.engine.flush()).toBe(true);
    expect(undoStack().map((c: { description: string }) => c.description)).toEqual(["Add Combatant: Orc", "Add NPC from token"]);

    const cancel = sendToBackground({ op: "cancel-add", rowId });
    await settle();
    expect(await cancel).toBe("saved");
    expect(names(room())).toEqual(["Token"]);
    expect(undoStack().map((c: { description: string }) => c.description)).toContain("Add NPC from token");
  });
});
