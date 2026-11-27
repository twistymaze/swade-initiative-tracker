import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));

import { flushObr, hub, rateLimitError, resetObrMock, timeoutError, type ObrClient } from "../test/obrMock";
import { createAppStore, createWriterId, type AppStore } from "./store";
import { APP_VERSION, createSyncEngine, ECHO_WAIT_MS, STATE_KEY, SYNC_PROTOCOL, type SyncEngine, type SyncObr } from "./syncEngine";
import { encodeEncounterState, parseEncounterState } from "./stateCodec";
import { initializeEmptyState } from "./initialState";
import { createParticipant, dealRound, endRound, loseHold, removeParticipant, renameParticipant, reset, setActiveParticipant, setEncounterState, setHold, setPrivacy, startRound, swadeSlice } from "./swadeSlice";
import type { EncounterState } from "./types";

interface Client {
  obr: ObrClient;
  store: AppStore;
  engine: SyncEngine;
  writerId: string;
  state: () => EncounterState;
  /** The iframe becomes visible again (subscribeWake). */
  wake: () => void;
}

const engines: SyncEngine[] = [];

function connect(obr: ObrClient): Client {
  const writerId = createWriterId();
  // `engine` is only read when an action is dispatched, after it is assigned.
  const store = createAppStore({ writerId, getMinRevision: () => engine.getMaxSeenRevision() });
  const engine = createSyncEngine({
    store,
    obr: obr as unknown as SyncObr,
    writerId,
    isGm: () => obr.state.player.role === "GM",
    subscribeRole: (listener) => obr.player.onChange(() => listener()),
    subscribeWake: (listener) => {
      wakeListeners.add(listener);
      return () => wakeListeners.delete(listener);
    },
  });
  const wakeListeners = new Set<() => void>();
  engines.push(engine);
  const wake = () => {
    for (const listener of [...wakeListeners]) listener();
  };
  return { obr, store, engine, writerId, state: () => store.getState().swade, wake };
}

const gm = () => connect(hub().activeClient);
const another = (role: "GM" | "PLAYER") => connect(hub().createClient({ role }));

/** Let debounces, retries, events and awaits run. */
const settle = (ms = 10_000) => vi.advanceTimersByTimeAsync(ms);

const room = (): EncounterState => {
  const result = parseEncounterState(hub().roomMetadata[STATE_KEY]);
  if (result.kind !== "ok") throw new Error(`room holds ${result.kind}`);
  return result.state;
};

/** What the current app stores as `client` (another GM of this version). */
const CLIENT = { syncProtocol: SYNC_PROTOCOL, appVersion: APP_VERSION };

/** Normalise `imageUrl: undefined` etc. so local and parsed room states compare. */
const plain = (s: EncounterState) => JSON.parse(JSON.stringify(s));

function seedState(revision: number): EncounterState {
  const state = initializeEmptyState();
  state.rows = [
    { id: "r1", name: "Hero", type: "PC", inactive: false, onHold: false, revealed: true, candidateIds: [] },
    { id: "r2", name: "Orc", type: "NPC", inactive: false, onHold: false, revealed: false, candidateIds: [] },
  ];
  return { ...state, revision, writerId: "seed" };
}

function seedRoom(state: EncounterState | Record<string, unknown>) {
  hub().roomMetadata = {
    ...hub().roomMetadata,
    [STATE_KEY]: "rows" in state && Array.isArray(state.rows) && "writerId" in state ? encodeEncounterState(state as EncounterState) : state,
  };
}

/** Make the next setMetadata of `client` wait until the returned function is called. */
function holdNextWrite(client: Client): () => void {
  let release = () => {};
  client.obr.room.setMetadata.mockImplementationOnce(
    (patch) =>
      new Promise<void>((resolve) => {
        release = () => {
          hub().writeRoomMetadata(patch);
          resolve();
        };
      })
  );
  return () => release();
}

const notifications = (client: Client, variant: string) =>
  client.obr.state.notifications.filter((n) => n.variant === variant);

beforeEach(() => {
  vi.useFakeTimers();
  resetObrMock();
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  vi.useRealTimers();
});

describe("createAppStore (revision stamping)", () => {
  it("bumps revision by exactly 1 and sets writerId on any changing action", () => {
    const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
    const before = store.getState().swade;
    store.dispatch(setPrivacy(false));
    expect(store.getState().swade.revision).toBe(before.revision + 1);
    expect(store.getState().swade.writerId).toBe("me");
  });

  it("stamps above the minimum revision seen in the room", () => {
    const store = createAppStore({ writerId: "me", getMinRevision: () => 20 });
    store.dispatch(setPrivacy(false));
    expect(store.getState().swade.revision).toBe(21);
  });

  it("returns the same reference for a no-op action", () => {
    const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
    const before = store.getState().swade;
    store.dispatch(setHold({ id: "missing", value: true }));
    expect(store.getState().swade).toBe(before);
  });

  it("does not stamp setEncounterState", () => {
    const store = createAppStore({ writerId: "me", getMinRevision: () => 99 });
    const incoming = seedState(5);
    store.dispatch(setEncounterState(incoming));
    expect(store.getState().swade).toBe(incoming);
  });

  it("stamps reset with a higher revision than the state it replaces", () => {
    const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
    store.dispatch(setEncounterState(seedState(30)));
    store.dispatch(reset());
    expect(store.getState().swade).toMatchObject({ revision: 31, writerId: "me", rows: [] });
  });

  it("gives created participants a short id", () => {
    const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
    store.dispatch(createParticipant({ name: "A", type: "PC" }));
    expect(store.getState().swade.rows[0].id).toMatch(/^[a-z0-9]{1,8}$/);
  });
});

