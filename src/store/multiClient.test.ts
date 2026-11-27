// Multi-client sync scenarios: seeded random interleaving, mixed v1 writers, a deleted key,
// and the size guard with other extensions' keys in the room.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));

import { flushObr, hub, resetObrMock, type ObrClient } from "../test/obrMock";
import { createAppStore, createWriterId, type AppStore } from "./store";
import { createSyncEngine, ROOM_LIMIT_BYTES, STATE_KEY, type SyncEngine, type SyncObr } from "./syncEngine";
import { encodeEncounterState, measureJsonBytes, parseEncounterState } from "./stateCodec";
import { initializeEmptyState } from "./initialState";
import {
  addCandidateCard,
  createParticipant,
  dealRound,
  endInitiative,
  endRound,
  insertActNow,
  loseHold,
  removeAllNpcsAndExtras,
  removeParticipant,
  renameParticipant,
  selectKeeperCard,
  setActiveParticipant,
  setHold,
  setPrivacy,
  setRevealed,
  startRound,
  restoreSnapshot,
  undoLastDraw,
} from "./swadeSlice";
import { generateAllCardIds } from "../utils/cardIds";
import type { EncounterState } from "./types";

interface Client {
  obr: ObrClient;
  store: AppStore;
  engine: SyncEngine;
  state: () => EncounterState;
}

const engines: SyncEngine[] = [];

function connect(obr: ObrClient): Client {
  const writerId = createWriterId();
  const store = createAppStore({ writerId, getMinRevision: () => engine.getMaxSeenRevision() });
  const engine = createSyncEngine({
    store,
    obr: obr as unknown as SyncObr,
    writerId,
    isGm: () => obr.state.player.role === "GM",
    subscribeRole: (listener) => obr.player.onChange(() => listener()),
  });
  engines.push(engine);
  return { obr, store, engine, state: () => store.getState().swade };
}

const settle = (ms = 30_000) => vi.advanceTimersByTimeAsync(ms);
const plain = (s: EncounterState) => JSON.parse(JSON.stringify(s));

const room = (): EncounterState => {
  const result = parseEncounterState(hub().roomMetadata[STATE_KEY]);
  if (result.kind !== "ok") throw new Error(`room holds ${result.kind}`);
  return result.state;
};

/** Deterministic PRNG (mulberry32). */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function expectDeckInvariant(state: EncounterState) {
  const all = [...state.deck.remaining, ...state.deck.inPlay, ...state.deck.discard];
  expect(all).toHaveLength(54);
  expect(new Set(all)).toEqual(new Set(generateAllCardIds()));
}

