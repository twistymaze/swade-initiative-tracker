// SWADE Redux Slice
//
// Rules kept by every reducer:
// - The deck invariant: remaining + inPlay + discard always hold the 54 unique card ids.
// - Validate first, mutate after: no reducer changes the draft and then returns early.
// - Revision/writerId are stamped centrally (store.ts); reducers never touch them.
import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { EncounterState, CardId, ParticipantRow, ParticipantType } from './types';
import { initializeEmptyState } from './initialState';
import { isJokerId } from '../utils/cardIds';
import { isSafeImageUrl } from './stateCodec';
import { getCardScore } from '../utils/cardScoring';
import { fisherYatesShuffle, hashString, randomSeed, seededRandom } from '../utils/shuffle';

const initialState: EncounterState = initializeEmptyState();

// ---------- randomness ----------
// Reducers are pure: the same state and action always give the same result, so a GM's action
// replayed on another state (sync engine) deals the same cards when the deck is the same.
// Actions that shuffle carry a seed in `meta`, made by their `prepare` callback at dispatch time.

/** Meta of an action whose reducer may shuffle. */
export interface SeedMeta {
  seed: number;
}

type Random = () => number;

/** Action creator input: an optional explicit seed (tests); otherwise a random one. */
const seedMeta = (seed?: number): SeedMeta => ({ seed: seed ?? randomSeed() });

/**
 * The seed for one reducer call: the action's, or (an action without one, e.g. built by hand)
 * a hash of the deck, so the result is still deterministic.
 */
const seedFor = (state: EncounterState, action: { type: string; meta?: unknown }): number => {
  const meta = action.meta as Partial<SeedMeta> | undefined;
  return typeof meta?.seed === 'number'
    ? meta.seed
    : hashString(`${action.type}|${state.deck.remaining.join(',')}|${state.deck.discard.join(',')}`);
};

/** The PRNG for one reducer call (see seedFor). */
const randomFor = (state: EncounterState, action: { type: string; meta?: unknown }): Random =>
  seededRandom(seedFor(state, action));

// ---------- turn helpers ----------

/** An Extra (GROUP) marked incapacitated. It never acts, even on Hold or with a Joker. */
export const isIncapacitatedExtra = (row: ParticipantRow): boolean => row.inactive && row.type === 'GROUP';

/**
 * The one turn rule, used by Start Round, Next, Previous and auto-reveal. A row has a turn
 * this round when it is not held, is not an incapacitated Extra (inactive GROUP), and has a
 * card or an Act Now turn (`actNowTurn`, a held-over row with no card). So a row that lost
 * its turn (Lose Turn) or an Extra revived mid-round (never dealt in) has no turn.
 */
export const canTakeTurn = (row: ParticipantRow): boolean =>
  !row.onHold && !isIncapacitatedExtra(row) && (row.currentCardId !== undefined || row.actNowTurn === true);

/** Index of the first row at or after `fromIndex` that can take a turn, or -1. */
export const findTurnIndexFrom = (rows: readonly ParticipantRow[], fromIndex: number): number => {
  for (let i = Math.max(0, fromIndex); i < rows.length; i++) {
    if (canTakeTurn(rows[i])) return i;
  }
  return -1;
};

const activeIndexOf = (state: EncounterState): number =>
  state.turn.activeRowId ? state.rows.findIndex(r => r.id === state.turn.activeRowId) : -1;

/** Reveal a row when it becomes active. Rows that cannot take a turn are never auto-revealed. */
const autoReveal = (row: ParticipantRow | undefined) => {
  if (row && canTakeTurn(row)) row.revealed = true;
};

/** Make the first eligible row at or after `fromIndex` active (or nobody). */
const activateFrom = (state: EncounterState, fromIndex: number) => {
  const index = findTurnIndexFrom(state.rows, fromIndex);
  const row = index >= 0 ? state.rows[index] : undefined;
  state.turn.activeRowId = row?.id ?? null;
  autoReveal(row);
};

// ---------- deck helpers ----------

