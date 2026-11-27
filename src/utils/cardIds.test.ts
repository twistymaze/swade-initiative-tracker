import { describe, expect, it } from "vitest";
import {
  BLACK_JOKER_ID,
  RED_JOKER_ID,
  buildCardsLookup,
  getCardName,
  generateAllCardIds,
  getCardId,
  isJokerId,
} from "./cardIds";

describe("cardIds", () => {
  it("generateAllCardIds returns 54 unique IDs including both Jokers", () => {
    const ids = generateAllCardIds();
    expect(ids).toHaveLength(54);
    expect(new Set(ids).size).toBe(54);
    expect(ids).toContain(RED_JOKER_ID);
    expect(ids).toContain(BLACK_JOKER_ID);
    expect(ids).toContain("10H");
  });

  it("getCardId builds rank+suit and Joker IDs", () => {
    expect(getCardId("A", "S")).toBe("AS");
    expect(getCardId("10", "D")).toBe("10D");
    expect(getCardId("JOKER", undefined, "RED")).toBe(RED_JOKER_ID);
    expect(getCardId("JOKER", undefined, "BLACK")).toBe(BLACK_JOKER_ID);
  });

  it("isJokerId is true only for the two Jokers", () => {
    expect(isJokerId(RED_JOKER_ID)).toBe(true);
    expect(isJokerId(BLACK_JOKER_ID)).toBe(true);
    expect(isJokerId("JS")).toBe(false);
    expect(isJokerId("AS")).toBe(false);
    expect(isJokerId(undefined)).toBe(false);
    expect(isJokerId(null)).toBe(false);
  });

  it("buildCardsLookup has an entry for every card ID with labels", () => {
    const lookup = buildCardsLookup();
    for (const id of generateAllCardIds()) {
      expect(lookup[id].id).toBe(id);
    }
    expect(lookup["QH"]).toMatchObject({ rank: "Q", suit: "H", label: "Q♥" });
    expect(lookup[RED_JOKER_ID]).toMatchObject({ rank: "JOKER", jokerColor: "RED", label: "Joker" });
    expect(lookup[BLACK_JOKER_ID]).toMatchObject({ rank: "JOKER", jokerColor: "BLACK" });
  });

  it("getCardName names the Jokers by colour (F-L6)", () => {
    expect(getCardName(RED_JOKER_ID)).toBe("Red Joker");
    expect(getCardName(BLACK_JOKER_ID)).toBe("Black Joker");
    expect(getCardName("QH")).toBe("Q♥");
    expect(getCardName("nope")).toBe("nope");
  });
});
