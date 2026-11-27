import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));
vi.mock("../store/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../store/store")>()),
  flushSync: vi.fn(() => Promise.resolve()),
}));
// Default: no background page answers, so the modal dispatches and saves itself (fallback).
vi.mock("../actionChannel", () => ({ sendToBackground: vi.fn(async () => "unavailable") }));
// The fallback settle delay is tested with the real store in saveChanges.test.tsx.
vi.mock("../utils/saveChanges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/saveChanges")>();
  return { ...actual, saveAndSettle: vi.fn((context: string) => actual.saveChanges(context)) };
});

import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { obr, resetObrMock } from "../test/obrMock";
import { flushSync } from "../store/store";
import { getPluginId } from "../getPluginId";
import { AddParticipantModal } from "./AddParticipantModal";
import { CardChooserModal } from "./CardChooserModal";
import { dealCard, makeRow, makeStore, renderWithStore } from "./testUtils";
import type { EncounterState } from "../store/types";
import { endRound, removeParticipant } from "../store/swadeSlice";
import { RED_JOKER_ID } from "../utils/cardIds";
import { sendToBackground, type ModalOp } from "../actionChannel";

const mockedSend = vi.mocked(sendToBackground);

const mockedFlush = vi.mocked(flushSync);
let calls: string[];

beforeEach(() => {
  resetObrMock();
  sessionStorage.clear();
  calls = [];
  mockedSend.mockReset();
  mockedSend.mockImplementation(async () => "unavailable");
  // `as never`: compiles whether flushSync resolves to void or boolean.
  mockedFlush.mockImplementation(async () => {
    calls.push("flush");
    return true as never;
  });
  obr().modal.close.mockImplementation(async () => {
    calls.push("close");
  });
});

afterEach(() => {
  window.history.pushState({}, "", "/");
});

const typesOf = (dispatch: { mock: { calls: unknown[][] } }) =>
  dispatch.mock.calls.map(([a]) => (a as { type: string }).type);

describe("AddParticipantModal", () => {
  it("adds the combatant with an undo checkpoint, flushes, then closes", async () => {
    const user = userEvent.setup();
    const { store, undoStore } = renderWithStore(<AddParticipantModal />);
    await user.type(screen.getByRole("textbox", { name: /name/i }), "  Goblin ");
    await user.click(screen.getByRole("button", { name: "+NPC" }));

    await waitFor(() => expect(calls).toEqual(["flush", "close"]));
    expect(obr().modal.close).toHaveBeenCalledWith(getPluginId("add-participant"));
    expect(store.getState().swade.rows).toMatchObject([{ name: "Goblin", type: "NPC" }]);
    expect(undoStore.getUndoDescription()).toBe("Add Combatant: Goblin");
    expect(undoStore.canUndo()).toBe(true);
  });

  it("Cancel closes without changes or checkpoint", async () => {
    const user = userEvent.setup();
    const { store, undoStore } = renderWithStore(<AddParticipantModal />);
    const before = store.getState().swade;
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(obr().modal.close).toHaveBeenCalled());
    expect(store.getState().swade).toBe(before);
    expect(undoStore.canUndo()).toBe(false);
  });

  it("Enter in the name field adds an NPC (F-L7)", async () => {
    const user = userEvent.setup();
    const { store } = renderWithStore(<AddParticipantModal />);
    await user.type(screen.getByRole("textbox", { name: /name/i }), "Orc{Enter}");
    await waitFor(() => expect(calls).toEqual(["flush", "close"]));
    expect(store.getState().swade.rows).toMatchObject([{ name: "Orc", type: "NPC" }]);
  });

  it("Enter with an empty name does nothing", async () => {
    const user = userEvent.setup();
    const { store } = renderWithStore(<AddParticipantModal />);
    await user.type(screen.getByRole("textbox", { name: /name/i }), "   {Enter}");
    expect(store.getState().swade.rows).toEqual([]);
    expect(mockedFlush).not.toHaveBeenCalled();
  });

  it("a failed save keeps the modal open with an error, and retry works", async () => {
    const user = userEvent.setup();
    mockedFlush.mockImplementationOnce(async () => {
      calls.push("flush");
      return false as never;
    });
    const { store } = renderWithStore(<AddParticipantModal />);
    await user.type(screen.getByRole("textbox", { name: /name/i }), "Orc");
    await user.click(screen.getByRole("button", { name: "+NPC" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save — try again");
    expect(obr().modal.close).not.toHaveBeenCalled();
    expect(store.getState().swade.rows).toHaveLength(1);

    // Retry saves the change already made; it does not add a second row.
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(calls).toEqual(["flush", "flush", "close"]));
    expect(store.getState().swade.rows).toHaveLength(1);
  });

  it("Cancel after a failed save removes the modal's undo checkpoint (R2-L1)", async () => {
    const user = userEvent.setup();
    mockedFlush.mockImplementationOnce(async () => {
      calls.push("flush");
      return false as never;
    });
    const { undoStore } = renderWithStore(<AddParticipantModal />);
    await user.type(screen.getByRole("textbox", { name: /name/i }), "Orc");
    await user.click(screen.getByRole("button", { name: "+NPC" }));
    await screen.findByRole("alert");
    expect(undoStore.canUndo()).toBe(true);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(obr().modal.close).toHaveBeenCalled());
    expect(undoStore.canUndo()).toBe(false);
    expect(sessionStorage.getItem("swade-undo-v2-room-test")).toBeNull();
  });
});

