import { describe, expect, it } from "vitest";
import {
  encodeEncounterState,
  isSafeImageUrl,
  measureEncounterState,
  parseEncounterState,
} from "./stateCodec";
import { initializeEmptyState } from "./initialState";
import { generateAllCardIds } from "../utils/cardIds";
import type { EncounterState, ParticipantRow } from "./types";

const ALL = generateAllCardIds();
const IMAGE = "https://images.owlbear.rodeo/0a5b4c1e-3b2a-4c5d-9e8f-123456789abc/items/AbCdEfGhIjKlMnOpQrStUv.png";

/** A realistic mid-round state with `count` rows, every row holding one card. */
export function bigState(count: number): EncounterState {
  const state = initializeEmptyState();
  const types = ["PC", "NPC", "GROUP"] as const;
  for (let i = 0; i < count; i++) {
    const card = state.deck.remaining.pop()!;
    state.deck.inPlay.push(card);
    const row: ParticipantRow = {
      id: Math.random().toString(36).slice(2, 10),
      name: `Goblin ${i + 1}`,
      imageUrl: IMAGE,
      type: types[i % 3],
      inactive: false,
      onHold: false,
      revealed: i % 3 === 0,
      currentCardId: card,
      candidateIds: [card],
    };
    state.rows.push(row);
  }
  return { ...state, round: 3, phase: "in_round", turn: { activeRowId: state.rows[0]?.id ?? null }, revision: 42, writerId: "abcdefgh" };
}

const v1Fixture = {
  version: 1,
  round: 2,
  phase: "in_round",
  deck: { remaining: ALL.slice(2), inPlay: ["AS", "KH"], discard: [], reshuffleAfterRound: false },
  rows: [
    {
      id: "p-1700000000000-abc123",
      name: "Hero",
      tokenIds: ["token-1"],
      imageUrl: IMAGE,
      type: "PC",
      inactive: false,
      onHold: false,
      revealed: true,
      currentCardId: "AS",
      candidateIds: ["AS"],
      drewThisRound: true,
    },
    {
      id: "p-1700000000001-def456",
      name: "Orc",
      tokenIds: [],
      type: "NPC",
      inactive: false,
      onHold: true,
      revealed: false,
      currentCardId: "KH",
      candidateIds: ["KH"],
      drewThisRound: false,
    },
  ],
  turn: { activeRowId: "p-1700000000000-abc123" },
  settings: { hideNpcFromPlayers: true },
  revision: 15,
};

function parseOk(raw: unknown): EncounterState {
  const result = parseEncounterState(raw);
  if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
  return result.state;
}