describe("sync engine", () => {
  it("(1) two GMs acting in the same tick converge with the room", async () => {
    seedRoom(seedState(10));
    const a = gm();
    const b = another("GM");
    await Promise.all([a.engine.start(), b.engine.start()]);
    await settle();

    a.store.dispatch(setHold({ id: "r1", value: true }));
    b.store.dispatch(renameParticipant({ id: "r2", name: "Big Orc" }));
    await settle();

    expect(plain(a.state())).toEqual(plain(room()));
    expect(plain(b.state())).toEqual(plain(room()));
  });

  it("(2) a late write with a smaller identity still converges", async () => {
    seedRoom(seedState(10));
    const a = gm();
    const b = another("GM");
    await Promise.all([a.engine.start(), b.engine.start()]);
    await settle();

    const releaseA = holdNextWrite(a);
    a.store.dispatch(setHold({ id: "r1", value: true })); // rev 11, held in flight
    await settle(100);
    b.store.dispatch(renameParticipant({ id: "r2", name: "B1" }));
    await settle(100);
    b.store.dispatch(renameParticipant({ id: "r2", name: "B2" }));
    await settle(100);
    expect(room().revision).toBeGreaterThan(11);

    releaseA(); // lands last
    await settle();

    expect(plain(a.state())).toEqual(plain(room()));
    expect(plain(b.state())).toEqual(plain(room()));
  });

  it("(3) a pending local change wins over a foreign state that arrives meanwhile", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    a.store.dispatch(setHold({ id: "r1", value: true })); // debounced
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...seedState(15), writerId: "other" }) });
    await settle();

    expect(room().revision).toBe(16);
    expect(room().writerId).toBe(a.writerId);
    expect(room().rows[0].onHold).toBe(true);
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("(4) a failed initial read never writes and retries until it loads", async () => {
    seedRoom(seedState(10));
    const a = gm();
    a.obr.failRoom("getMetadata", new Error("Message OBR_ROOM_GET_METADATA took longer than 5000ms to get a result"));
    void a.engine.start();
    await flushObr();

    expect(a.engine.getSnapshot()).toMatchObject({ status: "loading", loaded: false });
    expect(a.obr.room.setMetadata).not.toHaveBeenCalled();

    await settle(600);
    expect(a.engine.getSnapshot()).toMatchObject({ status: "ready", loaded: true });
    expect(a.state().revision).toBe(10);
    expect(a.obr.room.setMetadata).not.toHaveBeenCalled();
  });

  it("(4b) reports error after repeated read failures", async () => {
    const a = gm();
    a.obr.failRoom("getMetadata", new Error("offline"), 10);
    void a.engine.start();
    await settle(500 + 1000 + 2000 + 100);
    expect(a.engine.getSnapshot()).toMatchObject({ status: "error", loaded: false });
    expect(a.obr.room.setMetadata).not.toHaveBeenCalled();
  });

  it("(5) invalid room data: no write, status invalid; a GM reset then writes", async () => {
    seedRoom({ round: 1, phase: "in_round", deck: {}, rows: {} });
    const a = gm();
    await a.engine.start();
    await settle();

    expect(a.engine.getSnapshot().status).toBe("invalid");
    expect(a.obr.room.setMetadata).not.toHaveBeenCalled();

    a.store.dispatch(reset());
    await settle();
    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(room().rows).toEqual([]);
  });

  it("(5b) a newer stored version is read-only (too-new)", async () => {
    seedRoom({ ...encodeEncounterState(seedState(4)), version: 3 });
    const a = gm();
    await a.engine.start();
    await settle();
    a.store.dispatch(setPrivacy(false));
    await settle();

    expect(a.engine.getSnapshot().status).toBe("too-new");
    expect(a.obr.room.setMetadata).not.toHaveBeenCalled();
  });

  it("(6) empty room with 2 GMs and 1 player: the player never writes, all converge", async () => {
    const a = gm();
    const b = another("GM");
    const p = another("PLAYER");
    await Promise.all([a.engine.start(), b.engine.start(), p.engine.start()]);
    await settle();

    expect(p.obr.room.setMetadata).not.toHaveBeenCalled();
    expect(plain(a.state())).toEqual(plain(room()));
    expect(plain(b.state())).toEqual(plain(room()));
    expect(plain(p.state())).toEqual(plain(room()));
    expect(p.engine.getSnapshot().status).toBe("ready");
  });

  it("(6b) a player alone in an empty room shows an empty tracker and writes nothing", async () => {
    const p = another("PLAYER");
    await p.engine.start();
    await settle();
    expect(p.engine.getSnapshot()).toMatchObject({ status: "absent-player", loaded: true });
    expect(p.state().rows).toEqual([]);
    expect(p.obr.room.setMetadata).not.toHaveBeenCalled();
    expect(hub().roomMetadata[STATE_KEY]).toBeUndefined();

    // Unrelated room metadata changes do not re-shuffle the local empty state.
    const before = p.state();
    hub().writeRoomMetadata({ "other.ext/x": 1 });
    await settle();
    expect(p.state()).toBe(before);
  });

  it("(7) an initial read that resolves after a newer event is dropped", async () => {
    seedRoom(seedState(10));
    const a = gm();
    const release = a.obr.delayNextRoomRead();
    void a.engine.start();
    await flushObr();

    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...seedState(11), writerId: "other" }) });
    await flushObr();
    release();
    await settle();

    expect(a.state().revision).toBe(11);
  });

  it("(8) RateLimitHit twice then ok: saved, no error notification", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    a.obr.failRoom("setMetadata", rateLimitError(), 2);
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();

    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(3);
    expect(plain(room())).toEqual(plain(a.state()));
    expect(notifications(a, "ERROR")).toHaveLength(0);
    expect(a.engine.getSnapshot().status).toBe("ready");
  });

  it("(8b) RateLimitHit four times: exactly one error notification; the next change retries", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    a.obr.failRoom("setMetadata", rateLimitError(), 4);
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();

    expect(notifications(a, "ERROR")).toHaveLength(1);
    expect(a.engine.getSnapshot().status).toBe("error");
    expect(room().revision).toBe(10);

    a.store.dispatch(setHold({ id: "r2", value: true }));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(plain(room())).toEqual(plain(a.state()));
  });

  it("(9) size guard: one warning above 10 kB, no write and one error above the budget", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    const longName = "N".repeat(400);
    for (let i = 0; i < 25; i++) a.store.dispatch(createParticipant({ name: `${longName}${i}`, type: "NPC" }));
    await settle();
    expect(a.engine.getSnapshot().nearLimit).toBe(true);
    expect(notifications(a, "WARNING")).toHaveLength(1);
    expect(room().rows).toHaveLength(27);

    a.store.dispatch(createParticipant({ name: "one more", type: "NPC" }));
    await settle();
    expect(notifications(a, "WARNING")).toHaveLength(1); // once per crossing

    // Another extension now uses 6 kB of the room.
    hub().writeRoomMetadata({ "other.ext/data": "x".repeat(6000) });
    await settle();
    const writes = a.obr.room.setMetadata.mock.calls.length;
    a.store.dispatch(createParticipant({ name: "too many", type: "NPC" }));
    await settle();
    a.store.dispatch(createParticipant({ name: "still too many", type: "NPC" }));
    await settle();

    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(writes);
    expect(notifications(a, "ERROR")).toHaveLength(1);
    expect(a.engine.getSnapshot().status).toBe("too-large");
  });

  it("(8c) retry() after a failed write saves the newest local state without a new change", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    a.obr.failRoom("setMetadata", rateLimitError(), 4);
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("error");
    const writes = a.obr.room.setMetadata.mock.calls.length;

    // flush() alone has nothing queued, so it writes nothing.
    await a.engine.flush();
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(writes);

    const retried = a.engine.retry();
    await settle();
    await retried;
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(writes + 1);
    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(plain(room())).toEqual(plain(a.state()));
    expect(notifications(a, "ERROR")).toHaveLength(1);
  });

  it("(8d) retry() is a no-op when nothing failed, and for players", async () => {
    seedRoom(seedState(10));
    const a = gm();
    const p = another("PLAYER");
    await a.engine.start();
    await p.engine.start();
    await settle();

    await a.engine.retry();
    await p.engine.retry();
    await settle();
    expect(a.obr.room.setMetadata).not.toHaveBeenCalled();
    expect(p.obr.room.setMetadata).not.toHaveBeenCalled();
    expect(a.engine.getSnapshot().status).toBe("ready");
  });

  it("(9b) retry() while still too large writes nothing and does not notify again", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    hub().writeRoomMetadata({ "other.ext/data": "x".repeat(15800) });
    await settle();
    a.store.dispatch(createParticipant({ name: "Goblin", type: "NPC" }));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("too-large");
    const writes = a.obr.room.setMetadata.mock.calls.length;

    await a.engine.retry();
    await settle();
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(writes);
    expect(a.engine.getSnapshot().status).toBe("too-large");
    expect(notifications(a, "ERROR")).toHaveLength(1);
  });

  it("(10) reset on A while B's write is in flight: converge, room revision never decreases", async () => {
    seedRoom(seedState(10));
    const a = gm();
    const b = another("GM");
    await Promise.all([a.engine.start(), b.engine.start()]);
    await settle();

    const revisions: number[] = [];
    const write = hub().writeRoomMetadata.bind(hub());
    vi.spyOn(hub(), "writeRoomMetadata").mockImplementation((patch) => {
      write(patch);
      revisions.push(room().revision);
    });

    const releaseB = holdNextWrite(b);
    b.store.dispatch(setHold({ id: "r1", value: true }));
    await settle(100);
    a.store.dispatch(reset());
    await settle(100);
    releaseB();
    await settle();

    expect(plain(a.state())).toEqual(plain(room()));
    expect(plain(b.state())).toEqual(plain(room()));
    for (let i = 1; i < revisions.length; i++) expect(revisions[i]).toBeGreaterThanOrEqual(revisions[i - 1]);
  });

  it("(11) a player receiving updates makes no reads after load", async () => {
    seedRoom(seedState(10));
    const a = gm();
    const p = another("PLAYER");
    await Promise.all([a.engine.start(), p.engine.start()]);
    await settle();
    p.obr.room.getMetadata.mockClear();

    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    a.store.dispatch(renameParticipant({ id: "r2", name: "Orc boss" }));
    await settle();

    expect(p.obr.room.getMetadata).not.toHaveBeenCalled();
    expect(a.obr.room.getMetadata).toHaveBeenCalledTimes(1); // only the initial read
    expect(plain(p.state())).toEqual(plain(room()));
  });

  it("(12) flush writes the pending change before it resolves", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    a.store.dispatch(setHold({ id: "r1", value: true }));
    expect(a.obr.room.setMetadata).not.toHaveBeenCalled();
    await a.engine.flush();
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
    expect(room().rows[0].onHold).toBe(true);
  });

  it("loads an existing v1 room state; only a GM change writes it back as v2", async () => {
    seedRoom({
      version: 1,
      round: 0,
      phase: "setup",
      deck: { remaining: initializeEmptyState().deck.remaining, inPlay: [], discard: [], reshuffleAfterRound: false },
      rows: [{ id: "p-1-x", name: "Old", tokenIds: ["t"], type: "PC", inactive: false, onHold: false, revealed: true, candidateIds: [], drewThisRound: false }],
      turn: { activeRowId: null },
      settings: { hideNpcFromPlayers: true },
      revision: 0,
    });
    const a = gm();
    const p = another("PLAYER");
    await Promise.all([a.engine.start(), p.engine.start()]);
    await settle();

    expect(a.state().rows[0].name).toBe("Old");
    expect(p.state().rows[0].name).toBe("Old");
    expect(a.obr.room.setMetadata).not.toHaveBeenCalled();

    a.store.dispatch(setPrivacy(false));
    await settle();
    expect(hub().roomMetadata[STATE_KEY]).toMatchObject({ version: 2, revision: 1 });
    expect(p.obr.room.setMetadata).not.toHaveBeenCalled();
  });

  it("key deleted mid-session: player shows empty, GM writes fresh state once, unrelated events change nothing", async () => {
    seedRoom(seedState(10));
    const a = gm();
    const p = another("PLAYER");
    await Promise.all([a.engine.start(), p.engine.start()]);
    await settle();

    // A v1 client's Full Reset deletes the key.
    hub().writeRoomMetadata({ [STATE_KEY]: undefined });
    await settle();
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
    expect(room().rows).toEqual([]);
    expect(room().revision).toBe(11);
    expect(plain(p.state())).toEqual(plain(room()));

    const before = p.state();
    hub().writeRoomMetadata({ "other.ext/x": 1 });
    await settle();
    expect(p.state()).toBe(before);
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
  });
});

describe("echo and write edge cases", () => {
  const foreign = (revision: number, name: string) =>
    encodeEncounterState({
      ...seedState(revision),
      writerId: "other-gm",
      rows: seedState(revision).rows.map((r) => (r.id === "r2" ? { ...r, name } : r)),
    });

  it("echo arriving after setMetadata resolves: saved once, converged, ready", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();
    a.obr.setOwnEcho(200);

    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle(100); // written, echo not here yet
    expect(room().rows[0].onHold).toBe(true);
    expect(a.state().rows[0].onHold).toBe(true);
    await settle();

    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
    expect(plain(a.state())).toEqual(plain(room()));
    expect(a.engine.getSnapshot().status).toBe("ready");
  });

  it("echo that never arrives: the local change is kept after the timeout", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();
    a.obr.setOwnEcho("never");

    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();

    expect(a.state().rows[0].onHold).toBe(true);
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("echo that never arrives: a newer foreign state seen meanwhile is adopted after the timeout", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();
    a.obr.setOwnEcho("never");

    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle(100);
    hub().writeRoomMetadata({ [STATE_KEY]: foreign(50, "Foreign") });
    await settle();

    expect(room().writerId).toBe("other-gm");
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("echo before resolve, then a newer foreign write before resolve: the client adopts the foreign state", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();
    a.obr.room.setMetadata.mockImplementationOnce(async (patch) => {
      hub().writeRoomMetadata(patch);
      hub().writeRoomMetadata({ [STATE_KEY]: foreign(50, "Foreign") });
      await flushObr(); // both events are delivered before the write resolves
    });

    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle(30_000);

    expect(room()).toMatchObject({ revision: 50, writerId: "other-gm" });
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("retries a write that timed out", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    a.obr.failRoom("setMetadata", timeoutError());
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();

    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(2);
    expect(plain(room())).toEqual(plain(a.state()));
    expect(notifications(a, "ERROR")).toHaveLength(0);
    expect(a.engine.getSnapshot().status).toBe("ready");
  });

  it("a timed-out write that lands later is not reported as another GM's change", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    // The host applies the first attempt late; every attempt reports a timeout.
    a.obr.room.setMetadata.mockImplementationOnce((patch) => {
      setTimeout(() => hub().writeRoomMetadata(patch), 20_000);
      return Promise.reject(timeoutError());
    });
    a.obr.failRoom("setMetadata", timeoutError(), 3);
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle(15_000);
    expect(a.engine.getSnapshot().status).toBe("error");

    await settle(15_000);
    expect(room().writerId).toBe(a.writerId);
    expect(notifications(a, "WARNING")).toHaveLength(0);
    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(await a.engine.flush()).toBe(true);
  });

  it("a GM demoted to player stops writing", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    a.obr.setRole("PLAYER");
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();

    expect(a.obr.room.setMetadata).not.toHaveBeenCalled();
    expect(room().rows[0].onHold).toBe(false);
  });

  it("a GM demoted during write retries stops retrying", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    a.obr.failRoom("setMetadata", rateLimitError(), 2);
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle(100); // first attempt failed, waiting to retry
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
    a.obr.setRole("PLAYER");
    await settle();

    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
  });

  it("too-large is written as soon as another extension frees room space", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    hub().writeRoomMetadata({ "other.ext/data": "x".repeat(15800) });
    await settle();
    a.store.dispatch(createParticipant({ name: "Goblin", type: "NPC" }));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("too-large");

    hub().writeRoomMetadata({ "other.ext/data": undefined });
    await settle();

    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(room().rows.map((r) => r.name)).toContain("Goblin");
    expect(notifications(a, "WARNING")).toHaveLength(0);
  });
});

