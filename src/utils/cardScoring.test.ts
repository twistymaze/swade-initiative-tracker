import { describe, expect, it } from "vitest";
import { getCardScore } from "./cardScoring";
import { BLACK_JOKER_ID, RED_JOKER_ID, generateAllCardIds } from "./cardIds";

describe("getCardScore", () => {
  it("orders Jokers > Aces > lower ranks, and Spades > Hearts > Diamonds > Clubs", () => {
    expect(getCardScore(BLACK_JOKER_ID)).toBeGreaterThan(getCardScore(RED_JOKER_ID));
    expect(getCardScore(RED_JOKER_ID)).toBeGreaterThan(getCardScore("AS"));
    expect(getCardScore("AC")).toBeGreaterThan(getCardScore("KS"));
    expect(getCardScore("10S")).toBeGreaterThan(getCardScore("10H"));
    expect(getCardScore("10H")).toBeGreaterThan(getCardScore("10D"));
    expect(getCardScore("10D")).toBeGreaterThan(getCardScore("10C"));
    expect(getCardScore("3C")).toBeGreaterThan(getCardScore("2S"));
  });

  it("gives every one of the 54 cards a distinct positive score (strict total order)", () => {
    const scores = generateAllCardIds().map(getCardScore);
    expect(scores).toHaveLength(54);
    expect(new Set(scores).size).toBe(54);
    expect(scores.every((s) => s > 0)).toBe(true);
  });

  it("sorts the full deck into the expected SWADE order", () => {
    const sorted = [...generateAllCardIds()].sort((a, b) => getCardScore(b) - getCardScore(a));
    expect(sorted.slice(0, 6)).toEqual([BLACK_JOKER_ID, RED_JOKER_ID, "AS", "AH", "AD", "AC"]);
    expect(sorted.slice(-4)).toEqual(["2S", "2H", "2D", "2C"]);
  });

  it("returns -1 for no card and 0 for an unknown card", () => {
    expect(getCardScore(undefined)).toBe(-1);
    expect(getCardScore("")).toBe(-1);
    expect(getCardScore("ZZ")).toBe(0);
  });
});