/** Move the given cards from inPlay to discard (ids not in play are ignored). */
const discardFromPlay = (state: EncounterState, ids: readonly CardId[]) => {
  for (const id of ids) {
    const index = state.deck.inPlay.indexOf(id);
    if (index > -1) {
      state.deck.inPlay.splice(index, 1);
      state.deck.discard.push(id);
    }
  }
};

/** Shuffle the discard pile back into the remaining deck. */
const reshuffleDiscardIntoDeck = (state: EncounterState, random: Random) => {
  state.deck.remaining.push(...state.deck.discard);
  state.deck.discard = [];
  fisherYatesShuffle(state.deck.remaining, random);
};

/** Deal one card into play (reshuffling the discard pile if the deck is empty). */
const dealSingleCard = (state: EncounterState, random: Random): CardId | null => {
  if (state.deck.remaining.length === 0) {
    if (state.deck.discard.length === 0) return null;
    reshuffleDiscardIntoDeck(state, random);
  }
  const cardId = state.deck.remaining.pop();
  if (!cardId) return null;
  state.deck.inPlay.push(cardId);
  if (isJokerId(cardId)) {
    state.deck.reshuffleAfterRound = true;
    state.deck.jokersDealtThisRound = (state.deck.jokersDealtThisRound ?? 0) + 1;
  }
  return cardId;
};

/** All cards a row holds (candidates plus keeper). */
const rowCards = (row: ParticipantRow): CardId[] =>
  row.currentCardId && !row.candidateIds.includes(row.currentCardId)
    ? [...row.candidateIds, row.currentCardId]
    : [...row.candidateIds];

// ---------- ordering ----------

const TYPE_ORDER: Record<ParticipantType, number> = { PC: 0, NPC: 1, GROUP: 2 };

/** Sort key: Jokers, then held rows, then card holders (high to low), then rows without a card. */
const sortKey = (row: ParticipantRow): [number, number, number, string] => {
  const score = getCardScore(row.currentCardId);
  const priority = score >= 1000 ? 0 : row.onHold ? 1 : score > -1 ? 2 : 3;
  return [priority, -score, TYPE_ORDER[row.type], row.name];
};

const compareRows = (a: ParticipantRow, b: ParticipantRow): number => {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < 3; i++) {
    const d = (ka[i] as number) - (kb[i] as number);
    if (d !== 0) return d;
  }
  return ka[3].localeCompare(kb[3]);
};

const sortRows = (state: EncounterState) => {
  state.rows.sort(compareRows);
};

/**
 * Insert `row` (not in the array) at its score position, but only among rows that
 * have not acted yet (after the active row) while a round is running.
 */
const insertAmongPending = (state: EncounterState, row: ParticipantRow) => {
  const start = state.phase === 'in_round' ? activeIndexOf(state) + 1 : 0;
  let index = state.rows.length;
  for (let i = start; i < state.rows.length; i++) {
    if (compareRows(row, state.rows[i]) < 0) {
      index = i;
      break;
    }
  }
  state.rows.splice(index, 0, row);
};

/**
 * True when addCandidateCard would draw a card: cards are dealt (or a round runs), the row
 * exists, and the deck or the discard pile has a card. The chooser's "+" uses the same rule.
 */
export const canAddCandidateCard = (state: EncounterState, participantId: string | null): boolean =>
  (state.phase === 'cards_dealt' || state.phase === 'in_round') &&
  state.rows.some(p => p.id === participantId) &&
  state.deck.remaining.length + state.deck.discard.length > 0;

/**
 * Jokers dealt this round: the stored count, but never fewer than the Jokers in play or
 * discarded since the last reshuffle (a state from an older writer may lack the count).
 */
const jokersDealtThisRound = (state: EncounterState): number =>
  Math.max(
    state.deck.jokersDealtThisRound ?? 0,
    state.deck.inPlay.filter(isJokerId).length + state.deck.discard.filter(isJokerId).length,
  );

