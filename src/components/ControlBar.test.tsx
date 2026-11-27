import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetObrMock } from "../test/obrMock";
import { ControlBar } from "./ControlBar";
import { dealCard, makeRow, makeStore, renderWithStore } from "./testUtils";
import type { EncounterState, Phase } from "../store/types";

beforeEach(() => {
  resetObrMock();
  localStorage.clear();
});

function storeIn(phase: Phase, patch: (s: EncounterState) => void = () => {}) {
  return makeStore((s) => {
    s.phase = phase;
    s.round = phase === "setup" ? 0 : 2;
    s.rows = [
      makeRow({ id: "A", name: "Alice", currentCardId: phase === "setup" || phase === "between_rounds" ? undefined : dealCard(s, "KS") }),
      makeRow({ id: "B", name: "Bob", currentCardId: phase === "setup" || phase === "between_rounds" ? undefined : dealCard(s, "QS") }),
    ];
    if (phase === "in_round") s.turn.activeRowId = "A";
    patch(s);
  });
}

const buttonNames = () => screen.queryAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);

describe("ControlBar enablement", () => {
  it.each([
    ["setup", ["Start Initiative"]],
    ["cards_dealt", ["Start Round"]],
    ["in_round", ["Previous turn", "Next turn", "End Round"]],
    ["between_rounds", ["End Initiative", "Deal Cards"]],
  ] as const)("GM in %s sees %j", (phase, expected) => {
    renderWithStore(<ControlBar role="GM" />, storeIn(phase));
    expect(buttonNames()).toEqual(expected);
  });

  it.each(["setup", "cards_dealt", "in_round", "between_rounds"] as const)("a player in %s sees no controls", (phase) => {
    const { container } = renderWithStore(<ControlBar role="PLAYER" />, storeIn(phase));
    expect(container).toBeEmptyDOMElement();
  });

  it("with no role (not yet known) nothing is shown", () => {
    const { container } = renderWithStore(<ControlBar />, storeIn("setup"));
    expect(container).toBeEmptyDOMElement();
  });

  it("Start Initiative is disabled without combatants", () => {
    renderWithStore(<ControlBar role="GM" />, storeIn("setup", (s) => (s.rows = [])));
    expect(screen.getByRole("button", { name: "Start Initiative" })).toBeDisabled();
  });

  it("Previous is disabled on the first row and Next on the last", () => {
    renderWithStore(<ControlBar role="GM" />, storeIn("in_round"));
    expect(screen.getByRole("button", { name: "Previous turn" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next turn" })).toBeEnabled();
  });
});

describe("ControlBar actions", () => {
  it("runs a whole round with one undo checkpoint per click", async () => {
    const user = userEvent.setup();
    const { store, undoStore } = renderWithStore(<ControlBar role="GM" />, storeIn("setup"));
    const swade = () => store.getState().swade;

    await user.click(screen.getByRole("button", { name: "Start Initiative" }));
    expect(swade()).toMatchObject({ phase: "cards_dealt", round: 1 });
    expect(undoStore.getUndoDescription()).toBe("Start Initiative");

    await user.click(screen.getByRole("button", { name: "Start Round" }));
    expect(swade().phase).toBe("in_round");
    const first = swade().turn.activeRowId!;
    const second = swade().rows.find((r) => r.id !== first)!;

    await user.click(screen.getByRole("button", { name: "Next turn" }));
    expect(swade().turn.activeRowId).toBe(second.id);
    expect(undoStore.getUndoDescription()).toBe(`Next Turn: ${second.name}`);
    expect(screen.getByRole("button", { name: "Next turn" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Previous turn" }));
    expect(swade().turn.activeRowId).toBe(first);

    await user.click(screen.getByRole("button", { name: "End Round" }));
    expect(swade().phase).toBe("between_rounds");

    await user.click(screen.getByRole("button", { name: "Deal Cards" }));
    expect(swade()).toMatchObject({ phase: "cards_dealt", round: 2 });
    expect(undoStore.getUndoDescription()).toBe("Deal Cards");
  });

  it("End Initiative returns to setup", async () => {
    const user = userEvent.setup();
    const { store, undoStore } = renderWithStore(<ControlBar role="GM" />, storeIn("between_rounds"));
    await user.click(screen.getByRole("button", { name: "End Initiative" }));
    expect(store.getState().swade).toMatchObject({ phase: "setup", round: 0 });
    expect(undoStore.getUndoDescription()).toBe("End Initiative");
  });

  it("Next skips a held row", async () => {
    const user = userEvent.setup();
    const store = storeIn("in_round", (s) => {
      s.rows.push(makeRow({ id: "C", name: "Cara", currentCardId: dealCard(s, "2C") }));
      s.rows[1].onHold = true;
    });
    renderWithStore(<ControlBar role="GM" />, store);
    await user.click(screen.getByRole("button", { name: "Next turn" }));
    expect(store.getState().swade.turn.activeRowId).toBe("C");
  });
});
