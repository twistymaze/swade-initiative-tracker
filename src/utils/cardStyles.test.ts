import { describe, expect, it } from "vitest";
import { createTheme } from "@mui/material/styles";
import { getBaseCardStyle, getCardColor } from "./cardStyles";
import { BLACK_JOKER_ID, RED_JOKER_ID } from "./cardIds";

const theme = createTheme();

describe("cardStyles", () => {
  it("colours hearts and diamonds red, spades and clubs black", () => {
    expect(getCardColor("AH")).toBe("red");
    expect(getCardColor("10D")).toBe("red");
    expect(getCardColor("KS")).toBe("black");
    expect(getCardColor("2C")).toBe("black");
  });

  it("colours the Red Joker red and the Black Joker black", () => {
    expect(getCardColor(RED_JOKER_ID)).toBe("red");
    expect(getCardColor(BLACK_JOKER_ID)).toBe("black");
  });

  it("falls back to black for an unknown card", () => {
    expect(getCardColor("nope")).toBe("black");
  });

  it("getBaseCardStyle returns a white card with the colour and theme divider border", () => {
    const style = getBaseCardStyle("QH", theme);
    expect(style.color).toBe("red");
    expect(style.bgcolor).toBe("white");
    expect(style.border).toBe(`1px solid ${theme.palette.divider}`);
    expect(getBaseCardStyle(BLACK_JOKER_ID, theme).color).toBe("black");
  });
});
