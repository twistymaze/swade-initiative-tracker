// Full round lifecycle through the slice reducer with a stacked deck.
import { describe, expect, it } from "vitest";
import reducer, {
  addCandidateCard,
  createParticipant,
  dealRound,
  endInitiative,
  endRound,
  insertActNow,
  removeAllNpcsAndExtras,
  selectKeeperCard,
  setActiveParticipant,
  setHold,
  startRound,
} from "./swadeSlice";
import { initializeEmptyState } from "./initialState";
import { findTurnIndexFrom } from "./swadeSlice";
import { generateAllCardIds } from "../utils/cardIds";
import type { CardId, EncounterState, ParticipantRow } from "./types";
import type { UnknownAction } from "@reduxjs/toolkit";

const row = (id: string, partial: Partial<ParticipantRow> = {}): ParticipantRow => ({
  id,
  name: id,
  type: "PC",
  inactive: false,
  onHold: false,
  revealed: true,
  candidateIds: [],
  ...partial,
});

/** State whose deck deals `top` first (in order), then the rest. */
function stacked(rows: ParticipantRow[], top: CardId[]): EncounterState {
  const state = initializeEmptyState();
  const rest = generateAllCardIds().filter((id) => !top.includes(id));
  state.deck.remaining = [...rest, ...[...top].reverse()];
  state.rows = rows;
  return state;
}

const run = (state: EncounterState, ...actions: UnknownAction[]) => actions.reduce(reducer, state);
const order = (s: EncounterState) => s.rows.map((r) => r.id);
const cards = (s: EncounterState) => Object.fromEntries(s.rows.map((r) => [r.id, r.currentCardId]));
const active = (s: EncounterState) => s.turn.activeRowId;

function expectDeckInvariant(s: EncounterState) {
  const all = [...s.deck.remaining, ...s.deck.inPlay, ...s.deck.discard];
  expect(all).toHaveLength(54);
  expect(new Set(all).size).toBe(54);
}

/** Next, as the ControlBar does it. */
function next(s: EncounterState): EncounterState {
  const index = s.rows.findIndex((r) => r.id === s.turn.activeRowId);
  const to = findTurnIndexFrom(s.rows, index + 1);
  return to === -1 ? s : reducer(s, setActiveParticipant(s.rows[to].id));
}

describe("full round lifecycle", () => {
  it("setup → deal → start → next×n → end → deal", () => {
    let s = stacked([row("A"), row("B"), row("C", { type: "NPC", revealed: false })], ["5H", "KS", "9D", "2C", "QH", "3S"]);

    s = reducer(s, dealRound());
    expect(s.phase).toBe("cards_dealt");
    expect(s.round).toBe(1);
    expect(cards(s)).toEqual({ A: "5H", B: "KS", C: "9D" });
    expect(order(s)).toEqual(["B", "C", "A"]);
    expect(active(s)).toBeNull();

    s = reducer(s, startRound());
    expect(s.phase).toBe("in_round");
    expect(active(s)).toBe("B");

    s = next(s);
    expect(active(s)).toBe("C");
    expect(s.rows.find((r) => r.id === "C")!.revealed).toBe(true); // auto-reveal on turn
    s = next(s);
    expect(active(s)).toBe("A");
    expect(next(s)).toBe(s); // end of the order: no wrap

    s = reducer(s, endRound());
    expect(s.phase).toBe("between_rounds");
    expect(active(s)).toBeNull();
    expect(s.deck.inPlay).toEqual([]);
    expect([...s.deck.discard].sort()).toEqual(["5H", "9D", "KS"].sort());
    expect(s.rows.every((r) => r.currentCardId === undefined && r.candidateIds.length === 0)).toBe(true);

    s = reducer(s, dealRound());
    expect(s.round).toBe(2);
    // Dealt in display order (B, C, A), then re-sorted.
    expect(cards(s)).toEqual({ A: "3S", B: "2C", C: "QH" });
    expect(order(s)).toEqual(["C", "A", "B"]);
    // NPC hidden again for the new round (privacy on).
    expect(s.rows.find((r) => r.id === "C")!.revealed).toBe(false);
    expectDeckInvariant(s);
  });

  it("phase guards: start, end and deal are no-ops in the wrong phase", () => {
    const s = stacked([row("A")], []);
    expect(reducer(s, startRound())).toBe(s);
    expect(reducer(s, endRound())).toBe(s);
    const dealt = reducer(s, dealRound());
    expect(reducer(dealt, dealRound())).toBe(dealt);
    expect(reducer(dealt, endRound())).toBe(dealt);
    const running = reducer(dealt, startRound());
    expect(reducer(running, startRound())).toBe(running);
    expect(reducer(running, dealRound())).toBe(running);
  });

  it("endInitiative returns to setup with a full deck and keeps rows", () => {
    let s = stacked([row("A"), row("B", { type: "NPC", revealed: false })], ["AS", "KS"]);
    s = run(s, dealRound(), startRound(), setHold({ id: "A", value: true }), endRound(), endInitiative());
    expect(s.phase).toBe("setup");
    expect(s.round).toBe(0);
    expect(active(s)).toBeNull();
    expect(s.deck.remaining).toHaveLength(54);
    expect(s.rows.map((r) => [r.id, r.onHold, r.revealed])).toEqual([
      ["A", false, true],
      ["B", false, false],
    ]);
  });
});

