import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("./test/obrMock").then((m) => m.createSdkModule()));
vi.mock("./store/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store/store")>()),
  useSyncStatus: vi.fn(() => ({ status: "ready", loaded: true, bytes: 0, nearLimit: false })),
}));

import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { obr, resetObrMock } from "./test/obrMock";
import { InitiativeTracker } from "./InitiativeTracker";
import { dealCard, makeRow, makeStore, renderWithStore } from "./components/testUtils";
import type { Phase } from "./store/types";

beforeEach(() => {
  resetObrMock();
  localStorage.clear();
});

function storeIn(phase: Phase) {
  return makeStore((s) => {
    s.phase = phase;
    s.round = phase === "setup" ? 0 : 1;
    const dealt = phase === "cards_dealt" || phase === "in_round";
    s.rows = [
      makeRow({ id: "A", name: "Alice", currentCardId: dealt ? dealCard(s, "KS") : undefined }),
      makeRow({ id: "B", name: "Bandit", type: "NPC", revealed: false, currentCardId: dealt ? dealCard(s, "QS") : undefined }),
    ];
    if (phase === "in_round") s.turn.activeRowId = "A";
  });
}

async function renderAs(role: "GM" | "PLAYER", phase: Phase) {
  obr().setRole(role);
  const result = renderWithStore(<InitiativeTracker />, storeIn(phase));
  // Wait for the role read.
  await act(async () => {});
  return result;
}

describe("InitiativeTracker views", () => {
  it("player in setup sees 'Initiative Not Active' and no rows or GM controls", async () => {
    await renderAs("PLAYER", "setup");
    expect(screen.getByText("Initiative Not Active")).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More options" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Initiative" })).not.toBeInTheDocument();
  });

  it("GM in setup sees the rows, header actions and Start Initiative", async () => {
    await renderAs("GM", "setup");
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bandit")).toBeInTheDocument();
    expect(screen.getByText("Not Active")).toBeInTheDocument();
    for (const name of ["Undo", "Disable privacy", "Add combatant", "More options", "Start Initiative"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("player between rounds sees the End of Round message", async () => {
    await renderAs("PLAYER", "between_rounds");
    expect(screen.getByText("End of Round")).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
  });

  it("GM between rounds sees the rows and an End of Round reminder", async () => {
    await renderAs("GM", "between_rounds");
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("End of Round:")).toBeInTheDocument();
  });

  it.each([
    ["GM", "Make card adjustments now"],
    ["PLAYER", "Request card adjustments now"],
  ] as const)("%s after the deal sees the Cards Dealt reminder", async (role, text) => {
    await renderAs(role, "cards_dealt");
    expect(screen.getByText(new RegExp(text))).toBeInTheDocument();
  });

  it("player during a round sees only revealed rows and the round number", async () => {
    await renderAs("PLAYER", "in_round");
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Bandit")).not.toBeInTheDocument();
    expect(screen.getByText("Round 1")).toBeInTheDocument();
  });

  it("switches views when the role changes", async () => {
    await renderAs("PLAYER", "setup");
    expect(screen.getByText("Initiative Not Active")).toBeInTheDocument();
    await act(async () => {
      obr().setRole("GM");
    });
    expect(screen.queryByText("Initiative Not Active")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Initiative" })).toBeInTheDocument();
  });
});

describe("HeaderBar menu", () => {
  it("Remove All NPCs/Extras removes them with an undo checkpoint", async () => {
    const user = userEvent.setup();
    const { store, undoStore } = await renderAs("GM", "setup");
    await user.click(screen.getByRole("button", { name: "More options" }));
    await user.click(within(screen.getByRole("menu")).getByText("Remove All NPCs/Extras"));
    expect(store.getState().swade.rows.map((r) => r.name)).toEqual(["Alice"]);
    expect(undoStore.getUndoDescription()).toBe("Remove All NPCs/Extras");
  });
});
