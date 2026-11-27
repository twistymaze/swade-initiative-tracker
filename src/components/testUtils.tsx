// Test helpers for component tests: a seeded store, an undo store, and providers.
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { Provider } from "react-redux";
import { createAppStore, type AppStore } from "../store/store";
import { setEncounterState } from "../store/swadeSlice";
import { initializeEmptyState } from "../store/initialState";
import { LocalUndoStore } from "../store/localUndoStore";
import { UndoProvider } from "../contexts/UndoContext";
import type { CardId, EncounterState, ParticipantRow } from "../store/types";

export function makeRow(partial: Partial<ParticipantRow> & { id: string }): ParticipantRow {
  return { name: partial.id, type: "PC", inactive: false, onHold: false, revealed: true, candidateIds: [], ...partial };
}

/** Move a specific card from the deck into play (as if dealt). */
export function dealCard(state: EncounterState, cardId: CardId): CardId {
  state.deck.remaining = state.deck.remaining.filter((id) => id !== cardId);
  state.deck.inPlay.push(cardId);
  return cardId;
}

/** A store (writerId "me") seeded with an empty state changed by `mutate`. */
export function makeStore(mutate?: (state: EncounterState) => void): AppStore {
  const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
  const state = initializeEmptyState();
  mutate?.(state);
  store.dispatch(setEncounterState({ ...state, revision: 1, writerId: "seed" }));
  return store;
}

export function renderWithStore(ui: ReactElement, store: AppStore = makeStore()) {
  const undoStore = new LocalUndoStore({ store, writerId: "me", roomId: "room-test" });
  const result = render(
    <Provider store={store}>
      <UndoProvider undoStore={undoStore}>{ui}</UndoProvider>
    </Provider>
  );
  return { ...result, store, undoStore };
}