describe("Jokers and reshuffle", () => {
  it("a Joker acts first, then the deck is reshuffled after that round", () => {
    let s = stacked([row("A"), row("B"), row("C")], ["AS", "JK-R", "KH"]);
    s = reducer(s, dealRound());
    expect(order(s)).toEqual(["B", "A", "C"]);
    expect(s.deck.reshuffleAfterRound).toBe(true);

    s = run(s, startRound(), endRound());
    expect(s.deck.reshuffleAfterRound).toBe(false);
    expect(s.deck.discard).toEqual([]);
    expect(s.deck.remaining).toHaveLength(54);
    expectDeckInvariant(s);
  });

  it("black Joker beats red Joker", () => {
    const s = reducer(stacked([row("R"), row("B")], ["JK-R", "JK-B"]), dealRound());
    expect(order(s)).toEqual(["B", "R"]);
  });

  it("a Joker drawn as an extra candidate also triggers the reshuffle", () => {
    let s = stacked([row("A")], ["5C", "JK-B"]);
    s = run(s, dealRound(), addCandidateCard("A"));
    expect(s.rows[0].candidateIds).toEqual(["5C", "JK-B"]);
    expect(s.deck.reshuffleAfterRound).toBe(true);
    s = reducer(s, selectKeeperCard({ participantId: "A", cardId: "JK-B" }));
    expect(s.deck.discard).toEqual(["5C"]);
    s = run(s, startRound(), endRound());
    expect(s.deck.remaining).toHaveLength(54);
  });

  it("without a Joker the discard pile carries over to the next round", () => {
    let s = stacked([row("A")], ["5C", "6C"]);
    s = run(s, dealRound(), startRound(), endRound(), dealRound());
    expect(s.deck.discard).toEqual(["5C"]);
    expect(s.rows[0].currentCardId).toBe("6C");
  });
});

describe("hold across rounds", () => {
  it("a held row gets no new card, keeps its hold, sorts above card holders and is skipped by Next", () => {
    let s = stacked([row("A"), row("B"), row("C")], ["KS", "QS", "JS", "10S", "9S"]);
    s = run(s, dealRound(), startRound());
    expect(order(s)).toEqual(["A", "B", "C"]);
    s = reducer(s, setHold({ id: "B", value: true }));

    s = run(s, endRound());
    expect(s.rows.find((r) => r.id === "B")!.onHold).toBe(true);

    s = reducer(s, dealRound());
    expect(s.round).toBe(2);
    expect(cards(s)).toEqual({ A: "10S", B: undefined, C: "9S" });
    // Held rows sort after Jokers and before card holders.
    expect(order(s)).toEqual(["B", "A", "C"]);

    s = reducer(s, startRound());
    expect(active(s)).toBe("A");
    s = next(s);
    expect(active(s)).toBe("C");

    // Act Now after C: B leaves hold, acts after C.
    s = reducer(s, insertActNow({ id: "B", placement: "after" }));
    expect(order(s)).toEqual(["A", "C", "B"]);
    expect(s.rows.find((r) => r.id === "B")!.onHold).toBe(false);
    expect(active(s)).toBe("C");
    s = next(s);
    expect(active(s)).toBe("B");
  });

  it("a hidden held NPC is not auto-revealed until it acts", () => {
    let s = stacked([row("A"), row("N", { type: "NPC", revealed: false })], ["KS", "QS"]);
    s = run(s, dealRound(), setHold({ id: "N", value: true }), startRound());
    expect(active(s)).toBe("A");
    expect(s.rows.find((r) => r.id === "N")!.revealed).toBe(false);
    s = reducer(s, insertActNow({ id: "N", placement: "before" }));
    expect(active(s)).toBe("N");
    expect(s.rows.find((r) => r.id === "N")!.revealed).toBe(true);
  });
});