describe("flush result", () => {
  it("is true when the change was saved, or nothing was pending", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();
    expect(await a.engine.flush()).toBe(true);

    a.store.dispatch(setHold({ id: "r1", value: true }));
    expect(await a.engine.flush()).toBe(true);
    expect(room().rows[0].onHold).toBe(true);
  });

  it("is false when the write failed", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    a.obr.failRoom("setMetadata", new Error("boom"));
    a.store.dispatch(setHold({ id: "r1", value: true }));
    expect(await a.engine.flush()).toBe(false);
    expect(a.engine.getSnapshot().status).toBe("error");
  });

  it("is false when the state is too large", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();
    hub().writeRoomMetadata({ "other.ext/data": "x".repeat(15800) });
    await settle();

    a.store.dispatch(createParticipant({ name: "Goblin", type: "NPC" }));
    expect(await a.engine.flush()).toBe(false);
  });

  it("is false for a player with a local change", async () => {
    seedRoom(seedState(10));
    const p = another("PLAYER");
    await p.engine.start();
    await settle();

    p.store.dispatch(setHold({ id: "r1", value: true }));
    expect(await p.engine.flush()).toBe(false);
  });
});

describe("store.ts singleton", () => {
  it("startSync loads the room and flushSync resolves after the write", async () => {
    seedRoom(seedState(10));
    const { store, startSync, flushSync, syncEngine } = await import("./store");
    await startSync();
    await settle();
    expect(syncEngine.getSnapshot().status).toBe("ready");

    store.dispatch(setHold({ id: "r1", value: true }));
    expect(await flushSync()).toBe(true);
    expect(hub().activeClient.room.setMetadata).toHaveBeenCalledTimes(1);
    expect(room().rows[0].onHold).toBe(true);
    syncEngine.stop();
  });
});

describe("local changes are never lost to echoes (review 2)", () => {
  const nameOf = (s: EncounterState) => s.rows.find((r) => r.id === "r2")?.name;
  /** Another GM's rename of r2, derived (like our changes) from the seeded 10/seed. */
  const foreign = (revision: number, name: string) =>
    encodeEncounterState(
      {
        ...seedState(revision),
        writerId: "other-gm",
        rows: seedState(revision).rows.map((r) => (r.id === "r2" ? { ...r, name } : r)),
      },
      { revision: 10, writerId: "seed" }
    );

  async function loaded() {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();
    return a;
  }

  /** Every distinct r2 name the store shows, in order. */
  function trackNames(client: Client): string[] {
    const names: string[] = [];
    client.store.subscribe(() => {
      const name = nameOf(client.state());
      if (name !== undefined && names[names.length - 1] !== name) names.push(name);
    });
    return names;
  }

  it("R2-S1: a change made while a write is in flight survives that write's early echo", async () => {
    const a = await loaded();
    // The first write lands (and echoes) at once but resolves only after 200 ms.
    a.obr.room.setMetadata.mockImplementationOnce(async (patch) => {
      hub().writeRoomMetadata(patch);
      await new Promise((r) => setTimeout(r, 200));
    });

    a.store.dispatch(renameParticipant({ id: "r2", name: "first" }));
    await settle(60);
    a.store.dispatch(renameParticipant({ id: "r2", name: "second" }));
    await settle(60);
    await settle();

    expect(nameOf(a.state())).toBe("second");
    expect(nameOf(room())).toBe("second");
    expect(await a.engine.flush()).toBe(true);
  });

  it("R2-S2: a slow echo of an older own write never reverts the local state", async () => {
    const a = await loaded();
    a.obr.setOwnEcho(4000);
    const names = trackNames(a);

    a.store.dispatch(renameParticipant({ id: "r2", name: "first" }));
    await settle(100);
    a.store.dispatch(renameParticipant({ id: "r2", name: "second" }));
    await settle();

    expect(names).toEqual(["first", "second"]);
    expect(nameOf(room())).toBe("second");
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("an own echo that arrives while a newer change is being written does not revert it", async () => {
    const a = await loaded();
    a.obr.setOwnEcho(1000);
    const names = trackNames(a);

    a.store.dispatch(renameParticipant({ id: "r2", name: "first" }));
    await settle(100);
    const release = holdNextWrite(a);
    a.store.dispatch(renameParticipant({ id: "r2", name: "second" }));
    await settle(2000); // the echo of "first" arrives while "second" is in flight
    expect(nameOf(a.state())).toBe("second");
    release();
    await settle();

    expect(names).toEqual(["first", "second"]);
    expect(nameOf(room())).toBe("second");
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("a foreign write that lands while ours is in flight: ours is replayed on it, above its revision", async () => {
    seedRoom(seedState(10));
    const a = gm();
    const b = another("GM");
    const p = another("PLAYER");
    await Promise.all([a.engine.start(), b.engine.start(), p.engine.start()]);
    await settle();

    const release = holdNextWrite(a);
    a.store.dispatch(setHold({ id: "r1", value: true })); // rev 11, in flight
    await settle(100);
    hub().writeRoomMetadata({ [STATE_KEY]: foreign(50, "Foreign") });
    await settle(100);
    release(); // ours lands last
    await settle();

    expect(room().revision).toBeGreaterThan(50);
    expect(room().rows[0].onHold).toBe(true);
    expect(nameOf(room())).toBe("Foreign"); // the other change is kept
    for (const c of [a, b, p]) expect(plain(c.state())).toEqual(plain(room()));
  });
});

describe("replayed actions are deterministic (seeded shuffles)", () => {
  it("a deal replayed on another GM's state with the same deck deals the cards this GM saw", async () => {
    // One card left: the deal reshuffles the discard pile for the second row.
    const seeded = seedState(10);
    const [top, ...rest] = seeded.deck.remaining;
    const base: EncounterState = { ...seeded, phase: "between_rounds", round: 1, deck: { ...seeded.deck, remaining: [top], discard: rest } };
    seedRoom(base);
    const a = gm();
    const b = another("GM");
    await Promise.all([a.engine.start(), b.engine.start()]);
    await settle();

    const release = holdNextWrite(a);
    a.store.dispatch(dealRound()); // rev 11, in flight
    const seen = a.state();
    const cardsSeen = seen.rows.map((r) => [r.id, r.currentCardId]);
    await settle(100);
    // Another GM renamed r2 meanwhile, from the same base: the deck is unchanged.
    const renamed = { ...base, revision: 50, writerId: "other-gm", rows: base.rows.map((r) => (r.id === "r2" ? { ...r, name: "Foreign" } : r)) };
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState(renamed, { revision: 10, writerId: "seed" }) });
    await settle(100);
    release();
    await settle();

    expect(room().revision).toBeGreaterThan(50);
    expect(room().rows.find((r) => r.id === "r2")?.name).toBe("Foreign"); // the other change is kept
    expect(room().rows.map((r) => [r.id, r.currentCardId])).toEqual(cardsSeen);
    expect(room().deck).toEqual(seen.deck);
    for (const c of [a, b]) expect(plain(c.state())).toEqual(plain(room()));
  });
});

describe("review 4 regressions", () => {
  it("R4-S1: a timed-out own write that lands after our newer write is overwritten, even without the newer echo", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    let landLate = () => {};
    a.obr.room.setMetadata.mockImplementationOnce((patch) => {
      landLate = () => hub().writeRoomMetadata(patch); // the host applies it later
      return Promise.reject(timeoutError());
    });
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle(); // the retry of the same state is written and echoed
    expect(room().rows[0].onHold).toBe(true);

    a.obr.room.setMetadata.mockImplementationOnce(async (patch) => {
      hub().writeRoomMetadata(patch, a.obr); // lands; its echo is coalesced away
      landLate(); // then the timed-out first attempt lands, and only that value reaches us
      await flushObr();
    });
    a.store.dispatch(setHold({ id: "r2", value: true }));
    await settle();

    expect(room().rows.map((r) => r.onHold)).toEqual([true, true]);
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("R4: a late echo of our previous write during the next write causes no rewrite (no write loop)", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();
    a.obr.setOwnEcho(200); // echoes come 200 ms after each write resolves
    a.obr.setWriteDelay(300); // so the previous echo arrives while the next write is in flight

    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle(100);
    a.store.dispatch(setHold({ id: "r2", value: true }));
    await settle(); // 10 s

    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(2);
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("R4-S2: a GM demoted after a failed write follows the room with one warning", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    a.obr.failRoom("setMetadata", { error: { name: "Unknown" } });
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("error");

    a.obr.setRole("PLAYER");
    await settle();

    expect(plain(a.state())).toEqual(plain(room()));
    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(notifications(a, "WARNING")).toHaveLength(1);
  });

  it("R4-S2b: a player promoted to GM in a room without state creates one", async () => {
    resetObrMock({ id: "p", name: "P", role: "PLAYER" });
    const p = gm();
    await p.engine.start();
    await settle();
    expect(p.engine.getSnapshot().status).toBe("absent-player");

    p.obr.setRole("GM");
    await settle();

    expect(p.engine.getSnapshot().status).toBe("ready");
    expect(plain(room())).toEqual(plain(p.state()));
  });

  it("R4-S3: a too-new value that arrives during our write keeps the tracker read-only", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    a.obr.room.setMetadata.mockImplementationOnce(async (patch) => {
      hub().writeRoomMetadata(patch);
      await flushObr(); // our echo
      hub().writeRoomMetadata({ [STATE_KEY]: { ...(encodeEncounterState(seedState(50)) as object), version: 99 } });
      await flushObr(); // then a newer app version's state, before our write resolves
    });
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("too-new");

    a.store.dispatch(setHold({ id: "r2", value: true }));
    await settle();

    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
    expect((hub().roomMetadata[STATE_KEY] as { version: number }).version).toBe(99);
  });
});

describe("review 5 (adversarial)", () => {
  // Fixed: follow() warned "unsaved change was discarded" and called apply(), but apply()
  // keeps the local state for `invalid` / `too-new`. The local state stayed dirty, so
  // follow() returned early on every later room value. follow() now marks it `discarded`.
  it("a GM whose failed change met invalid room data adopts the valid state written later", async () => {
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    a.obr.failRoom("setMetadata", { error: { name: "Unknown" } });
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("error");

    seedRoom({ round: 1, phase: "in_round", deck: {}, rows: {} }); // invalid data in the room
    hub().writeRoomMetadata({ [STATE_KEY]: hub().roomMetadata[STATE_KEY] });
    await settle();
    expect(a.engine.getSnapshot().status).toBe("invalid");
    expect(notifications(a, "WARNING")).toHaveLength(1); // "your unsaved change was discarded"

    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState(seedState(60)) }); // another GM's reset
    await settle();

    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(plain(a.state())).toEqual(plain(room()));
  });
});

