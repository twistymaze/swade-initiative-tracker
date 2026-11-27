import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));
vi.mock("../store/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../store/store")>()),
  useSyncStatus: vi.fn(() => ({ status: "ready", loaded: true, bytes: 0, nearLimit: false })),
}));

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { obr, resetObrMock } from "../test/obrMock";
import { useSyncStatus } from "../store/store";
import type { SyncSnapshot } from "../store/syncEngine";
import { setHold } from "../store/swadeSlice";
import { HeaderBar } from "./HeaderBar";
import { dealCard, makeRow, makeStore, renderWithStore } from "./testUtils";

const mockedSyncStatus = vi.mocked(useSyncStatus);
const snapshot = (patch: Partial<SyncSnapshot>): SyncSnapshot => ({ status: "ready", loaded: true, bytes: 0, nearLimit: false, ...patch });

beforeEach(() => {
  resetObrMock();
  localStorage.clear();
  mockedSyncStatus.mockReturnValue(snapshot({}));
});

function dealtStore(privacy: boolean) {
  return makeStore((s) => {
    s.phase = "cards_dealt";
    s.round = 1;
    s.settings.hideNpcFromPlayers = privacy;
    s.rows = [
      makeRow({ id: "A", name: "Alice", currentCardId: dealCard(s, "KS"), candidateIds: ["KS"] }),
      makeRow({ id: "B", name: "Bandit", type: "NPC", revealed: false, currentCardId: dealCard(s, "2C"), candidateIds: ["2C"] }),
    ];
  });
}

describe("HeaderBar deck counts", () => {
  it("GM sees all counts", () => {
    renderWithStore(<HeaderBar role="GM" />, dealtStore(true));
    expect(screen.getByText("Deck: 52R • 2P • 0D")).toBeInTheDocument();
  });

  it("player with privacy on sees no deck counts (F-L2)", () => {
    renderWithStore(<HeaderBar role="PLAYER" />, dealtStore(true));
    expect(screen.queryByText(/Deck:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("player with privacy off sees all counts", () => {
    renderWithStore(<HeaderBar role="PLAYER" />, dealtStore(false));
    expect(screen.getByText("Deck: 52R • 2P • 0D")).toBeInTheDocument();
  });
});

describe("HeaderBar Full Reset", () => {
  it("Cancel closes the dialog and the menu without changes", async () => {
    const user = userEvent.setup();
    const { store } = renderWithStore(<HeaderBar role="GM" />, dealtStore(true));
    const before = store.getState().swade;

    await user.click(screen.getByRole("button", { name: "More options" }));
    await user.click(screen.getByRole("menuitem", { name: "Full Reset" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(store.getState().swade).toBe(before);
  });

  it("Confirm resets the tracker and clears undo history", async () => {
    const user = userEvent.setup();
    const { store, undoStore } = renderWithStore(<HeaderBar role="GM" />, dealtStore(true));
    // Make one undoable change first.
    undoStore.captureCheckpoint("Hold: Alice");
    store.dispatch(setHold({ id: "A", value: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^undo/i, hidden: true })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "More options" }));
    await user.click(screen.getByRole("menuitem", { name: "Full Reset" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset" }));

    const state = store.getState().swade;
    expect(state.rows).toEqual([]);
    expect(state.phase).toBe("setup");
    expect(state.writerId).toBe("me");
    expect(undoStore.canUndo()).toBe(false);
    expect(screen.getByRole("button", { name: /^undo/i, hidden: true })).toBeDisabled();
  });
});

describe("HeaderBar actions", () => {
  it("Add combatant opens the modal via ?view= without an undo checkpoint", async () => {
    const user = userEvent.setup();
    const { undoStore } = renderWithStore(<HeaderBar role="GM" />, dealtStore(true));
    const capture = vi.spyOn(undoStore, "captureCheckpoint");
    await user.click(screen.getByRole("button", { name: "Add combatant" }));
    expect(obr().modal.open).toHaveBeenCalledWith(expect.objectContaining({ url: "/?view=add-participant" }));
    expect(capture).not.toHaveBeenCalled();
  });

  it("privacy toggle dispatches with a checkpoint", async () => {
    const user = userEvent.setup();
    const { store } = renderWithStore(<HeaderBar role="GM" />, dealtStore(true));
    await user.click(screen.getByRole("button", { name: "Disable privacy" }));
    expect(store.getState().swade.settings.hideNpcFromPlayers).toBe(false);
    expect(screen.getByRole("button", { name: "Enable privacy" })).toBeInTheDocument();
  });
});

describe("HeaderBar privacy tooltip", () => {
  it("closes when the toggle is clicked and stays closed after the mouse leaves", async () => {
    const user = userEvent.setup();
    renderWithStore(<HeaderBar role="GM" />, dealtStore(false));
    const toggle = screen.getByRole("button", { name: "Enable privacy" });
    await user.hover(toggle);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Show all combatants to players");

    await user.click(toggle);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    await user.unhover(toggle);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    // Hovering again shows the new title.
    await user.hover(screen.getByRole("button", { name: "Disable privacy" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Hide NPCs by default from players");
  });
});

describe("SyncIndicator", () => {
  it("shows nothing when saved", () => {
    renderWithStore(<HeaderBar role="GM" />, dealtStore(true));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows 'Not saved – retry' on error", () => {
    mockedSyncStatus.mockReturnValue(snapshot({ status: "error" }));
    renderWithStore(<HeaderBar role="GM" />, dealtStore(true));
    expect(screen.getByRole("status")).toHaveTextContent("Not saved – retry");
  });

  it("shows a size error when too large", () => {
    mockedSyncStatus.mockReturnValue(snapshot({ status: "too-large", nearLimit: true }));
    renderWithStore(<HeaderBar role="GM" />, dealtStore(true));
    expect(screen.getByRole("status")).toHaveTextContent("Not saved – too large");
  });

  it("warns when near the size limit", () => {
    mockedSyncStatus.mockReturnValue(snapshot({ nearLimit: true }));
    renderWithStore(<HeaderBar role="GM" />, dealtStore(true));
    expect(screen.getByRole("status")).toHaveTextContent("Storage almost full");
  });
});