describe("Act Now", () => {
  const base = () => run(stacked([row("A"), row("B"), row("C"), row("D")], ["KS", "QS", "JS", "10S"]), dealRound(), startRound());

  it("before, from below the active row: interrupts and becomes active", () => {
    let s = next(base()); // B active
    s = reducer(s, setHold({ id: "D", value: true }));
    s = reducer(s, insertActNow({ id: "D", placement: "before" }));
    expect(order(s)).toEqual(["A", "D", "B", "C"]);
    expect(active(s)).toBe("D");
    s = next(s);
    expect(active(s)).toBe("B");
  });

  it("after, from above the active row: goes right after it; active row unchanged", () => {
    let s = next(next(base())); // C active
    s = reducer(s, setHold({ id: "A", value: true }));
    s = reducer(s, insertActNow({ id: "A", placement: "after" }));
    expect(order(s)).toEqual(["B", "C", "A", "D"]);
    expect(active(s)).toBe("C");
  });

  it("before, from above the active row", () => {
    let s = next(next(base())); // C active
    s = reducer(s, insertActNow({ id: "A", placement: "before" }));
    expect(order(s)).toEqual(["B", "A", "C", "D"]);
    expect(active(s)).toBe("A");
  });

  it("after, from below the active row", () => {
    let s = base(); // A active
    s = reducer(s, insertActNow({ id: "D", placement: "after" }));
    expect(order(s)).toEqual(["A", "D", "B", "C"]);
    expect(active(s)).toBe("A");
  });

  it("is a no-op for the active row itself or an unknown row", () => {
    const s = base();
    expect(reducer(s, insertActNow({ id: "A", placement: "before" }))).toBe(s);
    expect(reducer(s, insertActNow({ id: "nope", placement: "after" }))).toBe(s);
  });
});

describe("removeAllNpcsAndExtras", () => {
  it("with the active NPC removed during a round, the next surviving PC becomes active", () => {
    let s = stacked(
      [row("P1"), row("N1", { type: "NPC" }), row("G1", { type: "GROUP" }), row("P2"), row("N2", { type: "NPC" }), row("P3")],
      ["AS", "KS", "QS", "JS", "10S", "9S"]
    );
    s = run(s, dealRound(), startRound());
    s = next(s); // N1
    expect(active(s)).toBe("N1");
    s = reducer(s, removeAllNpcsAndExtras());
    expect(order(s)).toEqual(["P1", "P2", "P3"]);
    expect(active(s)).toBe("P2");
    expect([...s.deck.inPlay].sort()).toEqual(["AS", "JS", "9S"].sort());
    expectDeckInvariant(s);
  });

  it("removing the last active row leaves nobody active", () => {
    let s = stacked([row("P1"), row("N1", { type: "NPC" })], ["AS", "KS"]);
    s = run(s, dealRound(), startRound());
    s = next(s);
    s = reducer(s, removeAllNpcsAndExtras());
    expect(active(s)).toBeNull();
  });

  it("keeps the active PC active", () => {
    let s = stacked([row("N1", { type: "NPC" }), row("P1"), row("P2")], ["AS", "KS", "QS"]);
    s = run(s, dealRound(), startRound());
    s = next(s);
    expect(active(s)).toBe("P1");
    s = reducer(s, removeAllNpcsAndExtras());
    expect(active(s)).toBe("P1");
  });

  it("an active NPC removed outside a round clears the active row", () => {
    let s = stacked([row("P1"), row("N1", { type: "NPC" })], ["AS", "KS"]);
    s = run(s, dealRound(), setActiveParticipant("N1"));
    s = reducer(s, removeAllNpcsAndExtras());
    expect(active(s)).toBeNull();
    expect(order(s)).toEqual(["P1"]);
  });
});

describe("late joiners across the lifecycle", () => {
  it("setup: no card; cards_dealt: card and full sort; between rounds: no card", () => {
    let s = stacked([row("A")], ["5S", "AS", "KS"]);
    s = reducer(s, createParticipant({ name: "Setup", type: "PC" }));
    expect(s.rows.find((r) => r.name === "Setup")!.currentCardId).toBeUndefined();
    s = reducer(s, dealRound()); // A: 5S, Setup: AS
    s = reducer(s, createParticipant({ name: "Late", type: "NPC" })); // KS
    expect(s.rows.map((r) => r.name)).toEqual(["Setup", "Late", "A"]);
    expect(s.rows.find((r) => r.name === "Late")!.revealed).toBe(false);
    s = run(s, startRound(), endRound());
    s = reducer(s, createParticipant({ name: "Between", type: "PC" }));
    expect(s.rows.find((r) => r.name === "Between")!.currentCardId).toBeUndefined();
    expectDeckInvariant(s);
  });
});
