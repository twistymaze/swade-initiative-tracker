import { describe, expect, it } from "vitest";
import { CURRENT_STATE_VERSION, migrateState, type Migration } from "./migrations";

const v1Row = {
  id: "p-1700000000000-abc123",
  name: "Goblin",
  tokenIds: ["item-1"],
  type: "NPC",
  inactive: false,
  onHold: false,
  revealed: false,
  candidateIds: ["AS"],
  currentCardId: "AS",
  drewThisRound: true,
};
const v1State = { version: 1, round: 1, phase: "cards_dealt", deck: {}, rows: [v1Row], revision: 7 };

describe("migrateState", () => {
  it("migrates v1 to v2: drops tokenIds/drewThisRound, adds writerId, keeps revision", () => {
    const result = migrateState(v1State);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.state.version).toBe(CURRENT_STATE_VERSION);
    expect(result.state.revision).toBe(7);
    expect(result.state.writerId).toBe("");
    const row = (result.state.rows as Record<string, unknown>[])[0];
    expect(row).not.toHaveProperty("tokenIds");
    expect(row).not.toHaveProperty("drewThisRound");
    expect(row.name).toBe("Goblin");
  });

  it("treats a missing version as v1 and does not mutate the input", () => {
    const input = { ...v1State, version: undefined, rows: [{ ...v1Row }] };
    const result = migrateState(input);
    expect(result.kind).toBe("ok");
    expect(input.rows[0]).toHaveProperty("tokenIds");
  });

  it("reports versions above the current one as too-new", () => {
    expect(migrateState({ ...v1State, version: CURRENT_STATE_VERSION + 1 })).toEqual({ kind: "too-new" });
  });

  it("rejects non-integer, zero or string versions", () => {
    for (const version of [0, -1, 1.5, "2", null]) {
      expect(migrateState({ ...v1State, version }).kind).toBe("invalid");
    }
  });

  it("uses the value returned by a pure-style migration", () => {
    const migrations: Record<number, Migration> = {
      2: (s) => ({ ...s, added: "two" }),
      3: (s) => ({ ...s, added: `${s.added}+three` }),
    };
    const result = migrateState({ version: 1 }, migrations, 3);
    expect(result).toEqual({ kind: "ok", state: { version: 3, added: "two+three" } });
  });

  it("is invalid when a step is missing", () => {
    expect(migrateState({ version: 1 }, {}, 2)).toEqual({ kind: "invalid" });
  });
});
