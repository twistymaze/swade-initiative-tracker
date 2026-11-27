import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));

import { act, render, screen, fireEvent } from "@testing-library/react";
import { resetObrMock } from "../test/obrMock";
import { createAppStore, type AppStore } from "../store/store";
import { setEncounterState, setHold } from "../store/swadeSlice";
import { initializeEmptyState } from "../store/initialState";
import { LocalUndoStore, UNDO_STORAGE_PREFIX } from "../store/localUndoStore";
import { UndoProvider } from "./UndoContext";
import { UndoButton } from "../components/UndoButton";
import { useUndo } from "../hooks/useUndo";

const ROOM = "room-ctx";

function seeded(): AppStore {
  const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
  const state = initializeEmptyState();
  state.rows = [{ id: "r1", name: "Hero", type: "PC", inactive: false, onHold: false, revealed: true, candidateIds: [] }];
  store.dispatch(setEncounterState({ ...state, revision: 5, writerId: "seed" }));
  return store;
}

function Actions({ store }: { store: AppStore }) {
  const { captureCheckpoint } = useUndo();
  return (
    <>
      <button onClick={() => captureCheckpoint("Add Combatant")}>open modal</button>
      <button
        onClick={() => {
          captureCheckpoint("Hold: Hero");
          store.dispatch(setHold({ id: "r1", value: true }));
        }}
      >
        hold
      </button>
    </>
  );
}

function setup(store = seeded()) {
  const undoStore = new LocalUndoStore({ store, writerId: "me", roomId: ROOM });
  render(
    <UndoProvider undoStore={undoStore}>
      <Actions store={store} />
      <UndoButton />
    </UndoProvider>
  );
  return { store, undoStore, undoButton: () => screen.getByRole("button", { name: /undo/i }) };
}

beforeEach(() => {
  resetObrMock();
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe("UndoProvider + UndoButton", () => {
  it("is disabled with nothing to undo", () => {
    const { undoButton } = setup();
    expect(undoButton()).toBeDisabled();
  });

  it("opening a modal that is cancelled leaves Undo disabled", async () => {
    const { undoButton } = setup();
    fireEvent.click(screen.getByText("open modal"));
    await act(async () => {});
    expect(undoButton()).toBeDisabled();
  });

  it("enables Undo after a captured action and restores on click", async () => {
    const { store, undoButton } = setup();
    fireEvent.click(screen.getByText("hold"));
    expect(undoButton()).toBeEnabled();
    expect(screen.getByLabelText("Undo: Hold: Hero")).toBeInTheDocument();

    fireEvent.click(undoButton());
    expect(store.getState().swade.rows[0].onHold).toBe(false);
    expect(store.getState().swade).toMatchObject({ revision: 7, writerId: "me" });
    expect(undoButton()).toBeDisabled();
  });

  it("picks up a checkpoint written by another iframe via the storage event", async () => {
    const store = seeded();
    const { undoButton } = setup(store);

    // Another iframe of this browser (same writer is fine here) writes the shared history.
    const other = new LocalUndoStore({ store, writerId: "me", roomId: ROOM, eventTarget: null }).start();
    other.captureCheckpoint("Add PC from token");
    act(() => {
      store.dispatch(setHold({ id: "r1", value: true }));
    });
    expect(undoButton()).toBeDisabled();

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: `${UNDO_STORAGE_PREFIX}${ROOM}` }));
    });
    expect(undoButton()).toBeEnabled();
    other.destroy();
  });
});
