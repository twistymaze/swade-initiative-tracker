import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));

import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { obr, resetObrMock } from "../test/obrMock";
import { ParticipantList } from "./ParticipantList";
import { dealCard, makeRow, makeStore, renderWithStore } from "./testUtils";
import { BLACK_JOKER_ID, RED_JOKER_ID } from "../utils/cardIds";
import { setEncounterState } from "../store/swadeSlice";

beforeEach(() => {
  resetObrMock();
  localStorage.clear();
});

/** Press Tab until `target` has focus (fails if it is not in the tab order). */
async function tabTo(user: ReturnType<typeof userEvent.setup>, target: HTMLElement) {
  for (let i = 0; i < 50 && document.activeElement !== target; i++) await user.tab();
  expect(target).toHaveFocus();
}

/** In round: A (active, K♠), B (held NPC, hidden), C (Q♥, still to act). Privacy on. */
function inRoundStore() {
  return makeStore((s) => {
    s.phase = "in_round";
    s.round = 1;
    s.settings.hideNpcFromPlayers = true;
    s.rows = [
      makeRow({ id: "A", name: "Alice", currentCardId: dealCard(s, "KS"), candidateIds: ["KS"] }),
      makeRow({ id: "B", name: "Bandit", type: "NPC", onHold: true, revealed: false }),
      makeRow({ id: "C", name: "Cara", currentCardId: dealCard(s, "QH"), candidateIds: ["QH"] }),
    ];
    s.turn.activeRowId = "A";
  });
}

