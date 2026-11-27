// RTK Selectors for SWADE state
import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from './store';
import type { ParticipantRow } from './types';
import { canTakeTurn, findTurnIndexFrom } from './swadeSlice';

type Role = 'GM' | 'PLAYER';

// Base selectors
export const selectDeck = (state: RootState) => state.swade.deck;
export const selectRows = (state: RootState) => state.swade.rows;
export const selectTurn = (state: RootState) => state.swade.turn;
export const selectRound = (state: RootState) => state.swade.round;
export const selectPhase = (state: RootState) => state.swade.phase;
export const selectPrivacyMode = (state: RootState) => state.swade.settings.hideNpcFromPlayers;

/** Rows this viewer may see. Players with privacy on see only revealed rows (UI-level privacy). */
export const selectVisibleParticipants = createSelector(
  [selectRows, selectPrivacyMode, (_state: RootState, role?: Role) => role],
  (rows, privacyEnabled, role): ParticipantRow[] => {
    if (role === 'GM' || !privacyEnabled) return rows;
    return rows.filter(row => row.revealed);
  }
);

// ---------- turn navigation ----------

export const selectActiveParticipant = createSelector(
  [selectRows, selectTurn],
  (rows, turn) => (turn.activeRowId ? rows.find(r => r.id === turn.activeRowId) ?? null : null)
);

/** Index of the active row in display order, or -1. */
export const selectActiveIndex = createSelector(
  [selectRows, selectTurn],
  (rows, turn) => (turn.activeRowId ? rows.findIndex(r => r.id === turn.activeRowId) : -1)
);

/** Next row that can take a turn (see canTakeTurn). Null when nobody is active (no wrap). */
export const selectNextParticipant = createSelector(
  [selectRows, selectActiveIndex],
  (rows, activeIndex): ParticipantRow | null => {
    if (activeIndex === -1) return null;
    const index = findTurnIndexFrom(rows, activeIndex + 1);
    return index === -1 ? null : rows[index];
  }
);

/**
 * Previous row that can take a turn (same rule as Next: canTakeTurn). During a round with
 * nobody active (everyone has acted, e.g. the last active row was removed), this is
 * the last row that can take a turn, so the GM can step back into the round.
 */
export const selectPreviousParticipant = createSelector(
  [selectRows, selectActiveIndex, selectPhase],
  (rows, activeIndex, phase): ParticipantRow | null => {
    const from = activeIndex === -1 && phase === 'in_round' ? rows.length : activeIndex;
    for (let i = from - 1; i >= 0; i--) {
      if (canTakeTurn(rows[i])) return rows[i];
    }
    return null;
  }
);

/**
 * True while a round runs and the row is above the active row (it has acted this round).
 * Held rows above the active row also count as acted; only the Joker check uses this.
 */
export const selectHasActed = (state: RootState, rowId: string): boolean => {
  if (state.swade.phase !== 'in_round') return false;
  const activeIndex = selectActiveIndex(state);
  const index = state.swade.rows.findIndex(r => r.id === rowId);
  if (index === -1) return false;
  // Nobody active during a round: every row has acted, except held rows.
  if (activeIndex === -1) return !state.swade.rows[index].onHold;
  return index < activeIndex;
};

// ---------- deck ----------

export interface DeckCounts {
  remaining: number;
  inPlay: number;
  discard: number;
  total: number;
}

export const selectDeckCounts = createSelector(
  [selectDeck],
  (deck): DeckCounts => ({
    remaining: deck.remaining.length,
    inPlay: deck.inPlay.length,
    discard: deck.discard.length,
    total: deck.remaining.length + deck.inPlay.length + deck.discard.length,
  })
);

/**
 * Deck counts this viewer may see, or null. Players with privacy on get no counts: every
 * count changes when a hidden combatant is dealt a card, so any of them would leak it.
 */
export const selectDeckCountsForRole = createSelector(
  [selectDeckCounts, selectPrivacyMode, (_state: RootState, role?: Role) => role],
  (counts, privacyEnabled, role): DeckCounts | null => (role === 'GM' || !privacyEnabled ? counts : null)
);

export const selectParticipantCount = (state: RootState) => state.swade.rows.length;