describe("parseEncounterState", () => {
  it("returns absent for undefined/null", () => {
    expect(parseEncounterState(undefined)).toEqual({ kind: "absent" });
    expect(parseEncounterState(null)).toEqual({ kind: "absent" });
  });

  it("migrates a v1 state to v2 and keeps the revision", () => {
    const state = parseOk(v1Fixture);
    expect(state.version).toBe(2);
    expect(state.revision).toBe(15);
    expect(state.writerId).toBe("");
    expect(state.rows[0]).not.toHaveProperty("tokenIds");
    expect(state.rows[0]).not.toHaveProperty("drewThisRound");
    expect(state.rows[1].onHold).toBe(true);
    expect(state.turn.activeRowId).toBe("p-1700000000000-abc123");
  });

  it("reports a newer version as too-new", () => {
    expect(parseEncounterState({ ...v1Fixture, version: 3 })).toEqual({ kind: "too-new" });
  });

  it.each([
    ["a string", "hello"],
    ["an array", []],
    ["rows as object", { ...v1Fixture, rows: {} }],
    ["missing deck arrays", { ...v1Fixture, deck: { remaining: [] } }],
    ["deck missing", { ...v1Fixture, deck: undefined }],
    ["bad phase", { ...v1Fixture, phase: "lunch" }],
    ["negative round", { ...v1Fixture, round: -1 }],
    ["string round", { ...v1Fixture, round: "2" }],
    ["string version", { ...v1Fixture, version: "1" }],
  ])("returns invalid for %s and never throws", (_label, raw) => {
    expect(parseEncounterState(raw)).toEqual({ kind: "invalid" });
  });

  it("repairs bad revision, rows, card ids and image URLs", () => {
    const raw = {
      ...v1Fixture,
      revision: -3,
      deck: { remaining: ["ZZ", "AS", ...ALL.slice(10)], inPlay: ["AS", 5], discard: [] },
      rows: [
        { ...v1Fixture.rows[0], imageUrl: "javascript:alert(1)", candidateIds: ["AS", "XX"], currentCardId: "XX" },
        { ...v1Fixture.rows[1], type: "DRAGON" },
        { id: 5, name: "no id" },
        null,
        { ...v1Fixture.rows[0], name: "duplicate id" },
        { id: "r3", name: "Bare", type: "GROUP", candidateIds: null },
      ],
      turn: { activeRowId: "missing" },
      settings: null,
    };
    const state = parseOk(raw);
    expect(state.revision).toBe(0);
    expect(state.rows.map((r) => r.name)).toEqual(["Hero", "Bare"]);
    expect(state.rows[0].imageUrl).toBeUndefined();
    // AS is in remaining, not in play, so the row cannot hold it (R4-A4).
    expect(state.rows[0].candidateIds).toEqual([]);
    expect(state.rows[0].currentCardId).toBeUndefined();
    expect(state.rows[1]).toMatchObject({ inactive: false, onHold: false, revealed: false, candidateIds: [] });
    expect(state.turn.activeRowId).toBeNull();
    expect(state.settings.hideNpcFromPlayers).toBe(true);
    // every card exactly once across the piles
    const all = [...state.deck.remaining, ...state.deck.inPlay, ...state.deck.discard];
    expect(all).toHaveLength(54);
    expect(new Set(all).size).toBe(54);
    expect(state.deck.inPlay).toEqual([]); // AS was already in remaining
  });
});

describe("row cards against the deck piles (R4-A4)", () => {
  type RawRow = { id: string; currentCardId?: string; candidateIds: string[] };
  function raw(rows: RawRow[], inPlay: string[], discard: string[] = []) {
    return {
      version: 2,
      round: 1,
      phase: "in_round",
      deck: { remaining: ALL.filter((id) => !inPlay.includes(id) && !discard.includes(id)), inPlay, discard },
      rows: rows.map((r) => ({ name: r.id, type: "PC", ...r })),
      turn: { activeRowId: null },
      settings: { hideNpcFromPlayers: true },
      revision: 1,
      writerId: "w",
    };
  }
  function expectInvariant(state: EncounterState) {
    const all = [...state.deck.remaining, ...state.deck.inPlay, ...state.deck.discard];
    expect(all).toHaveLength(54);
    expect(new Set(all).size).toBe(54);
    const held = state.rows.flatMap((r) => [...new Set([...r.candidateIds, ...(r.currentCardId ? [r.currentCardId] : [])])]);
    expect(new Set(held).size).toBe(held.length); // no card on two rows
    expect([...held].sort()).toEqual([...state.deck.inPlay].sort());
  }

  it("keeps a consistent state unchanged", () => {
    const state = parseOk(raw([{ id: "A", currentCardId: "KS", candidateIds: ["KS", "2C"] }, { id: "B", currentCardId: "QH", candidateIds: ["QH"] }], ["KS", "2C", "QH"]));
    expect(state.rows[0]).toMatchObject({ currentCardId: "KS", candidateIds: ["KS", "2C"] });
    expect(state.rows[1]).toMatchObject({ currentCardId: "QH", candidateIds: ["QH"] });
    expect(state.deck.inPlay).toEqual(["KS", "2C", "QH"]);
    expectInvariant(state);
  });

  it("drops a row card that is in remaining or discard, not in play", () => {
    const state = parseOk(raw([{ id: "A", currentCardId: "KS", candidateIds: ["KS"] }, { id: "B", currentCardId: "QH", candidateIds: ["QH", "3D"] }], ["QH"], ["3D"]));
    expect(state.rows[0].currentCardId).toBeUndefined();
    expect(state.rows[0].candidateIds).toEqual([]);
    expect(state.rows[1]).toMatchObject({ currentCardId: "QH", candidateIds: ["QH"] });
    expect(state.deck.remaining).toContain("KS");
    expectInvariant(state);
  });

  it("gives a card held by two rows to the first one only", () => {
    const state = parseOk(raw([{ id: "A", currentCardId: "KS", candidateIds: ["KS"] }, { id: "B", currentCardId: "KS", candidateIds: ["KS", "QH"] }], ["KS", "QH"]));
    expect(state.rows[0]).toMatchObject({ currentCardId: "KS", candidateIds: ["KS"] });
    expect(state.rows[1].currentCardId).toBeUndefined();
    expect(state.rows[1].candidateIds).toEqual(["QH"]);
    expectInvariant(state);
  });

  it("removes duplicate candidates within a row", () => {
    const state = parseOk(raw([{ id: "A", currentCardId: "KS", candidateIds: ["KS", "KS", "2C", "2C"] }], ["KS", "2C"]));
    expect(state.rows[0].candidateIds).toEqual(["KS", "2C"]);
    expectInvariant(state);
  });

  it("moves an in-play card that no row holds to the discard pile", () => {
    const state = parseOk(raw([{ id: "A", currentCardId: "KS", candidateIds: ["KS"] }], ["KS", "7H"]));
    expect(state.deck.inPlay).toEqual(["KS"]);
    expect(state.deck.discard).toContain("7H");
    expectInvariant(state);
  });

  it("a later deal never gives a card to two rows after loading a corrupt state", () => {
    // KS is listed in remaining and also held by row A.
    const corrupt = raw([{ id: "A", currentCardId: "KS", candidateIds: ["KS"] }], []);
    const state = parseOk(corrupt);
    expect(state.rows[0].currentCardId).toBeUndefined();
    expectInvariant(state);
  });
});