describe("review 6 (fuzz with invalid data and missing echoes)", () => {
  const INVALID = { round: 1, phase: "in_round", deck: {}, rows: {} };
  const unknownError = { error: { name: "Unknown" } };

  /** Keep the next write of `client` in flight; `land` writes it to the room (no echo to `client` when silent). */
  function holdWrite(client: Client) {
    const held = { land: (_silent = false) => {}, fail: () => {} };
    client.obr.room.setMetadata.mockImplementationOnce(
      (patch) =>
        new Promise<void>((resolve, reject) => {
          held.land = (silent = false) => {
            hub().writeRoomMetadata(patch, silent ? client.obr : undefined);
            resolve();
          };
          held.fail = () => reject(unknownError);
        })
    );
    return held;
  }

  it("a discarded change does not hide the echo of our earlier write: the GM adopts the room state", async () => {
    // Fuzz "everything" seed 510: the echo of our in-flight write was taken for an older echo
    // while our newer state was already given up, so the GM kept it and stayed `invalid`.
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    const write = holdWrite(a);
    a.store.dispatch(setHold({ id: "r1", value: true })); // 11/a, in flight
    await settle(100);
    a.store.dispatch(setHold({ id: "r2", value: true })); // 12/a, waits for the write loop
    a.obr.setRole("PLAYER");
    await settle(100);
    hub().writeRoomMetadata({ [STATE_KEY]: INVALID });
    await settle(100);
    expect(a.engine.getSnapshot().status).toBe("invalid");
    expect(notifications(a, "WARNING")).toHaveLength(1); // 12/a is given up

    a.obr.setRole("GM");
    await settle(100);
    write.land(); // 11/a lands after the invalid data, and its echo arrives
    await settle();

    expect(room().rows[0].onHold).toBe(true);
    expect(plain(a.state())).toEqual(plain(room()));
    expect(a.engine.getSnapshot().status).toBe("ready");
  });

  it("a new state that reuses the identity of a discarded change is still written", async () => {
    // Fuzz "role changes" seed 1140: the discarded change was never written, so a later state
    // can get the same (revision, writerId). It counted as saved and was never written.
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    const write = holdWrite(a);
    a.store.dispatch(setHold({ id: "r1", value: true })); // 11/a, in flight
    await settle(100);
    a.store.dispatch(setHold({ id: "r2", value: true })); // 12/a, never written
    a.obr.setRole("PLAYER");
    await settle(100);
    hub().writeRoomMetadata({ [STATE_KEY]: undefined }); // the key is deleted
    await settle(100);
    expect(notifications(a, "WARNING")).toHaveLength(1);
    write.fail();
    await settle();
    expect(a.engine.getSnapshot().status).toBe("absent-player");

    a.obr.setRole("GM"); // creates a fresh state: 12/a again
    await settle();

    expect(a.state().revision).toBe(12);
    expect(plain(room())).toEqual(plain(a.state()));
    expect(a.engine.getSnapshot().status).toBe("ready");
  });

  it("a GM reset of invalid data whose echo never arrives does not stay invalid", async () => {
    // Fuzz "everything" seed 2749.
    seedRoom(INVALID);
    const a = gm();
    await a.engine.start();
    await settle();
    expect(a.engine.getSnapshot().status).toBe("invalid");

    a.obr.setOwnEcho("never");
    a.store.dispatch(reset());
    await settle();

    expect(plain(room())).toEqual(plain(a.state()));
    expect(a.engine.getSnapshot().status).toBe("ready");
  });

  it("a GM demoted after a failed write reads the room: it may hold an earlier write whose echo never came", async () => {
    // Fuzz "everything" seed 5414 (8000 seeds).
    seedRoom(seedState(10));
    const a = gm();
    await a.engine.start();
    await settle();

    const write = holdWrite(a);
    a.store.dispatch(setHold({ id: "r1", value: true })); // 11/a, in flight
    await settle(100);
    // Another GM's concurrent change (derived from 10/seed, like ours).
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...seedState(11), writerId: "other" }, { revision: 10, writerId: "seed" }) });
    await settle(100);
    a.obr.failRoom("setMetadata", unknownError); // the rebased rewrite above the foreign state fails
    write.land(true); // 11/a lands last; its echo never arrives
    await settle();
    expect(a.engine.getSnapshot().status).toBe("error");

    a.obr.setRole("PLAYER");
    await settle();

    expect(room().writerId).toBe(a.writerId);
    expect(plain(a.state())).toEqual(plain(room()));
    expect(a.engine.getSnapshot().status).toBe("ready");
  });
});

describe("review 7 (key deletion by a released v1 GM)", () => {
  const names = (s: EncounterState) => s.rows.map((r) => r.name).sort();

  it("R7-2: a v1 state (revision 1, no parent) after a Full Reset does not get the pre-reset actions replayed", async () => {
    seedRoom({ ...initializeEmptyState(), revision: 1, writerId: "seed" });
    const a = gm();
    await a.engine.start();
    a.store.dispatch(createParticipant({ name: "OldA", type: "PC" }));
    await settle(100);
    a.store.dispatch(createParticipant({ name: "OldB", type: "NPC" }));
    await settle(100);
    expect(names(room())).toEqual(["OldA", "OldB"]);

    // v1 Full Reset deletes the key; our GM writes a fresh root.
    hub().writeRoomMetadata({ [STATE_KEY]: undefined });
    await settle(100);
    expect(room().rows).toEqual([]);
    // The v1 GM read the key as absent before our root landed, then adds a row (revision 1, v1 format).
    const v1 = createAppStore({ writerId: "x", getMinRevision: () => 0 });
    v1.dispatch(setEncounterState(initializeEmptyState()));
    v1.dispatch(createParticipant({ name: "V", type: "PC" }));
    const raw = { ...encodeEncounterState({ ...v1.getState().swade, revision: 1, writerId: "" }), version: 1 } as Record<string, unknown>;
    delete raw.writerId;
    hub().writeRoomMetadata({ [STATE_KEY]: raw });
    await settle();

    expect(names(room())).toEqual(["V"]);
    expect(names(a.state())).toEqual(["V"]);
    // Only the notice that an older app wrote (no replay warning).
    expect(a.obr.state.notifications.map((n) => n.message)).toEqual([expect.stringContaining("older version")]);
  });

  it("R7-3: a Full Reset (key deleted) during our debounce keeps the reset; our unsaved change goes onto the fresh state", async () => {
    seedRoom({ ...initializeEmptyState(), revision: 1, writerId: "seed" });
    const a = gm();
    await a.engine.start();
    a.store.dispatch(createParticipant({ name: "OldA", type: "PC" }));
    await settle(100);
    a.store.dispatch(createParticipant({ name: "New", type: "PC" }));
    hub().writeRoomMetadata({ [STATE_KEY]: undefined }); // within the 50 ms debounce
    await settle();

    expect(names(room())).toEqual(["New"]);
    expect(names(a.state())).toEqual(["New"]);
    expect(room().deck.remaining).toHaveLength(54);
  });
});

