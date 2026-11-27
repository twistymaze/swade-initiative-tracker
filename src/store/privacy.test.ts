// Privacy matrix: role × privacy setting × revealed flag, including reveal on activation.
import { describe, expect, it } from "vitest";
import reducer, { dealRound, insertActNow, setActiveParticipant, setHold, setPrivacy, startRound, endRound, endInitiative, setRevealed } from "./swadeSlice";
import { selectDeckCountsForRole, selectVisibleParticipants } from "./selectors";
import { initializeEmptyState } from "./initialState";
import type { RootState } from "./store";
import type { EncounterState, ParticipantRow, ParticipantType } from "./types";
import type { UnknownAction } from "@reduxjs/toolkit";

type Role = "GM" | "PLAYER";
const row = (id: string, type: ParticipantType, revealed: boolean): ParticipantRow => ({
  id,
  name: id,
  type,
  inactive: false,
  onHold: false,
  revealed,
  candidateIds: [],
});

const root = (swade: EncounterState) => ({ swade }) as RootState;
const visibleIds = (s: EncounterState, role: Role) => selectVisibleParticipants(root(s), role).map((r) => r.id);
const run = (s: EncounterState, ...actions: UnknownAction[]) => actions.reduce(reducer, s);

describe("visibility matrix", () => {
  const cases: [Role, boolean, ParticipantType, boolean, boolean][] = [];
  for (const role of ["GM", "PLAYER"] as Role[])
    for (const privacy of [true, false])
      for (const type of ["PC", "NPC", "GROUP"] as ParticipantType[])
        for (const revealed of [true, false]) {
          const visible = role === "GM" || !privacy || revealed;
          cases.push([role, privacy, type, revealed, visible]);
        }

  it.each(cases)("role %s, privacy %s, %s revealed=%s → visible %s", (role, privacy, type, revealed, visible) => {
    const s = initializeEmptyState();
    s.settings.hideNpcFromPlayers = privacy;
    s.rows = [row("x", type, revealed)];
    expect(visibleIds(s, role)).toEqual(visible ? ["x"] : []);
  });
});

describe("reveal by play", () => {
  function encounter(privacy = true): EncounterState {
    const s = initializeEmptyState();
    s.settings.hideNpcFromPlayers = privacy;
    s.rows = [row("pc", "PC", true), row("npc", "NPC", false), row("grp", "GROUP", false)];
    return s;
  }

  it("rows are revealed to players as they become active and stay revealed this round", () => {
    let s = run(encounter(), dealRound());
    expect(visibleIds(s, "PLAYER")).toEqual(["pc"]);
    s = reducer(s, startRound());
    const firstActive = s.turn.activeRowId!;
    expect(visibleIds(s, "PLAYER")).toContain(firstActive);

    for (const r of s.rows) s = reducer(s, setActiveParticipant(r.id));
    expect(visibleIds(s, "PLAYER").sort()).toEqual(["grp", "npc", "pc"]);
    expect(visibleIds(s, "GM").sort()).toEqual(["grp", "npc", "pc"]);
  });

  it("the next deal hides NPCs and Extras again, but not PCs", () => {
    let s = run(encounter(), dealRound(), startRound());
    for (const r of s.rows) s = reducer(s, setActiveParticipant(r.id));
    s = run(s, endRound(), dealRound());
    expect(visibleIds(s, "PLAYER")).toEqual(["pc"]);
  });

  it("with privacy off nothing is re-hidden on deal", () => {
    const s = run(encounter(false), setRevealed({ id: "npc", value: true }), dealRound());
    expect(s.rows.find((r) => r.id === "npc")!.revealed).toBe(true);
    expect(visibleIds(s, "PLAYER").sort()).toEqual(["grp", "npc", "pc"]);
  });

  it("a held hidden row stays hidden when made active, and is revealed by Act Now", () => {
    let s = run(encounter(), dealRound(), setHold({ id: "npc", value: true }), startRound());
    s = reducer(s, setActiveParticipant("npc"));
    expect(visibleIds(s, "PLAYER")).not.toContain("npc");
    s = reducer(s, setActiveParticipant("pc"));
    s = reducer(s, insertActNow({ id: "npc", placement: "after" }));
    expect(visibleIds(s, "PLAYER")).toContain("npc");
  });

  it("endInitiative re-hides NPCs only while privacy is on", () => {
    let s = run(encounter(), dealRound(), startRound());
    for (const r of s.rows) s = reducer(s, setActiveParticipant(r.id));
    expect(visibleIds(run(s, endRound(), endInitiative()), "PLAYER")).toEqual(["pc"]);
    expect(visibleIds(run(s, setPrivacy(false), endRound(), endInitiative()), "PLAYER").sort()).toEqual(["grp", "npc", "pc"]);
  });

  it("turning privacy on later hides rows that were never revealed", () => {
    const s = run(encounter(false), setPrivacy(true));
    expect(visibleIds(s, "PLAYER")).toEqual(["pc"]);
  });
});

describe("deck counts matrix", () => {
  it.each([
    ["GM", true, true],
    ["GM", false, true],
    ["PLAYER", true, false],
    ["PLAYER", false, true],
  ] as const)("role %s, privacy %s → full counts %s", (role, privacy, full) => {
    const s = initializeEmptyState();
    s.settings.hideNpcFromPlayers = privacy;
    const counts = selectDeckCountsForRole(root(s), role);
    if (full) expect(counts).toMatchObject({ remaining: 54, inPlay: 0, discard: 0, total: 54 });
    else expect(counts).toBeNull();
  });
});

describe("privacy turned on mid-round (R3L-S1)", () => {
  it("rows already revealed stay visible; unrevealed NPCs and Extras are hidden until they act", () => {
    // Privacy off: rows are still marked revealed as they become active.
    let s = initializeEmptyState();
    s.settings.hideNpcFromPlayers = false;
    s.rows = [row("npc1", "NPC", false), row("pc", "PC", true), row("npc2", "NPC", false), row("grp", "GROUP", false)];
    s = run(s, dealRound(1), startRound());
    const order = s.rows.map((r) => r.id);
    const firstNpc = order.find((id) => id !== "pc")!;
    // Walk to the first NPC/Extra in turn order, so it has been seen.
    s = reducer(s, setActiveParticipant(firstNpc));
    const unseen = order.filter((id) => id !== "pc" && id !== firstNpc);
    expect(visibleIds(s, "PLAYER").sort()).toEqual([...order].sort());

    s = reducer(s, setPrivacy(true));
    expect(visibleIds(s, "PLAYER").sort()).toEqual(["pc", firstNpc].sort());
    for (const id of unseen) expect(s.rows.find((r) => r.id === id)!.revealed).toBe(false);
    expect(visibleIds(s, "GM").sort()).toEqual([...order].sort());

    // An unseen row is revealed when its turn comes.
    s = reducer(s, setActiveParticipant(unseen[0]));
    expect(visibleIds(s, "PLAYER")).toContain(unseen[0]);
    expect(visibleIds(s, "PLAYER")).toContain(firstNpc);

    // The next deal hides every NPC and Extra again.
    s = run(s, endRound(2), dealRound(3));
    expect(visibleIds(s, "PLAYER")).toEqual(["pc"]);
  });
});