describe("encodeEncounterState", () => {
  it("round-trips through parse", () => {
    const state = bigState(5);
    state.rows[1].onHold = true;
    state.deck.reshuffleAfterRound = true;
    expect(parseOk(JSON.parse(JSON.stringify(encodeEncounterState(state))))).toEqual(state);
  });

  it("omits false booleans and unsafe image URLs but never arrays", () => {
    const state = bigState(2);
    state.rows[0].imageUrl = "http://example.com/x.png";
    state.rows[1].candidateIds = [];
    const encoded = encodeEncounterState(state) as { rows: Record<string, unknown>[]; deck: Record<string, unknown> };
    expect(encoded.deck).not.toHaveProperty("reshuffleAfterRound");
    expect(encoded.rows[0]).not.toHaveProperty("imageUrl");
    expect(encoded.rows[0]).not.toHaveProperty("inactive");
    expect(encoded.rows[0]).not.toHaveProperty("onHold");
    expect(encoded.rows[0].revealed).toBe(true);
    expect(encoded.rows[1].candidateIds).toEqual([]);
    expect(encoded.deck.discard).toEqual([]);
  });

  it("stores the Joker deal count only when above 0 and parses it back", () => {
    const state = bigState(2);
    expect(encodeEncounterState(state).deck).not.toHaveProperty("jokersDealtThisRound");
    state.deck.reshuffleAfterRound = true;
    state.deck.jokersDealtThisRound = 2;
    expect(parseOk(JSON.parse(JSON.stringify(encodeEncounterState(state))))).toEqual(state);
  });

  it("drops an invalid Joker deal count", () => {
    for (const bad of [-1, 1.5, "2", 0]) {
      const raw = JSON.parse(JSON.stringify(encodeEncounterState(bigState(1))));
      raw.deck.jokersDealtThisRound = bad;
      expect(parseOk(raw).deck).not.toHaveProperty("jokersDealtThisRound");
    }
  });

  it("drops a stale Joker deal count outside a dealt round (v1 End Round keeps it)", () => {
    for (const phase of ["setup", "between_rounds"] as const) {
      const raw = JSON.parse(JSON.stringify(encodeEncounterState({ ...bigState(1), phase })));
      raw.deck.jokersDealtThisRound = 2;
      expect(parseOk(raw).deck).not.toHaveProperty("jokersDealtThisRound");
    }
    for (const phase of ["cards_dealt", "in_round"] as const) {
      const raw = JSON.parse(JSON.stringify(encodeEncounterState({ ...bigState(1), phase })));
      raw.deck.jokersDealtThisRound = 2;
      expect(parseOk(raw).deck.jokersDealtThisRound).toBe(2);
    }
  });

  it("keeps a 40-row encounter under 9 kB", () => {
    expect(measureEncounterState("rodeo.owlbear.swade-initiative/state", bigState(40))).toBeLessThan(9 * 1024);
  });
});