describe("audit 2026-11 (R3-X4, R4-S5, R6 note 4)", () => {
  const INVALID = { round: 1, phase: "in_round", deck: {}, rows: {} };
  const TOO_NEW = () => ({ ...(encodeEncounterState(seedState(50)) as object), version: 99 });
  const unknownError = { error: { name: "Unknown" } };
  const discardWarnings = (client: Client) => notifications(client, "WARNING").filter((n) => n.message.includes("discarded"));
  const roomVersion = () => (hub().roomMetadata[STATE_KEY] as { version: number }).version;

  async function loadedGm(revision = 10) {
    seedRoom(seedState(revision));
    const a = gm();
    await a.engine.start();
    await settle();
    return a;
  }

  /** Keep the next write of `a` in flight: `land(silent)` writes it to the room (no echo to `a` when silent), `resolve()` ends it. */
  function holdWrite(a: Client) {
    const held = { land: (_silent = false) => {}, resolve: () => {} };
    a.obr.room.setMetadata.mockImplementationOnce(
      (patch) =>
        new Promise<void>((resolve) => {
          held.land = (silent = false) => hub().writeRoomMetadata(patch, silent ? a.obr : undefined);
          held.resolve = resolve;
        })
    );
    return held;
  }

  it("R3-X4: a too-new value that lands during the debounce is not overwritten; the GM is told the change was discarded", async () => {
    const a = await loadedGm();
    a.store.dispatch(setHold({ id: "r1", value: true })); // debounced
    hub().writeRoomMetadata({ [STATE_KEY]: TOO_NEW() });
    await settle();

    expect(a.engine.getSnapshot().status).toBe("too-new");
    expect(a.obr.room.setMetadata).not.toHaveBeenCalled();
    expect(roomVersion()).toBe(99);
    expect(discardWarnings(a)).toHaveLength(1);
  });

  it("R4-S6: invalid data that lands during the debounce is not overwritten; a GM reset then writes", async () => {
    const a = await loadedGm();
    a.store.dispatch(setHold({ id: "r1", value: true })); // debounced
    hub().writeRoomMetadata({ [STATE_KEY]: INVALID });
    await settle();

    expect(a.engine.getSnapshot().status).toBe("invalid");
    expect(a.obr.room.setMetadata).not.toHaveBeenCalled();
    expect(hub().roomMetadata[STATE_KEY]).toEqual(INVALID);
    expect(discardWarnings(a)).toHaveLength(1);

    a.store.dispatch(reset()); // the gate's "Reset tracker"
    await settle();
    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(room().rows).toEqual([]);
  });

  it("R4-S6: invalid data that lands after our write but before its echo: the change is not written again", async () => {
    const a = await loadedGm();
    const write = holdWrite(a);
    a.store.dispatch(setHold({ id: "r1", value: true })); // 11/a in flight
    await settle(100);
    a.store.dispatch(setHold({ id: "r2", value: true })); // 12/a waits for the write loop
    write.land(true); // 11/a lands, its echo never arrives
    hub().writeRoomMetadata({ [STATE_KEY]: INVALID }); // then invalid data
    await settle(100);
    write.resolve();
    await settle();

    expect(a.engine.getSnapshot().status).toBe("invalid");
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
    expect(hub().roomMetadata[STATE_KEY]).toEqual(INVALID);
    expect(discardWarnings(a)).toHaveLength(1);
  });

  it("R4-S6: invalid data that lands before our in-flight write: the echo shows our write won, with no warning", async () => {
    const a = await loadedGm();
    const write = holdWrite(a);
    a.store.dispatch(setHold({ id: "r1", value: true })); // 11/a in flight
    await settle(100);
    hub().writeRoomMetadata({ [STATE_KEY]: INVALID });
    await settle(100);
    expect(a.engine.getSnapshot().status).toBe("invalid");
    write.land(); // our write lands last and echoes
    write.resolve();
    await settle();

    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(room().rows[0].onHold).toBe(true);
    expect(plain(a.state())).toEqual(plain(room()));
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
    expect(discardWarnings(a)).toEqual([]);
  });

  it("R4-S6: a too-new value before our in-flight write's resolve, no echo: one warning, no rewrite", async () => {
    const a = await loadedGm();
    const write = holdWrite(a);
    a.store.dispatch(setHold({ id: "r1", value: true })); // 11/a in flight
    await settle(100);
    hub().writeRoomMetadata({ [STATE_KEY]: TOO_NEW() });
    await settle(100);
    write.land(true); // order unknown to `a`: no echo
    hub().writeRoomMetadata({ [STATE_KEY]: TOO_NEW() }); // the newer client writes again
    await settle(100);
    write.resolve();
    await settle();

    expect(a.engine.getSnapshot().status).toBe("too-new");
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
    expect(discardWarnings(a)).toHaveLength(1);
  });

  it("R4-S6: too-new during our write, then a key deletion: the write ends without its echo, so the GM is warned (fuzz seed 1796)", async () => {
    const a = await loadedGm();
    const write = holdWrite(a);
    a.store.dispatch(setHold({ id: "r1", value: true })); // 11/a in flight
    await settle(100);
    hub().writeRoomMetadata({ [STATE_KEY]: TOO_NEW() });
    await settle(100);
    hub().writeRoomMetadata({ [STATE_KEY]: undefined }); // the GM then writes a fresh state
    await settle(100);
    expect(discardWarnings(a)).toEqual([]);
    write.land(true);
    write.resolve();
    await settle();

    expect(discardWarnings(a)).toHaveLength(1);
    expect(plain(a.state())).toEqual(plain(room()));
    expect(room().rows).toEqual([]);
  });

  it("a GM left in error with no user action keeps the status, the change and the one error; retry then saves it", async () => {
    const a = await loadedGm();
    a.obr.failRoom("setMetadata", unknownError);
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("error");

    hub().writeRoomMetadata({ "other.ext/key": 1 }); // unrelated events change nothing
    await settle(600_000);
    a.wake(); // a wake read of the unchanged room changes nothing either
    await settle();

    expect(a.engine.getSnapshot().status).toBe("error");
    expect(a.state().rows[0].onHold).toBe(true);
    expect(room().rows[0].onHold).toBe(false);
    expect(notifications(a, "ERROR")).toHaveLength(1);
    expect(notifications(a, "WARNING")).toEqual([]);
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);

    await a.engine.retry();
    await settle();
    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(room().rows[0].onHold).toBe(true);
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("R6 note 4: actions given up with the discard warning are never replayed by a later rebase", async () => {
    const a = await loadedGm();
    a.obr.failRoom("setMetadata", unknownError, 2);
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    a.store.dispatch(renameParticipant({ id: "r1", name: "Discarded" }));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("error");

    hub().writeRoomMetadata({ [STATE_KEY]: undefined }); // a Full Reset: the unsaved change is given up
    await settle();
    expect(discardWarnings(a)).toHaveLength(1);
    expect(room().rows).toEqual([]); // the fresh state

    // A GM that missed the deletion writes a state derived from the old room state.
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...seedState(11), writerId: "other" }, { revision: 10, writerId: "seed" }) });
    await settle();

    expect(room().writerId).toBe("other");
    expect(room().rows.map((r) => r.name)).toEqual(["Hero", "Orc"]);
    expect(room().rows[0].onHold).toBe(false);
    expect(plain(a.state())).toEqual(plain(room()));
    expect(discardWarnings(a)).toHaveLength(1);
  });

  it("R4-S5: a dropped room event is recovered when the iframe becomes visible again", async () => {
    const a = await loadedGm();
    const player = another("PLAYER");
    await player.engine.start();
    await settle();
    player.obr.dropRoomEvents(1);
    a.obr.dropRoomEvents(0);
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    expect(room().rows[0].onHold).toBe(true);
    expect(player.state().rows[0].onHold).toBe(false); // stale: the event never came

    player.wake();
    player.wake(); // focus and visibilitychange together: one read
    await settle();
    expect(player.state().rows[0].onHold).toBe(true);
    expect(player.obr.room.getMetadata).toHaveBeenCalledTimes(2); // initial load + one wake read
  });

  it("R4-S5: a GM with saved actions that missed several states follows the room on wake", async () => {
    const a = await loadedGm();
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    a.obr.dropRoomEvents(2);
    // Another GM writes twice; `a` gets neither event (the first one names a parent `a` never saw).
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...room(), revision: 20, writerId: "other", rows: room().rows.map((r) => ({ ...r, name: `${r.name}!` })) }, { revision: 11, writerId: a.writerId }) });
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...room(), revision: 21, writerId: "other" }, { revision: 20, writerId: "other" }) });
    await settle();
    expect(a.state().revision).toBe(11);

    a.wake();
    await settle();
    expect(plain(a.state())).toEqual(plain(room()));
    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
  });

  it("R4-S5: after a write whose echo never arrives the engine reads the room once and finds a missed state", async () => {
    const a = await loadedGm();
    a.obr.setOwnEcho("never");
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle(100);
    const reads = a.obr.room.getMetadata.mock.calls.length;
    a.obr.dropRoomEvents(1);
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...room(), revision: 30, writerId: "other", rows: [] }, { revision: 11, writerId: a.writerId }) });
    await settle(ECHO_WAIT_MS + 100);

    expect(a.obr.room.getMetadata.mock.calls.length).toBe(reads + 1);
    expect(plain(a.state())).toEqual(plain(room()));
    expect(a.state().rows).toEqual([]);
    await settle(60_000);
    expect(a.obr.room.getMetadata.mock.calls.length).toBe(reads + 1); // no polling
  });

  it("no extra read when the echo arrives", async () => {
    const a = await loadedGm();
    a.obr.setOwnEcho(1000); // late, but within the wait
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle(60_000);
    expect(a.obr.room.getMetadata).toHaveBeenCalledTimes(1);
  });
});

