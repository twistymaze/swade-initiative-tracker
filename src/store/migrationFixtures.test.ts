// Realistic stored v1 states (as written by the released v1 extension) → v2, and codec stability.
import { describe, expect, it } from "vitest";
import { encodeEncounterState, parseEncounterState } from "./stateCodec";
import { migrateState } from "./migrations";
import { generateAllCardIds } from "../utils/cardIds";
import type { EncounterState } from "./types";

const ALL = generateAllCardIds();
const without = (...ids: string[]) => ALL.filter((id) => !ids.includes(id));
const IMG = "https://images.owlbear.rodeo/abc/items/token.png";

const v1Row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  tokenIds: [`item-${id}`],
  type: "PC",
  inactive: false,
  onHold: false,
  revealed: true,
  candidateIds: [],
  drewThisRound: false,
  ...extra,
});

const fixtures: Record<string, Record<string, unknown>> = {
  "fresh setup, no revision, no version": {
    round: 0,
    phase: "setup",
    deck: { remaining: ALL, inPlay: [], discard: [], reshuffleAfterRound: false },
    rows: [v1Row("p-1-a", { imageUrl: IMG }), v1Row("p-1-b", { type: "NPC", revealed: false })],
    turn: { activeRowId: null },
    settings: { hideNpcFromPlayers: true },
  },
  "mid-round with a Joker, a hold and extra candidates": {
    version: 1,
    round: 3,
    phase: "in_round",
    deck: { remaining: without("JK-R", "5S", "9H", "2D"), inPlay: ["JK-R", "5S", "9H"], discard: ["2D"], reshuffleAfterRound: true },
    rows: [
      v1Row("p-1-a", { currentCardId: "JK-R", candidateIds: ["JK-R"], drewThisRound: true }),
      v1Row("p-1-g", { type: "GROUP", name: "Goblins", tokenIds: ["t1", "t2", "t3"], revealed: false, currentCardId: "9H", candidateIds: ["5S", "9H"], drewThisRound: true }),
      v1Row("p-1-h", { onHold: true }),
    ],
    turn: { activeRowId: "p-1-g" },
    settings: { hideNpcFromPlayers: false },
    revision: 88,
  },
  "between rounds, inactive extra, missing settings and turn": {
    version: 1,
    round: 5,
    phase: "between_rounds",
    deck: { remaining: without("AS"), inPlay: [], discard: ["AS"] },
    rows: [v1Row("p-1-x", { type: "GROUP", inactive: true })],
    revision: 3,
  },
};

function parseOk(raw: unknown): EncounterState {
  const result = parseEncounterState(raw);
  if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
  return result.state;
}

describe.each(Object.entries(fixtures))("v1 fixture: %s", (_name, fixture) => {
  it("migrates to v2 without old row fields", () => {
    const result = migrateState(fixture);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.state.version).toBe(2);
    expect(result.state.writerId).toBe("");
    for (const r of result.state.rows as Record<string, unknown>[]) {
      expect(r).not.toHaveProperty("tokenIds");
      expect(r).not.toHaveProperty("drewThisRound");
    }
  });

  it("parses with every row, the turn, the deck and the revision kept", () => {
    const state = parseOk(fixture);
    const rows = fixture.rows as Record<string, unknown>[];
    expect(state.rows.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(state.rows.map((r) => [r.type, r.onHold, r.inactive, r.revealed, r.currentCardId, r.candidateIds])).toEqual(
      rows.map((r) => [r.type, r.onHold, r.inactive, r.revealed, r.currentCardId, r.candidateIds])
    );
    expect(state.revision).toBe(typeof fixture.revision === "number" ? fixture.revision : 0);
    expect(state.round).toBe(fixture.round);
    expect(state.phase).toBe(fixture.phase);
    expect(state.turn.activeRowId).toBe((fixture.turn as { activeRowId?: string } | undefined)?.activeRowId ?? null);
    const all = [...state.deck.remaining, ...state.deck.inPlay, ...state.deck.discard];
    expect(new Set(all).size).toBe(54);
  });

  it("encode(decode(x)) is stable", () => {
    const once = encodeEncounterState(parseOk(fixture));
    const twice = encodeEncounterState(parseOk(once));
    expect(twice).toEqual(once);
    expect(JSON.parse(JSON.stringify(once))).toEqual(once);
  });

  it("does not mutate the stored fixture", () => {
    const copy = structuredClone(fixture);
    parseEncounterState(fixture);
    expect(fixture).toEqual(copy);
  });
});

describe("v1 settings defaults", () => {
  it("missing settings mean privacy on", () => {
    expect(parseOk(fixtures["between rounds, inactive extra, missing settings and turn"]).settings.hideNpcFromPlayers).toBe(true);
  });
});