export const swadeSlice = createSlice({
  name: 'swade',
  initialState,
  reducers: {
    // ---------- card chooser ----------

    addCandidateCard: {
      reducer: (state, action: PayloadAction<string, string, SeedMeta>) => {
        if (!canAddCandidateCard(state, action.payload)) return;
        const participant = state.rows.find(p => p.id === action.payload)!;
        const cardId = dealSingleCard(state, randomFor(state, action));
        if (cardId) participant.candidateIds.push(cardId);
      },
      prepare: (participantId: string, seed?: number) => ({ payload: participantId, meta: seedMeta(seed) }),
    },

    selectKeeperCard: (state, action: PayloadAction<{ participantId: string; cardId: string }>) => {
      const { participantId, cardId } = action.payload;
      const index = state.rows.findIndex(p => p.id === participantId);
      const participant = state.rows[index];
      if (!participant || !participant.candidateIds.includes(cardId)) return;
      // Already the only card: nothing to change (no new revision, write or undo entry).
      if (participant.currentCardId === cardId && participant.candidateIds.length === 1) return;

      discardFromPlay(state, rowCards(participant).filter(id => id !== cardId));
      participant.currentCardId = cardId;
      participant.candidateIds = [cardId];

      const activeIndex = activeIndexOf(state);
      if (state.phase !== 'in_round') {
        sortRows(state);
      } else if (activeIndex > -1 && index > activeIndex) {
        // Not acted yet: re-place among the rows that still have to act.
        state.rows.splice(index, 1);
        insertAmongPending(state, participant);
      }
      // A row that has acted (or is acting) keeps its place; with nobody active, all have acted.
    },

    /** Chooser Cancel: discard every candidate except the current keeper. */
    discardExtraCandidates: (state, action: PayloadAction<string>) => {
      const participant = state.rows.find(p => p.id === action.payload);
      if (!participant) return;
      const keep = participant.currentCardId;
      const extras = participant.candidateIds.filter(id => id !== keep);
      if (extras.length === 0) return;
      discardFromPlay(state, extras);
      participant.candidateIds = keep ? [keep] : [];
    },

    undoLastDraw: (state, action: PayloadAction<string>) => {
      const participant = state.rows.find(p => p.id === action.payload);
      if (!participant) return;
      const lastCardId = participant.candidateIds[participant.candidateIds.length - 1];
      const inPlayIndex = lastCardId ? state.deck.inPlay.indexOf(lastCardId) : -1;
      // Never take back the keeper itself.
      if (!lastCardId || lastCardId === participant.currentCardId || inPlayIndex === -1) return;

      // Only taking back a Joker can clear the flag, and only when no other Joker deal is
      // left this round (one may have gone back into the deck in a mid-round reshuffle).
      if (isJokerId(lastCardId)) {
        const left = jokersDealtThisRound(state) - 1;
        state.deck.jokersDealtThisRound = left;
        state.deck.reshuffleAfterRound = left > 0;
      }
      participant.candidateIds.pop();
      state.deck.inPlay.splice(inPlayIndex, 1);
      state.deck.remaining.push(lastCardId); // back on top of the deck
    },

    // ---------- round flow ----------

    /** Deal one card to each row that is not held and is not an inactive Extra. */
    dealRound: {
      reducer: (state, action: PayloadAction<undefined, string, SeedMeta>) => {
        if (state.phase !== 'setup' && state.phase !== 'between_rounds') return;
        if (state.rows.length === 0) return;

        const random = randomFor(state, action);
        for (const row of state.rows) {
          if (state.settings.hideNpcFromPlayers && row.type !== 'PC') row.revealed = false;
          if (row.onHold || (row.inactive && row.type === 'GROUP')) continue;
          const cardId = dealSingleCard(state, random);
          if (cardId) {
            row.currentCardId = cardId;
            row.candidateIds = [cardId];
          }
        }

        sortRows(state);
        state.round += 1;
        state.phase = 'cards_dealt';
      },
      prepare: (seed?: number) => ({ payload: undefined, meta: seedMeta(seed) }),
    },

    /** Begin the round: the first row that is not held becomes active. */
    startRound: (state) => {
      if (state.phase !== 'cards_dealt') return;
      state.phase = 'in_round';
      activateFrom(state, 0);
    },

    endRound: {
      reducer: (state, action: PayloadAction<undefined, string, SeedMeta>) => {
        if (state.phase !== 'in_round') return;
        const random = randomFor(state, action);

        state.deck.discard.push(...state.deck.inPlay);
        state.deck.inPlay = [];
        for (const row of state.rows) {
          row.currentCardId = undefined;
          row.candidateIds = [];
          delete row.actNowTurn;
        }
        state.turn.activeRowId = null;
        delete state.deck.jokersDealtThisRound;

        if (state.deck.reshuffleAfterRound) {
          reshuffleDiscardIntoDeck(state, random);
          state.deck.reshuffleAfterRound = false;
        }
        state.phase = 'between_rounds';
      },
      prepare: (seed?: number) => ({ payload: undefined, meta: seedMeta(seed) }),
    },

    // ---------- participants ----------

    createParticipant: {
      reducer: (state, action: PayloadAction<{
        id: string;
        name: string;
        type: ParticipantType;
        imageUrl?: string;
      }, string, Partial<SeedMeta>>) => {
        const { id, name, type, imageUrl } = action.payload;
        // Idempotent by row id: a request that is handled twice (modal fallback after a late
        // "accepted") or replayed onto a state that already has the row adds nothing.
        if (state.rows.some(p => p.id === id)) return;
        const row: ParticipantRow = {
          id,
          name,
          // Same rule as the stored form, so memory and room agree.
          imageUrl: isSafeImageUrl(imageUrl) ? imageUrl : undefined,
          type,
          inactive: false,
          onHold: false,
          currentCardId: undefined,
          candidateIds: [],
          revealed: type === 'PC', // PCs always visible
        };

        // Late joiner: draws immediately if cards have been dealt.
        if (state.phase === 'cards_dealt' || state.phase === 'in_round') {
          const cardId = dealSingleCard(state, randomFor(state, action));
          if (cardId) {
            row.currentCardId = cardId;
            row.candidateIds = [cardId];
          }
        }

        if (state.phase === 'in_round' && activeIndexOf(state) === -1) {
          // Nobody is active: every listed row has acted (or is held). The newcomer is
          // the only one still to act, so it goes last and takes the turn now.
          state.rows.push(row);
          activateFrom(state, state.rows.length - 1);
        } else if (state.phase === 'in_round') {
          insertAmongPending(state, row);
        } else {
          state.rows.push(row);
          sortRows(state);
        }
      },
      // Short random row id keeps the stored state small. The seed is for a late joiner's draw.
      // (An action rebuilt without meta, e.g. from a modal message, still deals deterministically.)
      prepare: (payload: { name: string; type: ParticipantType; imageUrl?: string }, seed?: number) => ({
        payload: { ...payload, id: Math.random().toString(36).slice(2, 10) },
        meta: seedMeta(seed) as Partial<SeedMeta>,
      }),
    },

    removeParticipant: (state, action: PayloadAction<string>) => {
      const index = state.rows.findIndex(p => p.id === action.payload);
      if (index === -1) return;
      const wasActive = state.turn.activeRowId === action.payload;

      discardFromPlay(state, rowCards(state.rows[index]));
      state.rows.splice(index, 1);

      // The next row that has not acted takes over (no wrap to the top).
      if (wasActive) {
        if (state.phase === 'in_round') activateFrom(state, index);
        else state.turn.activeRowId = null;
      }
    },

    removeAllNpcsAndExtras: (state) => {
      if (!state.rows.some(p => p.type !== 'PC')) return;
      const oldActiveIndex = activeIndexOf(state);
      const activeRemoved = oldActiveIndex > -1 && state.rows[oldActiveIndex].type !== 'PC';
      // Survivors before the old active row = index where the next survivor lands.
      const nextIndex = state.rows.slice(0, Math.max(oldActiveIndex, 0)).filter(p => p.type === 'PC').length;

      for (const row of state.rows) {
        if (row.type !== 'PC') discardFromPlay(state, rowCards(row));
      }
      state.rows = state.rows.filter(p => p.type === 'PC');

      if (activeRemoved) {
        if (state.phase === 'in_round') activateFrom(state, nextIndex);
        else state.turn.activeRowId = null;
      }
    },

    // ---------- status setters (explicit values, not toggles) ----------

    setHold: (state, action: PayloadAction<{ id: string; value: boolean }>) => {
      const participant = state.rows.find(p => p.id === action.payload.id);
      if (!participant) return;
      // An incapacitated Extra cannot act, so it cannot go on Hold (an existing hold may be cleared).
      if (action.payload.value && isIncapacitatedExtra(participant)) return;
      participant.onHold = action.payload.value;
    },

    setInactive: (state, action: PayloadAction<{ id: string; value: boolean }>) => {
      const participant = state.rows.find(p => p.id === action.payload.id);
      if (participant) participant.inactive = action.payload.value;
    },

    setRevealed: (state, action: PayloadAction<{ id: string; value: boolean }>) => {
      const participant = state.rows.find(p => p.id === action.payload.id);
      if (participant) participant.revealed = action.payload.value;
    },

    setParticipantType: (state, action: PayloadAction<{ id: string; type: ParticipantType }>) => {
      const { id, type } = action.payload;
      const participant = state.rows.find(p => p.id === id);
      if (!participant) return;
      participant.type = type;
      // PCs are always visible. Other changes keep the flag: a row players have already
      // seen is only hidden again on deal / End Initiative.
      if (type === 'PC') participant.revealed = true;
    },

    renameParticipant: (state, action: PayloadAction<{ id: string; name: string }>) => {
      const participant = state.rows.find(p => p.id === action.payload.id);
      const name = action.payload.name.trim();
      if (participant && name) participant.name = name;
    },

    /**
     * Lose Turn (Shaken/Stunned while on Hold): clears hold and discards the card.
     * During a round the row moves directly above the active row, so it does not act.
     */
    loseHold: (state, action: PayloadAction<string>) => {
      const index = state.rows.findIndex(p => p.id === action.payload);
      if (index === -1) return;
      const participant = state.rows[index];
      // Nothing to lose: no hold, no card and no Act Now turn (the row has no turn anyway).
      if (!participant.onHold && rowCards(participant).length === 0 && !participant.actNowTurn) return;

      discardFromPlay(state, rowCards(participant));
      participant.onHold = false;
      participant.currentCardId = undefined;
      participant.candidateIds = [];
      delete participant.actNowTurn;

      if (state.phase === 'in_round') {
        const activeIndex = activeIndexOf(state);
        if (activeIndex > -1 && activeIndex !== index) {
          state.rows.splice(index, 1);
          state.rows.splice(activeIndexOf(state), 0, participant);
        }
      } else if (state.phase === 'cards_dealt') {
        sortRows(state);
      }
    },

    // ---------- turn management ----------

    /** Next / Previous. Only during a round: no row is active in any other phase. */
    setActiveParticipant: (state, action: PayloadAction<string | null>) => {
      if (state.phase !== 'in_round') return;
      const id = action.payload;
      const row = id ? state.rows.find(p => p.id === id) : undefined;
      if (id && !row) return;
      state.turn.activeRowId = id;
      autoReveal(row);
    },

    /**
     * Act Now: move the row before (interrupt) or after the active row; clears hold and reveals.
     * In a round with nobody active (everyone else has acted) the row goes last and takes the turn.
     */
    insertActNow: (state, action: PayloadAction<{ id: string; placement: 'before' | 'after' }>) => {
      const { id, placement } = action.payload;
      const index = state.rows.findIndex(p => p.id === id);
      if (index === -1) return;
      // An incapacitated Extra cannot act; its hold (if any) stays for when it is revived.
      if (isIncapacitatedExtra(state.rows[index])) return;
      const currentActive = activeIndexOf(state);
      const nobodyActive = state.phase === 'in_round' && currentActive === -1;
      if (!nobodyActive && (currentActive === -1 || state.turn.activeRowId === id)) return;
      // Already acting right after the active row: nothing to change.
      const row = state.rows[index];
      if (
        !nobodyActive &&
        placement === 'after' &&
        index === currentActive + 1 &&
        !row.onHold &&
        row.revealed &&
        row.currentCardId !== undefined
      ) {
        return;
      }

      const [participant] = state.rows.splice(index, 1);
      participant.onHold = false;
      participant.revealed = true;
      // A held-over row has no card; this flag gives it its turn (see canTakeTurn).
      if (participant.currentCardId === undefined) participant.actNowTurn = true;
      const activeIndex = activeIndexOf(state); // after the removal
      const target = nobodyActive ? state.rows.length : placement === 'before' ? activeIndex : activeIndex + 1;
      state.rows.splice(target, 0, participant);
      if (nobodyActive || placement === 'before') state.turn.activeRowId = id;
    },

    // ---------- settings ----------

    setPrivacy: (state, action: PayloadAction<boolean>) => {
      state.settings.hideNpcFromPlayers = action.payload;
    },

    // ---------- system ----------

    /** Keep rows; clear cards and holds; full fresh deck; back to setup. */
    endInitiative: {
      reducer: (state, action: PayloadAction<undefined, string, SeedMeta>) => {
        // Already a fresh setup: do not reshuffle (no new revision, write or undo entry).
        const fresh =
          state.phase === 'setup' &&
          state.round === 0 &&
          state.turn.activeRowId === null &&
          state.deck.inPlay.length === 0 &&
          state.deck.discard.length === 0 &&
          !state.deck.reshuffleAfterRound &&
          state.deck.jokersDealtThisRound === undefined &&
          state.rows.every(
            (row) =>
              !row.onHold &&
              !row.actNowTurn &&
              row.currentCardId === undefined &&
              row.candidateIds.length === 0 &&
              !(state.settings.hideNpcFromPlayers && row.type !== 'PC' && row.revealed),
          );
        if (fresh) return;
        for (const row of state.rows) {
          row.currentCardId = undefined;
          row.candidateIds = [];
          row.onHold = false;
          delete row.actNowTurn;
          if (state.settings.hideNpcFromPlayers && row.type !== 'PC') row.revealed = false;
        }
        state.deck = {
          remaining: fisherYatesShuffle(
            [...state.deck.remaining, ...state.deck.inPlay, ...state.deck.discard],
            randomFor(state, action),
          ),
          inPlay: [],
          discard: [],
          reshuffleAfterRound: false,
        };
        state.round = 0;
        state.phase = 'setup';
        state.turn.activeRowId = null;
      },
      prepare: (seed?: number) => ({ payload: undefined, meta: seedMeta(seed) }),
    },

    reset: {
      reducer: (state, action: PayloadAction<undefined, string, SeedMeta>) =>
        initializeEmptyState(seedFor(state, action)),
      prepare: (seed?: number) => ({ payload: undefined, meta: seedMeta(seed) }),
    },

    // Sync-only: replaces the state with one adopted from (or written to) the room.
    // Not stamped with a new revision (see createAppStore).
    setEncounterState: (_state, action: PayloadAction<EncounterState>) => action.payload,

    // Undo/redo: replaces the encounter content with a snapshot. A normal action,
    // so the store wrapper stamps a new revision/writerId.
    restoreSnapshot: (_state, action: PayloadAction<EncounterState>) => action.payload,
  },
});

export const {
  addCandidateCard,
  selectKeeperCard,
  discardExtraCandidates,
  undoLastDraw,
  dealRound,
  startRound,
  endRound,
  createParticipant,
  removeParticipant,
  removeAllNpcsAndExtras,
  setHold,
  loseHold,
  setInactive,
  setRevealed,
  setParticipantType,
  renameParticipant,
  setActiveParticipant,
  insertActNow,
  setPrivacy,
  endInitiative,
  reset,
  setEncounterState,
  restoreSnapshot,
} = swadeSlice.actions;

export default swadeSlice.reducer;