describe("N1: a wake read of a state with unknown lineage (missed events)", () => {
  const replaced = (client: Client) => notifications(client, "WARNING").filter((n) => n.message.includes("may have replaced"));

  async function loadedGm(state: EncounterState = seedState(10)) {
    seedRoom(state);
    const a = gm();
    await a.engine.start();
    await settle();
    return a;
  }

  /**
   * Another GM writes one state per edit (each from the current room value, the first naming
   * `firstParent`); `a` misses every event.
   */
  async function missStates(a: Client, firstParent: { revision: number; writerId: string }, edits: ((s: EncounterState) => EncounterState)[]) {
    a.obr.dropRoomEvents(edits.length);
    let parent = firstParent;
    edits.forEach((edit, i) => {
      const revision = 20 + i;
      hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...edit(room()), revision, writerId: "other" }, parent, CLIENT) });
      parent = { revision, writerId: "other" };
    });
    await settle();
  }

  const rename = (s: EncounterState) => ({ ...s, rows: s.rows.map((r) => ({ ...r, name: `${r.name}!` })) });
  const ghost = { revision: 15, writerId: "ghost" }; // a state `a` never saw

  it.each([2, 3])("%i missed states built on our saved write: no warning, converged, the log is kept", async (missed) => {
    const a = await loadedGm();
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    await missStates(a, { revision: 11, writerId: a.writerId }, Array.from({ length: missed }, () => rename));
    expect(a.state().revision).toBe(11);

    a.wake();
    await settle();
    expect(plain(a.state())).toEqual(plain(room()));
    expect(a.state().rows[0]).toMatchObject({ onHold: true, name: missed === 2 ? "Hero!!" : "Hero!!!" });
    expect(notifications(a, "WARNING")).toEqual([]);
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);

    // The log was kept: a later state of unknown lineage without the hold is still noticed.
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...seedState(40), writerId: "other" }, { revision: 39, writerId: "ghost" }, CLIENT) });
    await settle();
    expect(replaced(a)).toHaveLength(1);
  });

  it("a state built on ours is known again afterwards: its children are followed without a check", async () => {
    const a = await loadedGm();
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    await missStates(a, { revision: 11, writerId: a.writerId }, [rename, rename]);
    a.wake();
    await settle();
    // A child of the adopted state that lacks the hold: another GM cleared it on purpose.
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...room(), revision: 22, writerId: "other", rows: room().rows.map((r) => ({ ...r, onHold: false })) }, { revision: 21, writerId: "other" }, CLIENT) });
    await settle();
    expect(a.state().rows[0].onHold).toBe(false);
    expect(notifications(a, "WARNING")).toEqual([]);
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
  });

  it("another GM really overwrote our saved new row: not re-applied, one warning, the room is followed", async () => {
    const a = await loadedGm();
    a.store.dispatch(createParticipant({ name: "Mine", type: "NPC" }));
    await settle();
    await missStates(a, ghost, [() => rename(seedState(10)), rename]);

    a.wake();
    await settle();
    expect(room().rows.map((r) => r.name).sort()).toEqual(["Hero!!", "Orc!!"]);
    expect(plain(a.state())).toEqual(plain(room()));
    expect(replaced(a)).toHaveLength(1);
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
  });

  it("a row we added that another GM removed later is not brought back (no resurrection)", async () => {
    const a = await loadedGm();
    a.store.dispatch(createParticipant({ name: "Mine", type: "NPC" }));
    await settle();
    const mine = a.state().rows.find((r) => r.name === "Mine")!.id;
    // Built on our write: the first state removes our row, the second renames.
    await missStates(a, { revision: 11, writerId: a.writerId }, [(s) => swadeSlice.reducer(s, removeParticipant(mine)), rename]);

    a.wake();
    await settle();
    await settle(60_000);
    expect(room().rows.some((r) => r.id === mine)).toBe(false);
    expect(room().writerId).toBe("other");
    expect(plain(a.state())).toEqual(plain(room()));
    expect(replaced(a)).toHaveLength(1);
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
  });

  it("another GM overwrote our saved hold: one warning, the room is followed, nothing written", async () => {
    const a = await loadedGm();
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    await missStates(a, ghost, [() => rename(seedState(10)), rename]);

    a.wake();
    await settle();
    expect(plain(a.state())).toEqual(plain(room()));
    expect(room().rows[0].onHold).toBe(false);
    expect(replaced(a)).toHaveLength(1);
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
  });

  it("an unsaved change on top of saved ones that are present: replayed and written, no warning", async () => {
    const a = await loadedGm();
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    await missStates(a, { revision: 11, writerId: a.writerId }, [rename, rename]);
    a.store.dispatch(renameParticipant({ id: "r2", name: "Goblin" })); // unsent: in the debounce
    a.wake();
    await settle();
    expect(room().rows.find((r) => r.id === "r2")!.name).toBe("Goblin");
    expect(room().rows[0]).toMatchObject({ name: "Hero!!", onHold: true });
    expect(plain(a.state())).toEqual(plain(room()));
    expect(notifications(a, "WARNING")).toEqual([]);
  });

  describe("no double application of Next or a deal", () => {
    const inRound = () => {
      let s = seedState(10);
      s = swadeSlice.reducer(s, dealRound(1));
      s = swadeSlice.reducer(s, startRound());
      return { ...s, revision: 10, writerId: "seed" };
    };

    it("Next is already in the room: no warning, the turn stays", async () => {
      const a = await loadedGm(inRound());
      const second = a.state().rows[1].id;
      a.store.dispatch(setActiveParticipant(second));
      await settle();
      await missStates(a, { revision: 11, writerId: a.writerId }, [rename, rename]);
      a.wake();
      await settle();
      expect(a.state().turn.activeRowId).toBe(second);
      expect(plain(a.state())).toEqual(plain(room()));
      expect(notifications(a, "WARNING")).toEqual([]);
      expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
    });

    it("the turn moved on past our Next, unknown lineage: not moved back, no warning", async () => {
      const a = await loadedGm(inRound());
      const second = a.state().rows[1].id;
      a.store.dispatch(setActiveParticipant(second));
      await settle();
      await missStates(a, { revision: 11, writerId: a.writerId }, [(s) => swadeSlice.reducer(s, setActiveParticipant(null)), rename]);
      a.wake();
      await settle();
      expect(room().turn.activeRowId).toBeNull();
      expect(plain(a.state())).toEqual(plain(room()));
      expect(notifications(a, "WARNING")).toEqual([]);
      expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
    });

    it("our two saved Nexts, the state holds the second, unknown lineage: nothing re-applied, no warning", async () => {
      const a = await loadedGm(inRound());
      const [, second] = a.state().rows.map((r) => r.id);
      a.store.dispatch(setActiveParticipant(second));
      await settle();
      a.store.dispatch(setActiveParticipant(null));
      await settle();
      await missStates(a, { revision: 12, writerId: a.writerId }, [rename, rename]);
      a.wake();
      await settle();
      expect(room().turn.activeRowId).toBeNull();
      expect(plain(a.state())).toEqual(plain(room()));
      expect(notifications(a, "WARNING")).toEqual([]);
      expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(2);
    });

    it("another GM's Next then Previous back to our Next's start, unknown lineage: our saved Next is not re-applied, no warning", async () => {
      const a = await loadedGm(inRound());
      const [first, second] = a.state().rows.map((r) => r.id);
      a.store.dispatch(setActiveParticipant(second));
      await settle();
      // Another GM pressed Next again (from a state `a` never saw), then Previous to the first row.
      await missStates(a, ghost, [(s) => swadeSlice.reducer(s, setActiveParticipant(null)), (s) => swadeSlice.reducer(s, setActiveParticipant(first))]);
      a.wake();
      await settle(60_000);
      expect(room().turn.activeRowId).toBe(first);
      expect(plain(a.state())).toEqual(plain(room()));
      // A saved turn navigation on unknown lineage is dropped silently (it may be in the state).
      expect(notifications(a, "WARNING")).toEqual([]);
      expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
    });

    it("a saved content change that is undone still warns, also next to a saved Next", async () => {
      const a = await loadedGm(inRound());
      const second = a.state().rows[1].id;
      a.store.dispatch(setActiveParticipant(second));
      await settle(100);
      a.store.dispatch(setHold({ id: "r1", value: true }));
      await settle();
      // From a state `a` never saw: the turn moved on and our hold is not there.
      await missStates(a, ghost, [() => swadeSlice.reducer(inRound(), setActiveParticipant(null)), rename]);
      a.wake();
      await settle();
      expect(room().rows[0].onHold).toBe(false);
      expect(plain(a.state())).toEqual(plain(room()));
      expect(replaced(a)).toHaveLength(1);
      expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(2);
    });

    it("an unsaved Next on a state of unknown lineage where the turn moved is dropped silently; an unsaved rename is still written", async () => {
      const a = await loadedGm(inRound());
      const second = a.state().rows[1].id;
      await missStates(a, { revision: 10, writerId: "seed" }, [(s) => swadeSlice.reducer(s, setActiveParticipant(null)), rename]);
      a.store.dispatch(setActiveParticipant(second)); // unsent: in the debounce
      a.store.dispatch(renameParticipant({ id: "r2", name: "Goblin" }));
      a.wake();
      await settle();
      expect(room().turn.activeRowId).toBeNull();
      expect(room().rows.find((r) => r.id === "r2")!.name).toBe("Goblin");
      expect(plain(a.state())).toEqual(plain(room()));
      expect(notifications(a, "WARNING")).toEqual([]);
    });
  });

  describe("known lineage: concurrent turn navigation", () => {
    const inRound = () => {
      let s = seedState(10);
      s.rows.push({ id: "r3", name: "Elf", type: "PC", inactive: false, onHold: false, revealed: true, candidateIds: [] });
      s = swadeSlice.reducer(s, dealRound(1));
      s = swadeSlice.reducer(s, startRound());
      return { ...s, revision: 10, writerId: "seed" };
    };

    it("our Next, then another GM's two Nexts from the state before it: the turn moved, so ours is dropped silently", async () => {
      const a = await loadedGm(inRound());
      const order = a.state().rows.map((r) => r.id);
      const base = room();
      a.store.dispatch(setActiveParticipant(order[1]));
      await settle();
      expect(room().turn.activeRowId).toBe(order[1]);
      // Another GM, from the state before our Next (known parent), presses Next twice within
      // its debounce: one write.
      const twice = swadeSlice.reducer(swadeSlice.reducer(base, setActiveParticipant(order[1])), setActiveParticipant(order[2]));
      hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...twice, revision: 20, writerId: "other" }, { revision: 10, writerId: "seed" }, CLIENT) });
      await settle(60_000);
      expect(room().turn.activeRowId).toBe(order[2]);
      expect(room().writerId).toBe("other");
      expect(plain(a.state())).toEqual(plain(room()));
      expect(notifications(a, "WARNING")).toEqual([]);
      expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
    });

    it("our Next and another GM's concurrent rename: the turn did not move there, so our Next applies; both kept", async () => {
      const a = await loadedGm(inRound());
      const order = a.state().rows.map((r) => r.id);
      const base = room();
      a.obr.setOwnEcho("never");
      const release = holdNextWrite(a);
      a.store.dispatch(setActiveParticipant(order[1]));
      await settle(100);
      hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...rename(base), revision: 20, writerId: "other" }, { revision: 10, writerId: "seed" }, CLIENT) });
      release();
      await settle(60_000);
      expect(room().turn.activeRowId).toBe(order[1]);
      expect(room().rows[0].name.endsWith("!")).toBe(true);
      expect(plain(a.state())).toEqual(plain(room()));
      expect(notifications(a, "WARNING")).toEqual([]);
    });

    it("the round of our deal ended: no second deal (warning instead)", async () => {
      const a = await loadedGm();
      a.store.dispatch(dealRound(7));
      await settle();
      expect(room().round).toBe(1);
      await missStates(a, { revision: 11, writerId: a.writerId }, [
        (s) => swadeSlice.reducer(s, startRound()),
        (s) => swadeSlice.reducer(s, endRound(3)),
      ]);
      a.wake();
      await settle();
      expect(room()).toMatchObject({ round: 1, phase: "between_rounds" });
      expect(plain(a.state())).toEqual(plain(room()));
      expect(replaced(a)).toHaveLength(1);
      expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
    });

    it("our deal is in the room (round running): no second deal, no warning", async () => {
      const a = await loadedGm();
      a.store.dispatch(dealRound(7));
      await settle();
      await missStates(a, { revision: 11, writerId: a.writerId }, [(s) => swadeSlice.reducer(s, startRound()), rename]);
      a.wake();
      await settle();
      expect(room()).toMatchObject({ round: 1, phase: "in_round" });
      expect(plain(a.state())).toEqual(plain(room()));
      expect(notifications(a, "WARNING")).toEqual([]);
    });
  });
});