describe("ParticipantRow actions", () => {
  it("GM reaches every row action with Tab and Enter dispatches it", async () => {
    const user = userEvent.setup();
    const { store } = renderWithStore(<ParticipantList role="GM" />, inRoundStore());

    const expectations: [string, () => boolean][] = [
      ["Reveal to Players", () => store.getState().swade.rows.find((r) => r.id === "B")!.revealed],
      ["Mark as Incapacitated", () => store.getState().swade.rows.find((r) => r.id === "B")!.inactive],
    ];
    for (const [name, check] of expectations) {
      const row = screen.getByText("Bandit").closest("li")!;
      const button = Array.from(row.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === name)!;
      expect(button).toBeTruthy();
      await tabTo(user, button);
      await user.keyboard("{Enter}");
      expect(check()).toBe(true);
    }

    const actNow = screen.getByRole("button", { name: "Act Now" });
    await tabTo(user, actNow);
    await user.keyboard("{Enter}");
    expect(store.getState().swade.turn.activeRowId).toBe("B");
  });

  it("shows Lose Turn and both Act Now buttons for a held row that is not active", () => {
    renderWithStore(<ParticipantList role="GM" />, inRoundStore());
    expect(screen.getByRole("button", { name: "Lose Turn (Shaken/Stunned)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Act Now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Act After Current Combatant" })).toBeInTheDocument();
    // Active row can go on hold.
    expect(screen.getByRole("button", { name: "Go on Hold" })).toBeInTheDocument();
  });

  it("with nobody active, Act Now makes the held row act last; there is no Act After", async () => {
    const user = userEvent.setup();
    const store = inRoundStore();
    const state = structuredClone(store.getState().swade);
    state.turn.activeRowId = null;
    act(() => {
      store.dispatch(setEncounterState({ ...state, revision: 2 }));
    });
    renderWithStore(<ParticipantList role="GM" />, store);
    expect(screen.queryByRole("button", { name: "Act After Current Combatant" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Act Now" }));
    const after = store.getState().swade;
    expect(after.rows.map((r) => r.id)).toEqual(["A", "C", "B"]);
    expect(after.turn.activeRowId).toBe("B");
    expect(after.rows[2]).toMatchObject({ onHold: false, revealed: true });
  });

  it("the options button is keyboard reachable and opens the menu", async () => {
    const user = userEvent.setup();
    const { store } = renderWithStore(<ParticipantList role="GM" />, inRoundStore());
    const options = screen.getByRole("button", { name: "Options for Cara" });
    await tabTo(user, options);
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    expect(store.getState().swade.rows.map((r) => r.id)).toEqual(["A", "B"]);
  });

  it("acted Joker has no Act Now or Hold buttons; an unacted Joker has them", () => {
    const store = makeStore((s) => {
      s.phase = "in_round";
      s.round = 1;
      s.rows = [
        makeRow({ id: "J", name: "Joker", currentCardId: dealCard(s, BLACK_JOKER_ID), candidateIds: [BLACK_JOKER_ID] }),
        makeRow({ id: "A", name: "Alice", currentCardId: dealCard(s, "KS"), candidateIds: ["KS"] }),
      ];
      s.turn.activeRowId = "A";
    });
    renderWithStore(<ParticipantList role="GM" />, store);
    expect(screen.queryByRole("button", { name: "Act Now" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Go on Hold" })).toHaveLength(1); // only the active row

    // Same Joker before it has acted (it is below the active row).
    const state = structuredClone(store.getState().swade);
    state.rows = [state.rows[1], state.rows[0]];
    act(() => {
      store.dispatch(setEncounterState({ ...state, revision: 2 }));
    });
    expect(screen.getByRole("button", { name: "Act Now" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Go on Hold" })).toHaveLength(2);
  });

  it("an incapacitated Extra on Hold or with an unacted Joker has no turn buttons (R3-L1)", () => {
    const store = makeStore((s) => {
      s.phase = "in_round";
      s.round = 1;
      s.rows = [
        makeRow({ id: "A", name: "Alice", currentCardId: dealCard(s, "KS"), candidateIds: ["KS"] }),
        makeRow({ id: "H", name: "Held Goons", type: "GROUP", inactive: true, onHold: true }),
        makeRow({
          id: "J",
          name: "Joker Goons",
          type: "GROUP",
          inactive: true,
          currentCardId: dealCard(s, RED_JOKER_ID),
          candidateIds: [RED_JOKER_ID],
        }),
      ];
      s.turn.activeRowId = "A";
    });
    renderWithStore(<ParticipantList role="GM" />, store);
    for (const name of ["Held Goons", "Joker Goons"]) {
      const row = screen.getByText(name).closest("li")!;
      const labels = Array.from(row.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
      expect(labels).toContain("Mark as Active");
      for (const hidden of ["Act Now", "Act After Current Combatant", "Go on Hold", "Clear Hold", "Lose Turn (Shaken/Stunned)"]) {
        expect(labels).not.toContain(hidden);
      }
    }
  });
});

describe("ParticipantRow rename", () => {
  it("Enter saves once with one undo checkpoint", async () => {
    const user = userEvent.setup();
    const { store, undoStore } = renderWithStore(<ParticipantList role="GM" />, inRoundStore());
    const capture = vi.spyOn(undoStore, "captureCheckpoint");
    const dispatch = vi.spyOn(store, "dispatch");

    await user.click(screen.getByRole("button", { name: "Rename Cara" }));
    const input = screen.getByRole("textbox", { name: "Name" });
    await user.clear(input);
    await user.type(input, "Carla{Enter}");

    expect(store.getState().swade.rows.find((r) => r.id === "C")!.name).toBe("Carla");
    expect(dispatch.mock.calls.filter(([a]) => (a as { type: string }).type === "swade/renameParticipant")).toHaveLength(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("Escape cancels the edit", async () => {
    const user = userEvent.setup();
    const { store, undoStore } = renderWithStore(<ParticipantList role="GM" />, inRoundStore());
    const capture = vi.spyOn(undoStore, "captureCheckpoint");

    await user.click(screen.getByRole("button", { name: "Rename Cara" }));
    const input = screen.getByRole("textbox", { name: "Name" });
    await user.clear(input);
    await user.type(input, "Nope{Escape}");

    expect(store.getState().swade.rows.find((r) => r.id === "C")!.name).toBe("Cara");
    expect(capture).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("ParticipantRow rename keeps keyboard focus (R4-A6)", () => {
  it.each([
    ["Enter", "Carla{Enter}", "Rename Carla"],
    ["Escape", "Nope{Escape}", "Rename Cara"],
  ])("%s returns focus to the name button", async (_key, typed, name) => {
    const user = userEvent.setup();
    renderWithStore(<ParticipantList role="GM" />, inRoundStore());
    await user.click(screen.getByRole("button", { name: "Rename Cara" }));
    const input = screen.getByRole("textbox", { name: "Name" });
    await user.clear(input);
    await user.type(input, typed);
    expect(screen.getByRole("button", { name })).toHaveFocus();
  });

  it("Tab to Save name saves and returns focus to the name button", async () => {
    const user = userEvent.setup();
    renderWithStore(<ParticipantList role="GM" />, inRoundStore());
    await user.click(screen.getByRole("button", { name: "Rename Cara" }));
    const input = screen.getByRole("textbox", { name: "Name" });
    await user.clear(input);
    await user.type(input, "Carla");
    await user.tab();
    expect(screen.getByRole("button", { name: "Rename Carla" })).toHaveFocus();
  });

  it("clicking another control does not pull focus back", async () => {
    const user = userEvent.setup();
    renderWithStore(<ParticipantList role="GM" />, inRoundStore());
    await user.click(screen.getByRole("button", { name: "Rename Cara" }));
    await user.click(screen.getByRole("button", { name: "Rename Alice" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Alice");
  });
});

describe("ParticipantList empty state", () => {
  function hiddenOnlyStore() {
    return makeStore((s) => {
      s.phase = "in_round";
      s.round = 1;
      s.settings.hideNpcFromPlayers = true;
      s.rows = [makeRow({ id: "N", name: "Ninja", type: "NPC", revealed: false, currentCardId: dealCard(s, "KS"), candidateIds: ["KS"] })];
      s.turn.activeRowId = null;
    });
  }

  it("a player who sees no rows gets a neutral message (R4-A3)", () => {
    renderWithStore(<ParticipantList role="PLAYER" />, hiddenOnlyStore());
    expect(screen.queryByText(/No combatants added/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Add combatants/)).not.toBeInTheDocument();
    expect(screen.queryByText("Ninja")).not.toBeInTheDocument();
    expect(screen.getByText("Waiting for the GM")).toBeInTheDocument();
  });

  it("the GM with no rows is told to add combatants", () => {
    renderWithStore(<ParticipantList role="GM" />, makeStore());
    expect(screen.getByText("No combatants added")).toBeInTheDocument();
  });
});

describe("ParticipantRow card chip", () => {
  it("is a button for the GM that opens the chooser via ?view=", async () => {
    const user = userEvent.setup();
    renderWithStore(<ParticipantList role="GM" />, inRoundStore());
    await user.click(screen.getByRole("button", { name: "Q♥ — manage cards for Cara" }));
    expect(obr().modal.open).toHaveBeenCalledWith(
      expect.objectContaining({ url: "/?view=card-chooser&participantId=C" })
    );
  });

  it("is not clickable for players, and players see no hidden rows or actions", () => {
    renderWithStore(<ParticipantList role="PLAYER" />, inRoundStore());
    expect(screen.getByText("K♠")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("Bandit")).not.toBeInTheDocument();
  });
});

describe("ParticipantAvatar", () => {
  it("recovers after the image URL changes", () => {
    const store = makeStore((s) => {
      s.rows = [makeRow({ id: "A", name: "Alice", imageUrl: "https://example.com/a.png" })];
    });
    renderWithStore(<ParticipantList role="GM" />, store);
    const img = screen.getByRole("img", { name: "Alice avatar" });
    fireEvent.error(img);
    expect(screen.queryByRole("img", { name: "Alice avatar" })).not.toBeInTheDocument();

    const state = structuredClone(store.getState().swade);
    state.rows[0].imageUrl = "https://example.com/b.png";
    act(() => {
      store.dispatch(setEncounterState({ ...state, revision: 2 }));
    });
    expect(screen.getByRole("img", { name: "Alice avatar" })).toHaveAttribute("src", "https://example.com/b.png");
  });
});

describe("ParticipantRow buttons dispatch their action", () => {
  const rowOf = (store: ReturnType<typeof makeStore>, id: string) => store.getState().swade.rows.find((r) => r.id === id)!;

  it("Go on Hold puts the active row on hold", async () => {
    const user = userEvent.setup();
    const { store, undoStore } = renderWithStore(<ParticipantList role="GM" />, inRoundStore());
    await user.click(screen.getByRole("button", { name: "Go on Hold" }));
    expect(rowOf(store, "A").onHold).toBe(true);
    expect(undoStore.getUndoDescription()).toBe("Go on Hold: Alice");
  });

  it("Lose Turn clears the hold and moves the row above the active row", async () => {
    const user = userEvent.setup();
    const store = inRoundStore();
    const state = structuredClone(store.getState().swade);
    state.rows = [state.rows[0], state.rows[2], state.rows[1]]; // A, C (active), B (held)
    state.turn.activeRowId = "C";
    act(() => {
      store.dispatch(setEncounterState({ ...state, revision: 2 }));
    });
    renderWithStore(<ParticipantList role="GM" />, store);
    await user.click(screen.getByRole("button", { name: "Lose Turn (Shaken/Stunned)" }));
    const after = store.getState().swade;
    expect(after.rows.map((r) => r.id)).toEqual(["A", "B", "C"]);
    expect(rowOf(store, "B")).toMatchObject({ onHold: false, candidateIds: [] });
    expect(after.turn.activeRowId).toBe("C");
  });

  it("Act After places the held row after the active row and keeps the turn", async () => {
    const user = userEvent.setup();
    const { store } = renderWithStore(<ParticipantList role="GM" />, inRoundStore());
    await user.click(screen.getByRole("button", { name: "Act After Current Combatant" }));
    const after = store.getState().swade;
    expect(after.rows.map((r) => r.id)).toEqual(["A", "B", "C"]);
    expect(after.turn.activeRowId).toBe("A");
    expect(rowOf(store, "B")).toMatchObject({ onHold: false, revealed: true });
  });

  it("Change Type from the options menu changes the row type", async () => {
    const user = userEvent.setup();
    const { store, undoStore } = renderWithStore(<ParticipantList role="GM" />, inRoundStore());
    await user.click(screen.getByRole("button", { name: "Options for Bandit" }));
    await user.click(await screen.findByRole("menuitem", { name: "PC" }));
    expect(rowOf(store, "B")).toMatchObject({ type: "PC", revealed: true });
    expect(undoStore.getUndoDescription()).toBe("Change Bandit to PC");
  });
});

describe("Joker chips name their colour (F-L6)", () => {
  function jokerStore() {
    return makeStore((s) => {
      s.phase = "in_round";
      s.round = 1;
      s.rows = [
        makeRow({ id: "J", name: "Jo", currentCardId: dealCard(s, BLACK_JOKER_ID), candidateIds: [BLACK_JOKER_ID] }),
        makeRow({ id: "R", name: "Ray", currentCardId: dealCard(s, RED_JOKER_ID), candidateIds: [RED_JOKER_ID] }),
      ];
      s.turn.activeRowId = "J";
    });
  }

  it("GM chip accessible names include the card (Joker colour) (R2-L2)", () => {
    renderWithStore(<ParticipantList role="GM" />, jokerStore());
    expect(screen.getByRole("button", { name: "Black Joker — manage cards for Jo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Red Joker — manage cards for Ray" })).toBeInTheDocument();
  });

  it("player chips have the colour as a label and tooltip", () => {
    renderWithStore(<ParticipantList role="PLAYER" />, jokerStore());
    expect(screen.getByLabelText("Black Joker")).toHaveAttribute("title", "Black Joker");
    expect(screen.getByLabelText("Red Joker")).toHaveAttribute("title", "Red Joker");
  });
});

describe("undo descriptions use the button words (R4-nit1)", () => {
  /** In round: A active, B held NPC (hidden), C still to act. Privacy on. */
  it.each([
    ["Go on Hold", "Alice", "Go on Hold: Alice"],
    ["Mark as Incapacitated", "Alice", "Mark as Incapacitated: Alice"],
    ["Reveal to Players", "Bandit", "Reveal to Players: Bandit"],
    ["Hide from Players", "Alice", "Hide from Players: Alice"],
    ["Lose Turn (Shaken/Stunned)", "Bandit", "Lose Turn: Bandit"],
    ["Act Now", "Bandit", "Act Now: Bandit"],
    ["Act After Current Combatant", "Bandit", "Act After Current Combatant: Bandit"],
  ])("%s on %s records %j", async (button, name, description) => {
    const user = userEvent.setup();
    const { undoStore } = renderWithStore(<ParticipantList role="GM" />, inRoundStore());
    const rowEl = screen.getByText(name).closest("li")!;
    await user.click(within(rowEl).getByRole("button", { name: button }));
    expect(undoStore.getUndoDescription()).toBe(description);
  });

  it("Clear Hold on the held active row records its button words", async () => {
    const user = userEvent.setup();
    const { undoStore } = renderWithStore(<ParticipantList role="GM" />, inRoundStore());
    const rowEl = screen.getByText("Alice").closest("li")!;
    await user.click(within(rowEl).getByRole("button", { name: "Go on Hold" }));
    await user.click(within(rowEl).getByRole("button", { name: "Clear Hold" }));
    expect(undoStore.getUndoDescription()).toBe("Clear Hold: Alice");
  });

  it("Mark as Active on an incapacitated row records its button words", async () => {
    const user = userEvent.setup();
    const store = inRoundStore();
    const state = structuredClone(store.getState().swade);
    state.rows[2].inactive = true;
    act(() => {
      store.dispatch(setEncounterState({ ...state, revision: 2 }));
    });
    const { undoStore } = renderWithStore(<ParticipantList role="GM" />, store);
    const rowEl = screen.getByText("Cara").closest("li")!;
    await user.click(within(rowEl).getByRole("button", { name: "Mark as Active" }));
    expect(undoStore.getUndoDescription()).toBe("Mark as Active: Cara");
  });
});