describe("isSafeImageUrl", () => {
  it("accepts only https URLs", () => {
    expect(isSafeImageUrl(IMAGE)).toBe(true);
    expect(isSafeImageUrl("http://x.test/a.png")).toBe(false);
    expect(isSafeImageUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeImageUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isSafeImageUrl("not a url")).toBe(false);
    expect(isSafeImageUrl(42)).toBe(false);
  });
});

describe("row actNowTurn flag (TURN-FIX)", () => {
  it("round-trips when true and is omitted when false or absent", () => {
    const state = bigState(2);
    state.rows[0] = { ...state.rows[0], actNowTurn: true };
    state.rows[1] = { ...state.rows[1], actNowTurn: false };
    const encoded = encodeEncounterState(state) as { rows: Record<string, unknown>[] };
    expect(encoded.rows[0].actNowTurn).toBe(true);
    expect(encoded.rows[1]).not.toHaveProperty("actNowTurn");
    const parsed = parseOk(encoded);
    expect(parsed.rows[0].actNowTurn).toBe(true);
    expect(parsed.rows[1]).not.toHaveProperty("actNowTurn");
  });

  it("drops a non-true value and is absent in migrated v1 rows", () => {
    const raw = { ...v1Fixture, rows: [{ ...v1Fixture.rows[0], actNowTurn: "yes" }, v1Fixture.rows[1]] };
    const parsed = parseOk(raw);
    expect(parsed.rows[0]).not.toHaveProperty("actNowTurn");
    expect(parsed.rows[1]).not.toHaveProperty("actNowTurn");
  });
});

describe("client (app version and sync protocol)", () => {
  const state = { ...initializeEmptyState(), revision: 7, writerId: "w1" };
  const clientOf = (raw: unknown) => {
    const result = parseEncounterState(raw);
    return result.kind === "ok" ? result.client : "not ok";
  };

  it("round-trips, bound to the state's identity", () => {
    const raw = encodeEncounterState(state, null, { syncProtocol: 3, appVersion: "1.2.3" });
    expect(raw.client).toEqual({ syncProtocol: 3, appVersion: "1.2.3", of: "7/w1" });
    expect(clientOf(raw)).toEqual({ syncProtocol: 3, appVersion: "1.2.3" });
  });

  it("omits the app version when unknown, and the key when no client is given", () => {
    expect(encodeEncounterState(state, null, { syncProtocol: 1 }).client).toEqual({ syncProtocol: 1, of: "7/w1" });
    expect(clientOf(encodeEncounterState(state, null, { syncProtocol: 1 }))).toEqual({ syncProtocol: 1 });
    expect("client" in encodeEncounterState(state)).toBe(false);
    expect(clientOf(encodeEncounterState(state))).toBeNull();
  });

  it("a client copied to another state (older app keeps unknown keys) counts as missing", () => {
    const raw = encodeEncounterState(state, null, { syncProtocol: 1, appVersion: "1.0.0" });
    expect(clientOf({ ...raw, revision: 8 })).toBeNull();
    expect(clientOf({ ...raw, version: 1, revision: 8 })).toBeNull();
  });

  it("drops a malformed client or app version", () => {
    const raw = encodeEncounterState(state);
    const bad = (client: unknown) => clientOf({ ...raw, client });
    expect(bad("x")).toBeNull();
    expect(bad({ syncProtocol: 0, of: "7/w1" })).toBeNull();
    expect(bad({ syncProtocol: 1.5, of: "7/w1" })).toBeNull();
    expect(bad({ syncProtocol: "2", of: "7/w1" })).toBeNull();
    expect(bad({ syncProtocol: 2 })).toBeNull();
    expect(bad({ syncProtocol: 2, appVersion: 5, of: "7/w1" })).toEqual({ syncProtocol: 2 });
    expect(bad({ syncProtocol: 2, appVersion: "", of: "7/w1" })).toEqual({ syncProtocol: 2 });
    expect(bad({ syncProtocol: 2, appVersion: "x".repeat(33), of: "7/w1" })).toEqual({ syncProtocol: 2 });
  });
});