describe("mixed app versions (client: appVersion + syncProtocol)", () => {
  const older = (client: Client) => notifications(client, "WARNING").filter((n) => n.message.includes("older version"));

  const rename = (s: EncounterState) => ({ ...s, rows: s.rows.map((r) => ({ ...r, name: `${r.name}!` })) });

  async function loaded(state: EncounterState | Record<string, unknown> = seedState(10), role: "GM" | "PLAYER" = "GM") {
    if ("client" in state) hub().roomMetadata = { ...hub().roomMetadata, [STATE_KEY]: state };
    else seedRoom(state);
    const a = role === "GM" ? gm() : another("PLAYER");
    await a.engine.start();
    await settle();
    return a;
  }

  it("every write stores this app's version and sync protocol", async () => {
    const a = await loaded();
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    const stored = hub().roomMetadata[STATE_KEY] as Record<string, unknown>;
    expect(stored.client).toEqual({ syncProtocol: SYNC_PROTOCOL, appVersion: APP_VERSION, of: `11/${a.writerId}` });
    const parsed = parseEncounterState(stored);
    expect(parsed.kind === "ok" && parsed.client).toEqual(CLIENT);
  });

  it("a state of a higher sync protocol at load is too-new: not adopted, not written", async () => {
    const newer = encodeEncounterState({ ...seedState(10), writerId: "next" }, { revision: 9, writerId: "next" }, { syncProtocol: SYNC_PROTOCOL + 1, appVersion: "9.0.0" });
    const a = await loaded(newer);
    expect(a.engine.getSnapshot()).toMatchObject({ status: "too-new", loaded: true });
    expect(a.state().rows).toEqual([]);
    a.store.dispatch(setPrivacy(false));
    await settle();
    expect(a.obr.room.setMetadata).not.toHaveBeenCalled();
  });

  it("a higher protocol state that arrives over an unsaved change: not overwritten, change discarded, too-new", async () => {
    const a = await loaded();
    a.store.dispatch(setHold({ id: "r1", value: true })); // in the debounce
    const newer = { ...seedState(30), writerId: "next" };
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState(newer, { revision: 10, writerId: "seed" }, { syncProtocol: SYNC_PROTOCOL + 1 }) });
    await settle();
    expect(a.engine.getSnapshot().status).toBe("too-new");
    expect(a.obr.room.setMetadata).not.toHaveBeenCalled();
    expect(room().writerId).toBe("next");
    expect(notifications(a, "WARNING").map((n) => n.message)).toEqual([expect.stringContaining("unsaved change was discarded")]);
  });

  it("the same protocol with another app version changes nothing", async () => {
    const a = await loaded();
    const other = { ...rename(seedState(20)), writerId: "other" };
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState(other, { revision: 10, writerId: "seed" }, { syncProtocol: SYNC_PROTOCOL, appVersion: "0.9.9" }) });
    await settle();
    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(plain(a.state())).toEqual(plain(room()));
    expect(a.obr.state.notifications).toEqual([]);
  });

  it("an older app writes after protocol-aware states: the GM is told once", async () => {
    const a = await loaded(); // the seed has no client: no notice
    expect(a.obr.state.notifications).toEqual([]);
    a.store.dispatch(setHold({ id: "r1", value: true }));
    await settle();
    // An older app copies the room value (keys it does not know included) and changes it.
    const copied = { ...(hub().roomMetadata[STATE_KEY] as Record<string, unknown>), revision: 12, writerId: "old" };
    hub().writeRoomMetadata({ [STATE_KEY]: copied });
    await settle();
    expect(older(a)).toHaveLength(1);
    hub().writeRoomMetadata({ [STATE_KEY]: { ...copied, revision: 13 } });
    await settle();
    expect(older(a)).toHaveLength(1);
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("players are not told about an older app", async () => {
    const p = await loaded(encodeEncounterState(seedState(10), null, CLIENT), "PLAYER");
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...seedState(11), writerId: "old" }) });
    await settle();
    expect(p.state().revision).toBe(11);
    expect(p.obr.state.notifications).toEqual([]);
  });

  it("a wake read of a higher protocol state shows too-new", async () => {
    const a = await loaded();
    a.obr.dropRoomEvents(1);
    hub().writeRoomMetadata({ [STATE_KEY]: encodeEncounterState({ ...seedState(30), writerId: "next" }, { revision: 29, writerId: "next" }, { syncProtocol: SYNC_PROTOCOL + 1 }) });
    await settle();
    expect(a.engine.getSnapshot().status).toBe("ready");
    a.wake();
    await settle();
    expect(a.engine.getSnapshot().status).toBe("too-new");
  });
});