describe("CardChooserModal", () => {
  function chooserStore(mutate?: (s: EncounterState) => void) {
    window.history.pushState({}, "", "/?view=card-chooser&participantId=C");
    return makeStore((s) => {
      s.phase = "cards_dealt";
      s.round = 1;
      s.rows = [makeRow({ id: "C", name: "Cara", currentCardId: dealCard(s, "5H"), candidateIds: ["5H"] })];
      mutate?.(s);
    });
  }

  it("selection follows Undo Last Draw: Confirm keeps the current card", async () => {
    const user = userEvent.setup();
    const { store } = renderWithStore(<CardChooserModal />, chooserStore());
    const dispatch = vi.spyOn(store, "dispatch");

    await user.click(screen.getByRole("button", { name: "Draw additional card" }));
    const drawn = store.getState().swade.rows[0].candidateIds[1];
    expect(drawn).toBeDefined();
    const chips = screen.getAllByRole("button", { pressed: false });
    await user.click(chips.find((c) => c.textContent !== "5♥" && c.className.includes("MuiChip"))!);
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Undo last draw" }));
    expect(store.getState().swade.rows[0].candidateIds).toEqual(["5H"]);

    await user.click(screen.getByRole("button", { name: "Choose Selected Card" }));
    const keeper = dispatch.mock.calls.map(([a]) => a as { type: string; payload: unknown }).find((a) => a.type === "swade/selectKeeperCard");
    expect(keeper?.payload).toEqual({ participantId: "C", cardId: "5H" });
    await waitFor(() => expect(calls).toEqual(["flush", "flush", "flush", "close"]));
  });

  it("Confirm keeps the chosen extra card and discards the original", async () => {
    const user = userEvent.setup();
    const { store, undoStore } = renderWithStore(<CardChooserModal />, chooserStore());
    await user.click(screen.getByRole("button", { name: "Draw additional card" }));
    const drawn = store.getState().swade.rows[0].candidateIds[1];
    const chip = screen.getAllByRole("button").find((b) => b.className.includes("MuiChip") && b.textContent !== "5♥")!;
    await user.click(chip);
    await user.click(screen.getByRole("button", { name: "Choose Selected Card" }));

    const row = store.getState().swade.rows[0];
    expect(row.currentCardId).toBe(drawn);
    expect(store.getState().swade.deck.discard).toContain("5H");
    expect(undoStore.getUndoDescription()).toBe("Choose Card: Cara");
    await waitFor(() => expect(calls).toEqual(["flush", "flush", "close"]));
  });

  it("Cancel discards the extra candidates, flushes, then closes", async () => {
    const user = userEvent.setup();
    const { store } = renderWithStore(<CardChooserModal />, chooserStore());
    const dispatch = vi.spyOn(store, "dispatch");
    await user.click(screen.getByRole("button", { name: "Draw additional card" }));
    await user.click(screen.getByRole("button", { name: "Draw additional card" }));
    const extras = store.getState().swade.rows[0].candidateIds.slice(1);
    expect(extras).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(typesOf(dispatch)).toContain("swade/discardExtraCandidates"));
    const { rows, deck } = store.getState().swade;
    expect(rows[0].candidateIds).toEqual(["5H"]);
    expect(deck.discard).toEqual(expect.arrayContaining(extras));
    expect(deck.remaining.length + deck.inPlay.length + deck.discard.length).toBe(54);
    await waitFor(() => expect(calls).toEqual(["flush", "flush", "flush", "close"]));
  });

  it("'+' is enabled when the deck is empty but the discard pile is not", () => {
    renderWithStore(
      <CardChooserModal />,
      chooserStore((s) => {
        s.deck.discard = s.deck.remaining;
        s.deck.remaining = [];
      })
    );
    expect(screen.getByRole("button", { name: "Draw additional card" })).toBeEnabled();
  });

  it("'+' is disabled when deck and discard pile are both empty", () => {
    renderWithStore(
      <CardChooserModal />,
      chooserStore((s) => {
        s.deck.inPlay = [...s.deck.inPlay, ...s.deck.remaining];
        s.deck.remaining = [];
      })
    );
    expect(screen.getByRole("button", { name: "Draw additional card" })).toBeDisabled();
  });

  it("'+' is disabled between rounds, the same rule as the reducer (R4-nit2)", () => {
    renderWithStore(
      <CardChooserModal />,
      chooserStore((s) => {
        s.phase = "between_rounds";
        s.deck.discard.push(...s.deck.inPlay);
        s.deck.inPlay = [];
        s.rows[0].currentCardId = undefined;
        s.rows[0].candidateIds = [];
      })
    );
    expect(screen.getByRole("button", { name: "Draw additional card" })).toBeDisabled();
  });

  it("End Round while the chooser is open: '+' and Choose turn off, a message shows, Cancel closes (R4-nit2)", async () => {
    const user = userEvent.setup();
    const store = chooserStore((s) => {
      s.phase = "in_round";
      s.turn.activeRowId = "C";
      s.rows[0].candidateIds.push(dealCard(s, "2C"));
    });
    renderWithStore(<CardChooserModal />, store);
    expect(screen.getByRole("button", { name: "Draw additional card" })).toBeEnabled();
    act(() => {
      store.dispatch(endRound(1));
    });
    expect(screen.getByRole("button", { name: "Draw additional card" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose Selected Card" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Undo last draw" })).not.toBeInTheDocument();
    expect(screen.getByText("The round has ended. Cards can be drawn after the next deal.")).toBeInTheDocument();
    const before = store.getState().swade;
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls).toContain("close"));
    expect(store.getState().swade).toBe(before);
  });

  it("shows a message and a Close button when the row no longer exists (F-L5)", async () => {
    const user = userEvent.setup();
    const store = chooserStore();
    renderWithStore(<CardChooserModal />, store);
    act(() => {
      store.dispatch(removeParticipant("C"));
    });
    expect(screen.getByText("This combatant no longer exists.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(obr().modal.close).toHaveBeenCalledWith(getPluginId("card-chooser"));
  });

  it("a failed save keeps the chooser open with an error", async () => {
    const user = userEvent.setup();
    mockedFlush.mockImplementationOnce(async () => {
      calls.push("flush");
      return false as never;
    });
    renderWithStore(<CardChooserModal />, chooserStore());
    await user.click(screen.getByRole("button", { name: "Choose Selected Card" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save — try again");
    expect(obr().modal.close).not.toHaveBeenCalled();
    // Cancel still works after a failure.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls).toEqual(["flush", "flush", "close"]));
  });

  it("Choose with only the original card changes nothing and records no undo step (R4-A1)", async () => {
    const user = userEvent.setup();
    const store = chooserStore();
    const { undoStore } = renderWithStore(<CardChooserModal />, store);
    const before = store.getState().swade;
    await user.click(screen.getByRole("button", { name: "Choose Selected Card" }));
    await waitFor(() => expect(calls).toEqual(["flush", "close"]));
    expect(store.getState().swade).toBe(before);
    expect(undoStore.canUndo()).toBe(false);
  });

  it("many extra draws wrap, so '+' and Undo Last Draw stay reachable (R4-A2)", () => {
    const extras = ["2C", "3C", "4C", "5C", "6C", "7C", "8C", "9C"];
    renderWithStore(
      <CardChooserModal />,
      chooserStore((s) => {
        for (const id of extras) s.rows[0].candidateIds.push(dealCard(s, id));
      })
    );
    const draw = screen.getByRole("button", { name: "Draw additional card" });
    const undo = screen.getByRole("button", { name: "Undo last draw" });
    const row = screen.getByTestId("candidate-cards");
    expect(row).toContainElement(draw);
    expect(row).toContainElement(undo);
    expect(getComputedStyle(row).flexWrap).toBe("wrap");
    // The card area scrolls instead of clipping when the wrapped rows get tall.
    expect(getComputedStyle(screen.getByTestId("chooser-body")).overflowY).toBe("auto");
  });

  it("draw tooltips never take clicks: Cancel right after hovering '+' discards (real-room bug)", async () => {
    const user = userEvent.setup();
    const store = chooserStore((s) => {
      s.rows[0].candidateIds.push(dealCard(s, "2C"));
    });
    // Spy before render: hovering re-renders only the tooltip, not the modal's dispatch.
    const dispatch = vi.spyOn(store, "dispatch");
    renderWithStore(<CardChooserModal />, store);

    await user.hover(screen.getByRole("button", { name: "Draw additional card" }));
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("Draw Additional Card");
    expect(tip).not.toHaveClass("MuiTooltip-popperInteractive");
    expect(getComputedStyle(tip).pointerEvents).toBe("none");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(typesOf(dispatch)).toContain("swade/discardExtraCandidates"));
    await waitFor(() => expect(calls).toContain("close"));
  });

  it("draw tooltips close on click", async () => {
    const user = userEvent.setup();
    renderWithStore(
      <CardChooserModal />,
      chooserStore((s) => {
        s.rows[0].candidateIds.push(dealCard(s, "2C"));
      })
    );
    const undo = screen.getByRole("button", { name: "Undo last draw" });
    await user.hover(undo);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Undo Last Draw");
    await user.click(undo);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("a Joker candidate is named by colour", () => {
    renderWithStore(
      <CardChooserModal />,
      chooserStore((s) => {
        s.rows[0].candidateIds.push(dealCard(s, RED_JOKER_ID));
      })
    );
    expect(screen.getByRole("button", { name: "Red Joker" })).toBeInTheDocument();
  });
});

describe("modals with a background page", () => {
  const sent = () => mockedSend.mock.calls.map(([op]) => op as ModalOp);

  it("Add Combatant sends the add to the background and closes once it is saved", async () => {
    mockedSend.mockImplementation(async () => "saved");
    const user = userEvent.setup();
    const { store, undoStore } = renderWithStore(<AddParticipantModal />);
    await user.type(screen.getByRole("textbox", { name: /name/i }), "Goblin");
    await user.click(screen.getByRole("button", { name: "+PC" }));

    await waitFor(() => expect(calls).toEqual(["close"]));
    expect(sent()).toEqual([
      {
        op: "dispatch",
        description: "Add Combatant: Goblin",
        actions: [{ type: "swade/createParticipant", payload: { name: "Goblin", type: "PC", id: expect.any(String) }, meta: { seed: expect.any(Number) } }],
      },
    ]);
    // The background dispatches it; the modal neither changes its store nor writes.
    expect(store.getState().swade.rows).toEqual([]);
    expect(undoStore.canUndo()).toBe(false);
    expect(mockedFlush).not.toHaveBeenCalled();
  });

  it("a failed background save shows the error; Try again only saves, Cancel takes the row back", async () => {
    mockedSend.mockImplementation(async () => "failed");
    const user = userEvent.setup();
    renderWithStore(<AddParticipantModal />);
    await user.type(screen.getByRole("textbox", { name: /name/i }), "Orc");
    await user.click(screen.getByRole("button", { name: "+NPC" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save — try again");
    expect(obr().modal.close).not.toHaveBeenCalled();
    const rowId = (sent()[0] as unknown as { actions: { payload: { id: string } }[] }).actions[0].payload.id;

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toEqual({ op: "dispatch", description: "", actions: [] });
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    mockedSend.mockImplementation(async () => "saved");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(obr().modal.close).toHaveBeenCalled());
    expect(sent()[2]).toEqual({ op: "cancel-add", rowId });
  });

  it("Try again closes the modal when the background then saves", async () => {
    mockedSend.mockImplementationOnce(async () => "failed").mockImplementation(async () => "saved");
    const user = userEvent.setup();
    renderWithStore(<AddParticipantModal />);
    await user.type(screen.getByRole("textbox", { name: /name/i }), "Orc{Enter}");
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(calls).toEqual(["close"]));
  });

  it("card chooser: draws and Confirm go to the background; a failed save shows the error", async () => {
    window.history.pushState({}, "", "/?view=card-chooser&participantId=C");
    const store = makeStore((s) => {
      s.phase = "cards_dealt";
      s.round = 1;
      s.rows = [makeRow({ id: "C", name: "Cara", currentCardId: dealCard(s, "5H"), candidateIds: ["5H"] })];
    });
    mockedSend.mockImplementation(async () => "saved");
    const user = userEvent.setup();
    renderWithStore(<CardChooserModal />, store);

    await user.click(screen.getByRole("button", { name: "Draw additional card" }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ op: "dispatch", description: "Draw Card: Cara", actions: [{ type: "swade/addCandidateCard", payload: "C", meta: { seed: expect.any(Number) } }] });
    expect(store.getState().swade.rows[0].candidateIds).toEqual(["5H"]); // arrives with the room echo

    mockedSend.mockImplementation(async () => "failed");
    await user.click(screen.getByRole("button", { name: "Choose Selected Card" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save — try again");
    expect(sent()[1]).toMatchObject({ description: "Choose Card: Cara", actions: [{ type: "swade/selectKeeperCard", payload: { participantId: "C", cardId: "5H" } }] });
    expect(obr().modal.close).not.toHaveBeenCalled();

    mockedSend.mockImplementation(async () => "saved");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls).toEqual(["close"]));
    expect(sent()[2]).toMatchObject({ actions: [{ type: "swade/discardExtraCandidates", payload: "C" }] });
    expect(mockedFlush).not.toHaveBeenCalled();
  });
});

describe("review 7 (modal save paths)", () => {
  const failNextFlush = () =>
    mockedFlush.mockImplementationOnce(async () => {
      calls.push("flush");
      return false as never;
    });

  it("S3: fallback Cancel after a failed save takes the row back and saves that before closing", async () => {
    const user = userEvent.setup();
    failNextFlush(); // e.g. the first write landed, the settle save failed
    const { store, undoStore } = renderWithStore(<AddParticipantModal />);
    await user.type(screen.getByRole("textbox", { name: /name/i }), "Orc{Enter}");
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls).toEqual(["flush", "flush", "close"]));
    expect(store.getState().swade.rows).toEqual([]);
    expect(undoStore.canUndo()).toBe(false);
  });

  it("S3: a fallback Cancel whose save fails keeps the modal open", async () => {
    const user = userEvent.setup();
    failNextFlush();
    renderWithStore(<AddParticipantModal />);
    await user.type(screen.getByRole("textbox", { name: /name/i }), "Orc{Enter}");
    await screen.findByRole("alert");
    failNextFlush();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls).toEqual(["flush", "flush"]));
    expect(obr().modal.close).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("S5: a cancel-add the background rejects keeps the modal open", async () => {
    mockedSend.mockImplementationOnce(async () => "failed").mockImplementationOnce(async () => "unavailable");
    const user = userEvent.setup();
    renderWithStore(<AddParticipantModal />);
    await user.type(screen.getByRole("textbox", { name: /name/i }), "Orc{Enter}");
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mockedSend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    expect(obr().modal.close).not.toHaveBeenCalled();

    mockedSend.mockImplementation(async () => "saved");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(obr().modal.close).toHaveBeenCalled());
  });

  it("S4: a fallback draw is written at once (a backdrop close cannot drop it)", async () => {
    window.history.pushState({}, "", "/?view=card-chooser&participantId=C");
    const store = makeStore((s) => {
      s.phase = "cards_dealt";
      s.round = 1;
      s.rows = [makeRow({ id: "C", name: "Cara", currentCardId: dealCard(s, "5H"), candidateIds: ["5H"] })];
    });
    const user = userEvent.setup();
    renderWithStore(<CardChooserModal />, store);
    await user.click(screen.getByRole("button", { name: "Draw additional card" }));
    await waitFor(() => expect(calls).toEqual(["flush"]));
    expect(store.getState().swade.rows[0].candidateIds).toHaveLength(2);
  });
});