beforeEach(() => {
  vi.useFakeTimers();
  resetObrMock();
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("seeded random interleaving (2 GMs + 1 player)", () => {
  /** One random GM action, chosen from what the client's local state allows. */
  function randomAction(rand: () => number, s: EncounterState) {
    const pick = <T,>(xs: readonly T[]): T | undefined => (xs.length ? xs[Math.floor(rand() * xs.length)] : undefined);
    const row = pick(s.rows);
    const types = ["PC", "NPC", "GROUP"] as const;
    const options = [
      () => createParticipant({ name: `c${Math.floor(rand() * 1000)}`, type: pick(types)! }),
      () => createParticipant({ name: `c${Math.floor(rand() * 1000)}`, type: pick(types)! }),
      () => dealRound(),
      () => startRound(),
      () => endRound(),
      () => endInitiative(),
      () => setPrivacy(rand() < 0.5),
      () => removeAllNpcsAndExtras(),
      ...(row
        ? [
            () => removeParticipant(row.id),
            () => setHold({ id: row.id, value: rand() < 0.5 }),
            () => setRevealed({ id: row.id, value: rand() < 0.5 }),
            () => renameParticipant({ id: row.id, name: `r${Math.floor(rand() * 1000)}` }),
            () => addCandidateCard(row.id),
            () => undoLastDraw(row.id),
            () => loseHold(row.id),
            () => setActiveParticipant(row.id),
            () => insertActNow({ id: row.id, placement: rand() < 0.5 ? "before" : "after" }),
            () => (row.candidateIds.length ? selectKeeperCard({ participantId: row.id, cardId: pick(row.candidateIds)! }) : dealRound()),
          ]
        : []),
    ];
    return pick(options)!();
  }

  /** Writes stay in flight for a random time; own echoes come early, late or never. */
  function randomizeTransport(rand: () => number, clients: Client[]) {
    for (const c of clients) {
      const echo = rand();
      c.obr.setOwnEcho(echo < 0.4 ? "normal" : echo < 0.8 ? Math.floor(rand() * 400) : "never");
      c.obr.setWriteDelay(() => (rand() < 0.5 ? 0 : Math.floor(rand() * 300)));
    }
  }

  const SEEDS = [1, 7, 42, 1234, 99999, 3, 11, 256, 4096, 31337];

  it.each(SEEDS.flatMap((seed) => [[seed, false], [seed, true]] as const))(
    "seed %i (in-flight writes and echo order randomized: %s): 50 interleaved actions converge to the room state",
    async (seed, transport) => {
      const rand = seeded(seed);
      vi.spyOn(Math, "random").mockImplementation(seeded(seed * 31 + 1));

      const a = connect(hub().activeClient);
      const b = connect(hub().createClient({ role: "GM" }));
      const p = connect(hub().createClient({ role: "PLAYER" }));
      await Promise.all([a.engine.start(), b.engine.start(), p.engine.start()]);
      await settle();
      if (transport) randomizeTransport(seeded(seed * 7 + 3), [a, b, p]);

      const gms = [a, b];
      for (let i = 0; i < 50; i++) {
        const client = gms[rand() < 0.5 ? 0 : 1];
        client.store.dispatch(randomAction(rand, client.state()));
        const wait = rand();
        if (wait < 0.3) {
          // same tick: no time passes, the next action may come from the other GM
        } else if (wait < 0.6) {
          await flushObr();
        } else {
          await vi.advanceTimersByTimeAsync(Math.floor(rand() * 200));
        }
      }
      await settle();

      const final = plain(room());
      expect(plain(a.state())).toEqual(final);
      expect(plain(b.state())).toEqual(final);
      expect(plain(p.state())).toEqual(final);
      expect(p.obr.room.setMetadata).not.toHaveBeenCalled();
      expectDeckInvariant(room());
      expect(room().revision).toBeGreaterThan(10);
      for (const c of [a, b, p]) expect(c.engine.getSnapshot().status).toBe("ready");
      for (const c of [a, b]) expect(await c.engine.flush()).toBe(true);
    },
  );
});

describe("mixed v1 writer", () => {
  it("a v1 client writing mid-session is adopted by all; the next GM change writes v2 above it", async () => {
    const a = connect(hub().activeClient);
    const p = connect(hub().createClient({ role: "PLAYER" }));
    await Promise.all([a.engine.start(), p.engine.start()]);
    await settle();
    a.store.dispatch(createParticipant({ name: "Hero", type: "PC" }));
    a.store.dispatch(createParticipant({ name: "Hero 2", type: "PC" }));
    await settle();
    const revisionBefore = room().revision;
    const writes = a.obr.room.setMetadata.mock.calls.length;

    // A v1 client (no writerId, old row fields, no revision) overwrites the key.
    hub().writeRoomMetadata({
      [STATE_KEY]: {
        version: 1,
        round: 1,
        phase: "cards_dealt",
        deck: { remaining: generateAllCardIds().filter((id) => id !== "AS"), inPlay: ["AS"], discard: [], reshuffleAfterRound: false },
        rows: [
          { id: "p-1-a", name: "Old Hero", tokenIds: ["tok"], type: "PC", inactive: false, onHold: false, revealed: true, currentCardId: "AS", candidateIds: ["AS"], drewThisRound: true },
        ],
        turn: { activeRowId: null },
        settings: { hideNpcFromPlayers: true },
      },
    });
    await settle();

    expect(a.state().rows.map((r) => r.name)).toEqual(["Old Hero"]);
    expect(plain(p.state())).toEqual(plain(a.state()));
    // Adopting does not write back.
    expect(a.obr.room.setMetadata).toHaveBeenCalledTimes(writes);

    a.store.dispatch(startRound());
    await settle();
    const stored = hub().roomMetadata[STATE_KEY] as Record<string, unknown>;
    expect(stored.version).toBe(2);
    expect(stored.revision).toBeGreaterThan(revisionBefore);
    expect(JSON.stringify(stored)).not.toContain("tokenIds");
    expect(plain(p.state())).toEqual(plain(room()));
    expect(p.state().phase).toBe("in_round");
  });
});

describe("absent key mid-session", () => {
  it("two GMs both recreate the state, and all three clients converge", async () => {
    const a = connect(hub().activeClient);
    const b = connect(hub().createClient({ role: "GM" }));
    const p = connect(hub().createClient({ role: "PLAYER" }));
    await Promise.all([a.engine.start(), b.engine.start(), p.engine.start()]);
    await settle();
    a.store.dispatch(createParticipant({ name: "Hero", type: "PC" }));
    await settle();

    hub().writeRoomMetadata({ [STATE_KEY]: undefined });
    await settle();

    expect(room().rows).toEqual([]);
    expect(plain(a.state())).toEqual(plain(room()));
    expect(plain(b.state())).toEqual(plain(room()));
    expect(plain(p.state())).toEqual(plain(room()));
    expectDeckInvariant(room());
  });
});

describe("size guard with other extensions' keys", () => {
  it("counts other keys against the shared budget, never touches them, and recovers after rows are removed", async () => {
    const others = { "other.ext/a": "a".repeat(5000), "third.ext/b": { list: "b".repeat(3000) } };
    hub().roomMetadata = { ...others };
    hub().roomSizeLimit = ROOM_LIMIT_BYTES;

    const a = connect(hub().activeClient);
    await a.engine.start();
    await settle();
    expect(room().rows).toEqual([]);

    // About 8 kB of rows: fits alone, but not next to the 8 kB of other keys.
    const name = "N".repeat(300);
    for (let i = 0; i < 25; i++) a.store.dispatch(createParticipant({ name: `${name}${i}`, type: "NPC" }));
    await settle();

    expect(a.engine.getSnapshot().status).toBe("too-large");
    expect(room().rows).toEqual([]);
    expect(a.obr.state.notifications.filter((n) => n.variant === "ERROR")).toHaveLength(1);
    expect(measureJsonBytes(hub().roomMetadata)).toBeLessThanOrEqual(ROOM_LIMIT_BYTES);

    a.store.dispatch(removeAllNpcsAndExtras());
    a.store.dispatch(createParticipant({ name: "Hero", type: "PC" }));
    await settle();

    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(room().rows.map((r) => r.name)).toEqual(["Hero"]);
    expect(hub().roomMetadata["other.ext/a"]).toBe(others["other.ext/a"]);
    expect(hub().roomMetadata["third.ext/b"]).toEqual(others["third.ext/b"]);
  });

  it("a write is checked against the other keys present at that time", async () => {
    const a = connect(hub().activeClient);
    await a.engine.start();
    await settle();
    const name = "N".repeat(300);
    for (let i = 0; i < 20; i++) a.store.dispatch(createParticipant({ name: `${name}${i}`, type: "NPC" }));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("ready");
    const bytes = measureJsonBytes({ [STATE_KEY]: encodeEncounterState(a.state()) });

    // Another extension fills the room so that our current state no longer fits.
    hub().writeRoomMetadata({ "other.ext/a": "x".repeat(ROOM_LIMIT_BYTES - bytes) });
    await settle();
    a.store.dispatch(setPrivacy(false));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("too-large");
    expect(room().settings.hideNpcFromPlayers).toBe(true);

    // It frees the space again: the next change is written.
    hub().writeRoomMetadata({ "other.ext/a": undefined });
    await settle();
    a.store.dispatch(setPrivacy(false));
    a.store.dispatch(createParticipant({ name: "Hero", type: "PC" }));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(room().settings.hideNpcFromPlayers).toBe(false);
  });
});

describe("initial state helpers", () => {
  it("a fresh state holds the full deck once", () => {
    expectDeckInvariant(initializeEmptyState());
  });
});

describe("unsaved local change", () => {
  // After a too-large (or failed) write, an unrelated metadata event (our key unchanged) must
  // not revert the GM's unsaved change or hide the error status.
  it("is not reverted by an unrelated key change from another extension", async () => {
    const a = connect(hub().activeClient);
    await a.engine.start();
    await settle();
    const name = "N".repeat(300);
    for (let i = 0; i < 20; i++) a.store.dispatch(createParticipant({ name: `${name}${i}`, type: "NPC" }));
    await settle();
    const bytes = measureJsonBytes({ [STATE_KEY]: encodeEncounterState(a.state()) });
    hub().writeRoomMetadata({ "other.ext/a": "x".repeat(ROOM_LIMIT_BYTES - bytes) });
    await settle();

    a.store.dispatch(setPrivacy(false));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("too-large");

    // Another extension writes a small unrelated key; our key is unchanged.
    hub().writeRoomMetadata({ "other.ext/b": 1 });
    await settle();

    expect(a.state().settings.hideNpcFromPlayers).toBe(false);
    expect(a.engine.getSnapshot().status).toBe("too-large");
  });
it("an unsaved change after a failed write is replayed on a newer foreign state, without a warning", async () => {
    const a = connect(hub().activeClient);
    await a.engine.start();
    await settle();
    a.obr.failRoom("setMetadata", new Error("boom"), 1);
    a.store.dispatch(createParticipant({ name: "Kept", type: "PC" }));
    await settle();
    expect(a.engine.getSnapshot().status).toBe("error");

    // An unrelated key first: nothing changes.
    hub().writeRoomMetadata({ "other.ext/b": 1 });
    await settle();
    expect(Object.values(a.state().rows).map((r) => r.name)).toEqual(["Kept"]);
    expect(a.engine.getSnapshot().status).toBe("error");

    const b = connect(hub().createClient({ id: "gm-b", name: "GM B", role: "GM" }));
    await b.engine.start();
    await settle();
    b.store.dispatch(createParticipant({ name: "Other", type: "PC" }));
    await settle();

    // A replays its change on B's state and writes it: both changes are in the room.
    expect(room().rows.map((r) => r.name).sort()).toEqual(["Kept", "Other"]);
    expect(plain(a.state())).toEqual(plain(room()));
    expect(plain(b.state())).toEqual(plain(room()));
    expect(a.engine.getSnapshot().status).toBe("ready");
    expect(a.obr.state.notifications.filter((n) => n.variant === "WARNING")).toHaveLength(0);
  });
});

describe("two GMs acting at the same time (rebase)", () => {
  type Echo = "normal" | "never" | number;
  const ECHOES: Echo[] = ["normal", 80, "never"];
  /** Delay of B's action after A's: same tick, inside A's debounce, while A's write is in flight. */
  const GAPS = [0, 30, 70];
  const CASES = ECHOES.flatMap((echoA) =>
    ECHOES.flatMap((echoB) => [0, 120].flatMap((writeDelay) => GAPS.map((gap) => [echoA, echoB, writeDelay, gap] as const)))
  );

  /** Two GMs and a player, loaded from a room that holds `rows`. */
  async function room3(setup: (c: Client) => void) {
    const a = connect(hub().activeClient);
    await a.engine.start();
    await settle();
    setup(a);
    await settle();
    const b = connect(hub().createClient({ role: "GM" }));
    const p = connect(hub().createClient({ role: "PLAYER" }));
    await Promise.all([b.engine.start(), p.engine.start()]);
    await settle();
    return { a, b, p };
  }

  const warnings = (c: Client) => c.obr.state.notifications.filter((n) => n.variant === "WARNING");

  function expectConverged(...clients: Client[]) {
    const final = plain(room());
    for (const c of clients) {
      expect(plain(c.state())).toEqual(final);
      expect(c.engine.getSnapshot().status).toBe("ready");
      expect(warnings(c)).toEqual([]);
    }
  }

  it.each(CASES)(
    "A holds Bob, B renames Alice (echo A %s, echo B %s, write delay %i ms, B acts %i ms later): both changes kept",
    async (echoA, echoB, writeDelay, gap) => {
      const { a, b, p } = await room3((c) => {
        c.store.dispatch(createParticipant({ name: "Alice", type: "PC" }));
        c.store.dispatch(createParticipant({ name: "Bob", type: "PC" }));
      });
      a.obr.setOwnEcho(echoA);
      b.obr.setOwnEcho(echoB);
      for (const c of [a, b]) c.obr.setWriteDelay(writeDelay);
      const id = (name: string) => a.state().rows.find((r) => r.name === name)!.id;

      a.store.dispatch(setHold({ id: id("Bob"), value: true }));
      if (gap) await vi.advanceTimersByTimeAsync(gap);
      b.store.dispatch(renameParticipant({ id: id("Alice"), name: "Alicia" }));
      await settle();

      expect(room().rows.map((r) => [r.name, r.onHold])).toEqual([
        ["Alicia", false],
        ["Bob", true],
      ]);
      expectConverged(a, b, p);
    }
  );

  it.each(CASES)(
    "both add a participant (echo A %s, echo B %s, write delay %i ms, B acts %i ms later): both rows, each once",
    async (echoA, echoB, writeDelay, gap) => {
      const { a, b, p } = await room3(() => {});
      a.obr.setOwnEcho(echoA);
      b.obr.setOwnEcho(echoB);
      for (const c of [a, b]) c.obr.setWriteDelay(writeDelay);

      a.store.dispatch(createParticipant({ name: "From A", type: "PC" }));
      if (gap) await vi.advanceTimersByTimeAsync(gap);
      b.store.dispatch(createParticipant({ name: "From B", type: "NPC" }));
      await settle();

      expect(room().rows.map((r) => r.name).sort()).toEqual(["From A", "From B"]);
      expectConverged(a, b, p);
    }
  );

  it("both press Next on the same turn: Next names its target row, so the turn advances once", async () => {
    const { a, b, p } = await room3((c) => {
      for (const name of ["One", "Two", "Three"]) c.store.dispatch(createParticipant({ name, type: "PC" }));
      c.store.dispatch(dealRound());
      c.store.dispatch(startRound());
    });
    const [first, second] = a.state().rows;
    expect(a.state().turn.activeRowId).toBe(first.id);

    a.store.dispatch(setActiveParticipant(second.id));
    b.store.dispatch(setActiveParticipant(second.id));
    await settle();

    expect(room().turn.activeRowId).toBe(second.id);
    expectConverged(a, b, p);
  });

  it("different concurrent turn changes both apply, in room order", async () => {
    const { a, b, p } = await room3((c) => {
      for (const name of ["One", "Two", "Three"]) c.store.dispatch(createParticipant({ name, type: "PC" }));
      c.store.dispatch(dealRound());
      c.store.dispatch(startRound());
    });
    const rows = a.state().rows;

    a.store.dispatch(setHold({ id: rows[2].id, value: true }));
    b.store.dispatch(setActiveParticipant(rows[1].id));
    await settle();

    expect(room().turn.activeRowId).toBe(rows[1].id);
    expect(room().rows.find((r) => r.id === rows[2].id)?.onHold).toBe(true);
    expectConverged(a, b, p);
  });

  it("a concurrent Undo is not replayed over the other GM's change: it is dropped with one warning", async () => {
    const { a, b, p } = await room3((c) => {
      c.store.dispatch(createParticipant({ name: "Alice", type: "PC" }));
    });
    const id = a.state().rows[0].id;
    a.store.dispatch(setHold({ id, value: true }));
    await settle();
    const before = plain(room());

    // A undoes its hold (a snapshot restore) while B renames Alice.
    a.obr.setWriteDelay(120);
    a.store.dispatch(restoreSnapshot({ ...before, rows: before.rows.map((r: EncounterState["rows"][number]) => ({ ...r, onHold: false })) }));
    b.store.dispatch(renameParticipant({ id, name: "Alicia" }));
    await settle();

    const final = plain(room());
    for (const c of [a, b, p]) expect(plain(c.state())).toEqual(final);
    // Whichever landed first, B's rename is never erased by A's restore.
    expect(final.rows[0].name).toBe("Alicia");
    expect(warnings(b)).toEqual([]);
  });
});