describe("turn navigation: replayed only on the turn position it was made on", () => {
  const inRound = () => {
    let s = seedState(10);
    s.rows.push({ id: "r3", name: "Elf", type: "PC", inactive: false, onHold: false, revealed: true, candidateIds: [] });
    s = swadeSlice.reducer(s, dealRound(1));
    s = swadeSlice.reducer(s, startRound());
    return { ...s, revision: 10, writerId: "seed" };
  };
  const write = (s: EncounterState, parent?: { revision: number; writerId: string }) =>
    hub().writeRoomMetadata({ [STATE_KEY]: parent ? encodeEncounterState(s, parent, CLIENT) : encodeEncounterState(s) });
  const rename = (s: EncounterState) => ({ ...s, rows: s.rows.map((r) => ({ ...r, name: `${r.name}!` })) });
  const replaced = (client: Client) => notifications(client, "WARNING").filter((n) => n.message.includes("may have replaced"));

  async function loaded(state: EncounterState = inRound()) {
    seedRoom(state);
    const a = gm();
    await a.engine.start();
    await settle();
    return { a, order: a.state().rows.map((r) => r.id) };
  }

  it("two GMs press Next on the same turn at the same time: one wins, no warning, the turn advances once", async () => {
    seedRoom(inRound());
    const a = gm();
    const b = another("GM");
    await a.engine.start();
    await b.engine.start();
    await settle();
    const order = a.state().rows.map((r) => r.id);
    const releaseA = holdNextWrite(a);
    const releaseB = holdNextWrite(b);
    a.store.dispatch(setActiveParticipant(order[1]));
    b.store.dispatch(setActiveParticipant(order[1]));
    await settle(100);
    releaseB();
    await settle(100);
    releaseA();
    await settle(60_000);
    expect(room().turn.activeRowId).toBe(order[1]);
    for (const client of [a, b]) {
      expect(notifications(client, "WARNING")).toEqual([]);
      expect(plain(client.state())).toEqual(plain(room()));
    }
  });

  it("our Next, another GM's Previous on it, then a late state of unknown lineage: our Next is not applied again", async () => {
    const { a, order } = await loaded();
    a.store.dispatch(setActiveParticipant(order[1]));
    await settle();
    expect(room().turn.activeRowId).toBe(order[1]);
    // Another GM presses Previous on our state (known lineage): the turn is back on our Next's start.
    write({ ...swadeSlice.reducer(room(), setActiveParticipant(order[0])), revision: 12, writerId: "other" }, { revision: 11, writerId: a.writerId });
    await settle();
    expect(a.state().turn.activeRowId).toBe(order[0]);
    // A state `a` cannot place (parent never seen) on the same position.
    a.obr.dropRoomEvents(1);
    write({ ...rename(room()), revision: 30, writerId: "other" }, { revision: 25, writerId: "ghost" });
    await settle();
    a.wake();
    await settle(60_000);
    expect(room().turn.activeRowId).toBe(order[0]);
    expect(room().writerId).toBe("other");
    expect(plain(a.state())).toEqual(plain(room()));
    expect(notifications(a, "WARNING")).toEqual([]);
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(1);
  });

  it("an older app overwrites our saved Next (no stored parent): dropped silently, the room is followed", async () => {
    const { a, order } = await loaded();
    a.store.dispatch(renameParticipant({ id: "r2", name: "Goblin" }));
    await settle();
    const at11 = hub().roomMetadata[STATE_KEY] as Record<string, unknown>;
    a.store.dispatch(setActiveParticipant(order[1]));
    await settle();
    expect(room().turn.activeRowId).toBe(order[1]);
    const old = JSON.parse(JSON.stringify(at11));
    old.revision = 12;
    old.writerId = "old";
    old.rows.find((r: { id: string }) => r.id === "r1").name = "Hero (old)";
    hub().writeRoomMetadata({ [STATE_KEY]: old });
    await settle(60_000);
    expect(room().turn.activeRowId).toBe(order[0]);
    // Only the older-version notice: nothing about the Next.
    expect(notifications(a, "WARNING").map((n) => n.message)).toEqual([expect.stringContaining("older version")]);
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("a late write from an older state takes the turn back: our Next (made elsewhere) is dropped, the other GM's is replayed, no warning", async () => {
    const seed = inRound();
    seedRoom(seed);
    const a = gm();
    const c = another("GM");
    await a.engine.start();
    await c.engine.start();
    await settle();
    const order = a.state().rows.map((r) => r.id);
    c.store.dispatch(setActiveParticipant(order[1]));
    await settle();
    a.store.dispatch(setActiveParticipant(order[2])); // made on C's state
    await settle();
    expect(room().turn.activeRowId).toBe(order[2]);
    const late = { ...seed, rows: seed.rows.map((r) => (r.id === "r1" ? { ...r, name: "Hero (late)" } : r)), revision: 11, writerId: "late" };
    write(late, { revision: 10, writerId: "seed" });
    await settle(60_000);
    expect(room().rows.find((r) => r.id === "r1")?.name).toBe("Hero (late)");
    expect(room().turn.activeRowId).toBe(order[1]);
    for (const client of [a, c]) {
      expect(notifications(client, "WARNING")).toEqual([]);
      expect(plain(client.state())).toEqual(plain(room()));
    }
  });

  for (const missed of [true, false]) {
    it(`a later saved no-op (rename of a row another GM removed) still warns as content; the Next follows the rule (events missed: ${missed})`, async () => {
      const seed = inRound();
      const { a, order } = await loaded(seed);
      a.store.dispatch(setActiveParticipant(order[1]));
      await settle();
      a.store.dispatch(renameParticipant({ id: order[2], name: "Renamed" }));
      await settle();
      if (missed) a.obr.dropRoomEvents(2);
      const c = { ...seed, settings: { ...seed.settings, hideNpcFromPlayers: !seed.settings.hideNpcFromPlayers }, revision: 11, writerId: "C" };
      write(c, { revision: 10, writerId: "seed" });
      const b = { ...c, rows: c.rows.filter((r) => r.id !== order[2]), revision: 12, writerId: "B" };
      write(b, { revision: 11, writerId: "C" });
      if (missed) a.wake();
      await settle(60_000);
      // Known lineage: the Next is replayed (the turn did not move there). Unknown: the rename of
      // a removed row is no evidence that the state holds it: warned.
      if (missed) expect(replaced(a)).toHaveLength(1);
      else {
        expect(room().turn.activeRowId).toBe(order[1]);
        expect(notifications(a, "WARNING")).toEqual([]);
      }
      expect(plain(a.state())).toEqual(plain(room()));
    });
  }

  it("a saved rename of a row another GM removed, unknown lineage: not taken as present (warned)", async () => {
    const { a } = await loaded();
    a.store.dispatch(renameParticipant({ id: "r3", name: "Renamed" }));
    await settle();
    a.obr.dropRoomEvents(2);
    const without = { ...room(), rows: room().rows.filter((r) => r.id !== "r3") };
    write({ ...without, revision: 20, writerId: "other" }, { revision: 15, writerId: "ghost" });
    write({ ...without, settings: { ...without.settings, hideNpcFromPlayers: !without.settings.hideNpcFromPlayers }, revision: 21, writerId: "other" }, { revision: 20, writerId: "other" });
    a.wake();
    await settle(60_000);
    expect(room().writerId).toBe("other");
    expect(replaced(a)).toHaveLength(1);
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("two GMs press Next on the same position, a third GM's rename reached one of them first: no warning", async () => {
    seedRoom(inRound());
    const a = gm();
    const b = another("GM");
    const c = another("GM");
    await a.engine.start();
    await b.engine.start();
    await c.engine.start();
    await settle();
    const order = a.state().rows.map((r) => r.id);
    const releaseC = holdNextWrite(c);
    c.store.dispatch(setActiveParticipant(order[1]));
    await settle(1000);
    b.store.dispatch(renameParticipant({ id: order[2], name: "Renamed" }));
    await settle(1000);
    a.store.dispatch(setActiveParticipant(order[1]));
    await settle(1000);
    releaseC();
    await settle(60_000);
    expect(room().turn.activeRowId).toBe(order[1]);
    expect(room().rows.find((r) => r.id === order[2])?.name).toBe("Renamed");
    for (const client of [a, b, c]) {
      expect(notifications(client, "WARNING")).toEqual([]);
      expect(plain(client.state())).toEqual(plain(room()));
    }
  });

  it("our Next and another GM's concurrent Previous: the turn moved, our Next is dropped silently", async () => {
    const seed = inRound();
    const { a, order } = await loaded({ ...seed, turn: { ...seed.turn, activeRowId: seed.rows[1].id } });
    a.obr.setOwnEcho("never");
    const release = holdNextWrite(a);
    a.store.dispatch(setActiveParticipant(order[2]));
    await settle(100);
    write({ ...swadeSlice.reducer(room(), setActiveParticipant(order[0])), revision: 20, writerId: "other" }, { revision: 10, writerId: "seed" });
    release();
    await settle(60_000);
    expect(room().turn.activeRowId).toBe(order[0]);
    expect(notifications(a, "WARNING")).toEqual([]);
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("Start Round: another GM started the round first: dropped silently", async () => {
    const { a } = await loaded({ ...swadeSlice.reducer(seedState(10), dealRound(1)), revision: 10, writerId: "seed" });
    a.obr.setOwnEcho("never");
    const release = holdNextWrite(a);
    a.store.dispatch(startRound());
    await settle(100);
    const started = swadeSlice.reducer(swadeSlice.reducer(room(), startRound()), setActiveParticipant(room().rows[1].id));
    write({ ...started, revision: 20, writerId: "other" }, { revision: 10, writerId: "seed" });
    release();
    await settle(60_000);
    expect(room()).toMatchObject({ round: 1, phase: "in_round" });
    expect(room().turn.activeRowId).toBe(started.turn.activeRowId);
    expect(notifications(a, "WARNING")).toEqual([]);
    expect(plain(a.state())).toEqual(plain(room()));
  });

  for (const prior of [false, true]) {
    it(`our unsaved Next met by another GM's Next is not applied again over a later Previous (events missed, prior saved action: ${prior})`, async () => {
      const seed = inRound();
      const { a, order } = await loaded(seed);
      let base = seed;
      if (prior) {
        a.store.dispatch(renameParticipant({ id: order[2], name: "Renamed" }));
        await settle();
        base = room();
      }
      a.store.dispatch(setActiveParticipant(order[1]));
      const b1 = { ...swadeSlice.reducer(base, setActiveParticipant(order[1])), revision: base.revision + 1, writerId: "B" };
      write(b1, { revision: base.revision, writerId: base.writerId });
      await settle();
      expect(room().writerId).toBe("B");
      a.obr.dropRoomEvents(2);
      const b2 = { ...b1, settings: { ...b1.settings, hideNpcFromPlayers: !b1.settings.hideNpcFromPlayers }, revision: b1.revision + 1, writerId: "B" };
      write(b2, { revision: b1.revision, writerId: "B" });
      write({ ...swadeSlice.reducer(b2, setActiveParticipant(order[0])), revision: b2.revision + 1, writerId: "C" }, { revision: b2.revision, writerId: "B" });
      a.wake();
      await settle(60_000);
      expect(room().turn.activeRowId).toBe(order[0]);
      expect(room().writerId).toBe("C");
      expect(notifications(a, "WARNING")).toEqual([]);
      expect(plain(a.state())).toEqual(plain(room()));
    });
  }

  it("Lose Turn on our Next's target at the same time: the target cannot take a turn, our Next is dropped silently", async () => {
    const seed = inRound();
    // X active, J (a Joker that has not acted yet) next, U last.
    seed.rows = seed.rows.map((r, i) => (i === 1 ? { ...r, currentCardId: "JK-R", candidateIds: ["JK-R"] } : r));
    const { a, order } = await loaded(seed);
    a.store.dispatch(setActiveParticipant(order[1])); // A: Next X -> J
    // B (concurrently): Hold J, then Lose Turn J: J moves above X and has no turn.
    let b = swadeSlice.reducer(seed, setHold({ id: order[1], value: true }));
    b = swadeSlice.reducer(b, loseHold(order[1]));
    write({ ...b, revision: 11, writerId: "B" }, { revision: 10, writerId: "seed" });
    await settle(60_000);
    expect(room().turn.activeRowId).toBe(order[0]);
    expect(room().rows.map((r) => r.id)).toEqual([order[1], order[0], order[2]]);
    expect(notifications(a, "WARNING")).toEqual([]);
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("our target was put on Hold at the same time: our Next is dropped silently", async () => {
    const seed = inRound();
    const { a, order } = await loaded(seed);
    a.store.dispatch(setActiveParticipant(order[1]));
    write({ ...swadeSlice.reducer(seed, setHold({ id: order[1], value: true })), revision: 11, writerId: "B" }, { revision: 10, writerId: "seed" });
    await settle(60_000);
    expect(room().turn.activeRowId).toBe(order[0]);
    expect(room().rows.find((r) => r.id === order[1])?.onHold).toBe(true);
    expect(notifications(a, "WARNING")).toEqual([]);
    expect(plain(a.state())).toEqual(plain(room()));
  });

  it("a late joiner placed anywhere while the turn stays: our Next applies as made (no warning)", async () => {
    const seed = inRound();
    const { a, order } = await loaded(seed);
    a.store.dispatch(setActiveParticipant(order[1]));
    const card = seed.deck.remaining[0];
    const n = { id: "nn", name: "Late", type: "PC" as const, inactive: false, onHold: false, revealed: true, currentCardId: card, candidateIds: [card] };
    const b = { ...seed, rows: [seed.rows[0], n, ...seed.rows.slice(1)], deck: { ...seed.deck, remaining: seed.deck.remaining.slice(1), inPlay: [...seed.deck.inPlay, card] }, revision: 11, writerId: "B" };
    write(b, { revision: 10, writerId: "seed" });
    await settle(60_000);
    expect(room().turn.activeRowId).toBe(order[1]);
    expect(room().rows.map((r) => r.id)).toEqual([order[0], "nn", order[1], order[2]]);
    expect(notifications(a, "WARNING")).toEqual([]);
  });

  it("another GM's interrupting Act Now: the turn moved, our Next is dropped silently", async () => {
    const seed = inRound();
    const { a, order } = await loaded(seed);
    a.store.dispatch(setActiveParticipant(order[1]));
    const b = { ...seed, rows: [seed.rows[2], seed.rows[0], seed.rows[1]], turn: { ...seed.turn, activeRowId: order[2] }, revision: 11, writerId: "B" };
    write(b, { revision: 10, writerId: "seed" });
    await settle(60_000);
    expect(room().turn.activeRowId).toBe(order[2]);
    expect(notifications(a, "WARNING")).toEqual([]);
    expect(plain(a.state())).toEqual(plain(room()));
  });
});
