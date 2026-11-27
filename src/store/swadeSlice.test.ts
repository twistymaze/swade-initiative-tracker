import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnknownAction } from '@reduxjs/toolkit';
import reducer, {
  addCandidateCard,
  createParticipant,
  dealRound,
  discardExtraCandidates,
  endInitiative,
  endRound,
  insertActNow,
  loseHold,
  removeAllNpcsAndExtras,
  removeParticipant,
  renameParticipant,
  reset,
  restoreSnapshot,
  canAddCandidateCard,
  canTakeTurn,
  selectKeeperCard,
  setActiveParticipant,
  setEncounterState,
  setHold,
  setInactive,
  setParticipantType,
  setPrivacy,
  setRevealed,
  startRound,
  undoLastDraw,
} from './swadeSlice';
import { selectNextParticipant, selectPreviousParticipant } from './selectors';
import { createAppStore, type RootState } from './store';
import { initializeEmptyState } from './initialState';
import type { CardId, EncounterState, Phase, ParticipantRow } from './types';
import { BLACK_JOKER_ID, RED_JOKER_ID, generateAllCardIds } from '../utils/cardIds';
import { seededRandom } from '../utils/shuffle';

// The reducers' PRNG, wrapped so a test can force an identity shuffle (see identityShuffle).
vi.mock('../utils/shuffle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/shuffle')>();
  return { ...actual, seededRandom: vi.fn(actual.seededRandom) };
});

/** Every shuffle in the reducers leaves the order unchanged (random() just below 1). */
const identityShuffle = () => vi.mocked(seededRandom).mockReturnValue(() => 0.9999);

const ALL_IDS = generateAllCardIds();

function row(id: string, overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  const card = overrides.currentCardId;
  return {
    id,
    name: id,
    type: 'PC',
    inactive: false,
    onHold: false,
    revealed: true,
    candidateIds: card ? [card] : [],
    ...overrides,
  };
}

/** A state whose inPlay holds exactly the rows' cards; the rest of the deck is in `remaining`. */
function makeState(opts: {
  rows?: ParticipantRow[];
  phase?: Phase;
  active?: string | null;
  privacy?: boolean;
  topOfDeck?: CardId[]; // last element is dealt first
  round?: number;
}): EncounterState {
  const rows = opts.rows ?? [];
  const inPlay = rows.flatMap(r => r.candidateIds);
  const top = opts.topOfDeck ?? [];
  const remaining = ALL_IDS.filter(id => !inPlay.includes(id) && !top.includes(id)).concat(top);
  return {
    ...initializeEmptyState(),
    round: opts.round ?? 1,
    phase: opts.phase ?? 'in_round',
    rows,
    deck: { remaining, inPlay, discard: [], reshuffleAfterRound: inPlay.some(id => id.startsWith('JK')) },
    turn: { activeRowId: opts.active ?? null },
    settings: { hideNpcFromPlayers: opts.privacy ?? false },
  };
}

const ids = (s: EncounterState) => s.rows.map(r => r.id);
const byId = (s: EncounterState, id: string) => s.rows.find(r => r.id === id)!;
const root = (s: EncounterState) => ({ swade: s }) as RootState;

function expectDeckInvariant(s: EncounterState) {
  const all = [...s.deck.remaining, ...s.deck.inPlay, ...s.deck.discard];
  expect(all).toHaveLength(54);
  expect(new Set(all).size).toBe(54);
  // Every card in play belongs to a row, and every row card is in play.
  const held = s.rows.flatMap(r => [...r.candidateIds, ...(r.currentCardId ? [r.currentCardId] : [])]);
  expect([...new Set(held)].sort()).toEqual([...s.deck.inPlay].sort());
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(seededRandom).mockReset(); // back to the real PRNG
});

describe('restoreSnapshot', () => {
  it('replaces the content and is stamped by the store wrapper', () => {
    const store = createAppStore({ writerId: 'me', getMinRevision: () => 7 });
    const snapshot = { ...makeState({ rows: [row('A')] }), revision: 3, writerId: 'old' };
    store.dispatch(restoreSnapshot(snapshot));
    const s = store.getState().swade;
    expect(ids(s)).toEqual(['A']);
    expect(s.revision).toBe(8);
    expect(s.writerId).toBe('me');
  });
});

describe('removing the active row (GL1)', () => {
  const four = () =>
    makeState({
      rows: [row('A', { currentCardId: 'KS' }), row('B', { currentCardId: 'QS' }), row('C', { currentCardId: 'JS' }), row('D', { currentCardId: '10S' })],
      active: 'C',
    });

  it('activates the row that takes its place', () => {
    const s = reducer(four(), removeParticipant('C'));
    expect(s.turn.activeRowId).toBe('D');
    expect(s.deck.discard).toEqual(['JS']);
    expectDeckInvariant(s);
  });

  it('skips held rows and reveals the new active row', () => {
    const start = makeState({
      rows: [row('A', { currentCardId: 'KS' }), row('C', { currentCardId: 'QS' }), row('H', { onHold: true, type: 'NPC', revealed: false }), row('E', { type: 'NPC', revealed: false, currentCardId: '2C' })],
      active: 'C',
    });
    const s = reducer(start, removeParticipant('C'));
    expect(s.turn.activeRowId).toBe('E');
    expect(byId(s, 'E').revealed).toBe(true);
    expect(byId(s, 'H').revealed).toBe(false);
  });

  it('removing the last row while active leaves nobody active and Next disabled (no wrap)', () => {
    const s = reducer(four(), removeParticipant('D'));
    const s2 = reducer({ ...s, turn: { activeRowId: 'C' } }, removeParticipant('C'));
    expect(s2.turn.activeRowId).toBeNull();
    expect(selectNextParticipant(root(s2))).toBeNull();
  });

  it('with nobody active, a late joiner goes last and takes the turn now', () => {
    const s = reducer(four(), removeParticipant('D'));
    const s2 = reducer({ ...s, turn: { activeRowId: 'C' }, settings: { hideNpcFromPlayers: true } }, removeParticipant('C'));
    expect(s2.turn.activeRowId).toBeNull();
    const s3 = reducer({ ...s2, deck: { ...s2.deck, remaining: [...s2.deck.remaining.filter(id => id !== 'AS'), 'AS'] } }, createParticipant({ name: 'Late', type: 'NPC' }));
    expect(s3.rows.map(r => r.name)).toEqual(['A', 'B', 'Late']);
    const late = s3.rows[2];
    expect(late.currentCardId).toBe('AS');
    expect(s3.turn.activeRowId).toBe(late.id);
    expect(late.revealed).toBe(true);
    expect(selectNextParticipant(root(s3))).toBeNull();
    expect(selectPreviousParticipant(root(s3))?.id).toBe('B');
    expectDeckInvariant(s3);
    expect(reducer(s3, endRound()).phase).toBe('between_rounds');
  });

  it('with nobody active, Previous steps back to the last row that can act', () => {
    const s = reducer(four(), removeParticipant('D'));
    const s2 = reducer({ ...s, turn: { activeRowId: 'C' } }, removeParticipant('C'));
    const prev = selectPreviousParticipant(root(s2));
    expect(prev?.id).toBe('B');
    expect(reducer(s2, setActiveParticipant(prev!.id)).turn.activeRowId).toBe('B');
  });

  it('with nobody active, a keeper change does not move a row that has acted', () => {
    const start = makeState({
      rows: [row('A', { currentCardId: 'KS' }), row('B', { currentCardId: '9S' })],
      active: null,
      topOfDeck: ['AS'],
    });
    let s = reducer(start, addCandidateCard('B'));
    s = reducer(s, selectKeeperCard({ participantId: 'B', cardId: 'AS' }));
    expect(ids(s)).toEqual(['A', 'B']);
  });

  it('removeAllNpcsAndExtras activates the next surviving row', () => {
    const start = makeState({
      rows: [row('P1', { currentCardId: 'KS' }), row('N1', { type: 'NPC', currentCardId: 'QS' }), row('G1', { type: 'GROUP', currentCardId: 'JS' }), row('P2', { currentCardId: '2C' })],
      active: 'N1',
    });
    const s = reducer(start, removeAllNpcsAndExtras());
    expect(ids(s)).toEqual(['P1', 'P2']);
    expect(s.turn.activeRowId).toBe('P2');
    expectDeckInvariant(s);
  });

  it('removeAllNpcsAndExtras with nothing to remove is a no-op', () => {
    const start = makeState({ rows: [row('P1')] });
    expect(reducer(start, removeAllNpcsAndExtras())).toBe(start);
  });
});

describe('no full re-sort during a round (GL2)', () => {
  it('a late joiner is placed after the active row; B, A, C keep their order', () => {
    // After "Act Now before": A (no card) sits before C and is active.
    const start = makeState({
      rows: [row('B', { currentCardId: 'QS' }), row('A'), row('C', { currentCardId: '5C' })],
      active: 'A',
      topOfDeck: ['KH'],
    });
    const s = reducer(start, createParticipant({ name: 'D', type: 'NPC' }));
    expect(s.rows.map(r => r.name)).toEqual(['B', 'A', 'D', 'C']);
    expect(s.rows[2].currentCardId).toBe('KH');
    expectDeckInvariant(s);
  });

  it('a late joiner with a low card goes after the pending rows above it', () => {
    const start = makeState({
      rows: [row('A', { currentCardId: 'KS' }), row('B', { currentCardId: '9S' }), row('C', { currentCardId: '4S' })],
      active: 'A',
      topOfDeck: ['2C'],
    });
    const s = reducer(start, createParticipant({ name: 'D', type: 'PC' }));
    expect(s.rows.map(r => r.name)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('a keeper change of a row that has acted does not move it', () => {
    const start = makeState({
      rows: [row('A', { currentCardId: 'KS' }), row('B', { currentCardId: '9S' }), row('C', { currentCardId: '4S' })],
      active: 'B',
      topOfDeck: ['2C'],
    });
    let s = reducer(start, addCandidateCard('A'));
    s = reducer(s, selectKeeperCard({ participantId: 'A', cardId: '2C' }));
    expect(ids(s)).toEqual(['A', 'B', 'C']);
    expect(byId(s, 'A').candidateIds).toEqual(['2C']);
    expect(s.deck.discard).toEqual(['KS']);
    expectDeckInvariant(s);
  });

  it('a keeper change of a pending row moves it only among pending rows', () => {
    const start = makeState({
      rows: [row('A', { currentCardId: 'KS' }), row('B', { currentCardId: '9S' }), row('C', { currentCardId: '4S' }), row('D', { currentCardId: '3S' })],
      active: 'B',
      topOfDeck: ['AS'],
    });
    let s = reducer(start, addCandidateCard('D'));
    s = reducer(s, selectKeeperCard({ participantId: 'D', cardId: 'AS' }));
    expect(ids(s)).toEqual(['A', 'B', 'D', 'C']);
  });

  it('a pending row that keeps a lower card moves below pending rows it now trails; acted rows never move', () => {
    const start = makeState({
      rows: [row('A', { currentCardId: 'KS' }), row('H', { currentCardId: 'QS' }), row('B', { currentCardId: '9C' })],
      active: 'A',
      topOfDeck: ['5H'],
    });
    let s = reducer(start, addCandidateCard('H'));
    s = reducer(s, selectKeeperCard({ participantId: 'H', cardId: '5H' }));
    expect(ids(s)).toEqual(['A', 'B', 'H']);
    expectDeckInvariant(s);

    // Same change once H has acted (B active): H stays above B.
    const acted = makeState({
      rows: [row('A', { currentCardId: 'KS' }), row('H', { currentCardId: 'QS' }), row('B', { currentCardId: '9C' })],
      active: 'B',
      topOfDeck: ['5H'],
    });
    s = reducer(reducer(acted, addCandidateCard('H')), selectKeeperCard({ participantId: 'H', cardId: '5H' }));
    expect(ids(s)).toEqual(['A', 'H', 'B']);
  });

  it('before the round starts a keeper change re-sorts fully', () => {
    const start = makeState({
      phase: 'cards_dealt',
      rows: [row('A', { currentCardId: 'KS' }), row('B', { currentCardId: '9S' })],
      topOfDeck: ['AS'],
    });
    let s = reducer(start, addCandidateCard('B'));
    s = reducer(s, selectKeeperCard({ participantId: 'B', cardId: 'AS' }));
    expect(ids(s)).toEqual(['B', 'A']);
  });

  it('selectKeeperCard with a card that is not a candidate is a no-op', () => {
    const start = makeState({ rows: [row('A', { currentCardId: 'KS' })], active: 'A' });
    expect(reducer(start, selectKeeperCard({ participantId: 'A', cardId: 'QS' }))).toBe(start);
  });
});

describe('loseHold (GL3)', () => {
  it('moves the row directly above the active row and discards its card', () => {
    const start = makeState({
      rows: [row('B', { currentCardId: RED_JOKER_ID }), row('A', { onHold: true, currentCardId: '3C' }), row('C', { currentCardId: '10S' })],
      active: 'B',
    });
    const s = reducer(start, loseHold('A'));
    expect(ids(s)).toEqual(['A', 'B', 'C']);
    expect(byId(s, 'A')).toMatchObject({ onHold: false, currentCardId: undefined, candidateIds: [] });
    expect(s.deck.inPlay).not.toContain('3C');
    expect(s.deck.discard).toContain('3C');
    expect(selectNextParticipant(root(s))?.id).toBe('C');
    expectDeckInvariant(s);
  });

  it('a row below the active row moves up above it', () => {
    const start = makeState({
      rows: [row('X'), row('B', { currentCardId: 'KS' }), row('C', { currentCardId: '9S' }), row('A', { onHold: true })],
      active: 'B',
    });
    const s = reducer(start, loseHold('A'));
    expect(ids(s)).toEqual(['X', 'A', 'B', 'C']);
    expect(s.turn.activeRowId).toBe('B');
  });
});

describe('held rows and turn order (GL4)', () => {
  it('startRound skips held rows and does not reveal them', () => {
    const start = makeState({
      phase: 'cards_dealt',
      privacy: true,
      rows: [row('heldNPC', { type: 'NPC', onHold: true, revealed: false }), row('PC', { currentCardId: 'KS' })],
    });
    const s = reducer(start, startRound());
    expect(s.phase).toBe('in_round');
    expect(s.turn.activeRowId).toBe('PC');
    expect(byId(s, 'heldNPC').revealed).toBe(false);
  });

  it('startRound with only held rows activates nobody', () => {
    const start = makeState({ phase: 'cards_dealt', rows: [row('A', { onHold: true })] });
    const s = reducer(start, startRound());
    expect(s.turn.activeRowId).toBeNull();
  });

  it('setActiveParticipant reveals a hidden row but never a held one', () => {
    const start = makeState({
      privacy: true,
      rows: [row('N', { type: 'NPC', revealed: false, currentCardId: 'KS' }), row('H', { type: 'NPC', onHold: true, revealed: false })],
    });
    expect(byId(reducer(start, setActiveParticipant('N')), 'N').revealed).toBe(true);
    expect(byId(reducer(start, setActiveParticipant('H')), 'H').revealed).toBe(false);
    expect(reducer(start, setActiveParticipant('missing'))).toBe(start);
  });

  it('after Lose Turn, Previous skips the row that has no card', () => {
    const start = makeState({
      privacy: true,
      rows: [
        row('A', { currentCardId: 'KS' }),
        row('H', { onHold: true, type: 'NPC', revealed: false, currentCardId: 'QS' }),
        row('B', { currentCardId: '9S' }),
      ],
      active: 'B',
    });
    const s = reducer(start, loseHold('H'));
    expect(ids(s)).toEqual(['A', 'H', 'B']);
    expect(selectPreviousParticipant(root(s))?.id).toBe('A');
    expect(byId(s, 'H').revealed).toBe(false);
  });

  it('Next and Previous skip held rows', () => {
    const s = makeState({ rows: [row('A', { currentCardId: 'KS' }), row('B', { onHold: true }), row('C', { currentCardId: '9S' })], active: 'A' });
    expect(selectNextParticipant(root(s))?.id).toBe('C');
    const s2 = { ...s, turn: { activeRowId: 'C' } };
    expect(selectPreviousParticipant(root(s2))?.id).toBe('A');
  });
});

describe('setParticipantType (GL5)', () => {
  it('NPC changed to PC becomes revealed', () => {
    const start = makeState({ privacy: true, rows: [row('A', { type: 'NPC', revealed: false })] });
    const s = reducer(start, setParticipantType({ id: 'A', type: 'PC' }));
    expect(byId(s, 'A').revealed).toBe(true);
  });

  it('changes to NPC or Extra keep the revealed flag (never re-hide a row players have seen)', () => {
    const start = makeState({
      privacy: true,
      rows: [row('A'), row('X', { type: 'GROUP', revealed: true }), row('H', { type: 'NPC', revealed: false })],
      active: null,
    });
    let s = reducer(start, setParticipantType({ id: 'A', type: 'NPC' }));
    expect(byId(s, 'A').revealed).toBe(true);
    s = reducer(s, setParticipantType({ id: 'X', type: 'NPC' }));
    expect(byId(s, 'X').revealed).toBe(true);
    s = reducer(s, setParticipantType({ id: 'H', type: 'GROUP' }));
    expect(byId(s, 'H').revealed).toBe(false);
  });

  it('with privacy off the revealed flag of an NPC is unchanged', () => {
    const start = makeState({ privacy: false, rows: [row('A')] });
    expect(byId(reducer(start, setParticipantType({ id: 'A', type: 'NPC' })), 'A').revealed).toBe(true);
  });
});

describe('insertActNow (GL6)', () => {
  it('with no active row outside a round it returns the same state reference', () => {
    const start = makeState({ phase: 'cards_dealt', rows: [row('A', { onHold: true }), row('B')], active: null });
    expect(reducer(start, insertActNow({ id: 'A', placement: 'before' }))).toBe(start);
  });

  it('in a round with nobody active, the held row goes last and takes the turn', () => {
    for (const placement of ['before', 'after'] as const) {
      const start = makeState({
        privacy: true,
        rows: [row('H', { onHold: true, type: 'NPC', revealed: false, currentCardId: '5C' }), row('A', { currentCardId: '9S' })],
        active: null,
      });
      const s = reducer(start, insertActNow({ id: 'H', placement }));
      expect(ids(s)).toEqual(['A', 'H']);
      expect(s.turn.activeRowId).toBe('H');
      expect(byId(s, 'H')).toMatchObject({ onHold: false, revealed: true });
      expect(selectNextParticipant(root(s))).toBeNull();
      expectDeckInvariant(s);
    }
  });

  it('before: the row interrupts and becomes active (row was above active)', () => {
    const start = makeState({
      privacy: true,
      rows: [row('H', { onHold: true, type: 'NPC', revealed: false }), row('A'), row('B')],
      active: 'B',
    });
    const s = reducer(start, insertActNow({ id: 'H', placement: 'before' }));
    expect(ids(s)).toEqual(['A', 'H', 'B']);
    expect(s.turn.activeRowId).toBe('H');
    expect(byId(s, 'H')).toMatchObject({ onHold: false, revealed: true });
  });

  it('after: the row goes after the active row, which stays active (row was below active)', () => {
    const start = makeState({ rows: [row('A'), row('B'), row('H', { onHold: true })], active: 'A' });
    const s = reducer(start, insertActNow({ id: 'H', placement: 'after' }));
    expect(ids(s)).toEqual(['A', 'H', 'B']);
    expect(s.turn.activeRowId).toBe('A');
  });
});

describe('dealRound', () => {
  it('advances round and phase even when every row is held (GL6/L8)', () => {
    const start = makeState({ phase: 'between_rounds', round: 2, rows: [row('A', { onHold: true }), row('B', { onHold: true })] });
    const s = reducer(start, dealRound());
    expect(s.phase).toBe('cards_dealt');
    expect(s.round).toBe(3);
    expect(s.deck.inPlay).toEqual([]);
  });

  it('skips held rows and inactive Extras, deals to inactive PCs, re-hides NPCs', () => {
    const start = makeState({
      phase: 'setup',
      round: 0,
      privacy: true,
      rows: [
        row('held', { onHold: true }),
        row('ext', { type: 'GROUP', inactive: true }),
        row('pc', { inactive: true }),
        row('npc', { type: 'NPC', revealed: true }),
      ],
    });
    const s = reducer(start, dealRound());
    expect(s.round).toBe(1);
    expect(byId(s, 'held').currentCardId).toBeUndefined();
    expect(byId(s, 'ext').currentCardId).toBeUndefined();
    expect(byId(s, 'pc').currentCardId).toBeDefined();
    expect(byId(s, 'npc').currentCardId).toBeDefined();
    expect(byId(s, 'npc').revealed).toBe(false);
    expect(s.deck.inPlay).toHaveLength(2);
    expectDeckInvariant(s);
  });

  it('sorts Jokers (black before red), then held, then cards high to low', () => {
    const start = makeState({
      phase: 'between_rounds',
      rows: [row('low'), row('held', { onHold: true }), row('red'), row('high'), row('black')],
      // dealt in row order (held skipped): low, red, high, black
      topOfDeck: [BLACK_JOKER_ID, 'AS', RED_JOKER_ID, '2C'],
    });
    const s = reducer(start, dealRound());
    expect(ids(s)).toEqual(['black', 'red', 'held', 'high', 'low']);
    expect(s.deck.reshuffleAfterRound).toBe(true);
  });

  it('is a no-op outside setup/between_rounds and with no rows', () => {
    const inRound = makeState({ rows: [row('A')] });
    expect(reducer(inRound, dealRound())).toBe(inRound);
    const empty = makeState({ phase: 'setup', rows: [] });
    expect(reducer(empty, dealRound())).toBe(empty);
  });
});

describe('Joker reshuffle', () => {
  it('undoing a Joker draw clears the reshuffle flag (GL7)', () => {
    const start = makeState({ rows: [row('A', { currentCardId: 'KS' })], active: 'A', topOfDeck: [BLACK_JOKER_ID] });
    let s = reducer(start, addCandidateCard('A'));
    expect(s.deck.reshuffleAfterRound).toBe(true);
    s = reducer(s, undoLastDraw('A'));
    expect(s.deck.reshuffleAfterRound).toBe(false);
    expect(s.deck.remaining.at(-1)).toBe(BLACK_JOKER_ID);
    expect(byId(s, 'A').candidateIds).toEqual(['KS']);
    expectDeckInvariant(s);
  });

  it('undoLastDraw never takes back the keeper', () => {
    const start = makeState({ rows: [row('A', { currentCardId: 'KS' })], active: 'A' });
    expect(reducer(start, undoLastDraw('A'))).toBe(start);
  });

  it('endRound after a Joker round reshuffles everything into the deck', () => {
    const start = makeState({ rows: [row('A', { currentCardId: RED_JOKER_ID }), row('B', { currentCardId: '5S' })], active: 'B' });
    const s = reducer(start, endRound());
    expect(s.phase).toBe('between_rounds');
    expect(s.deck.remaining).toHaveLength(54);
    expect(s.deck.discard).toEqual([]);
    expect(s.deck.reshuffleAfterRound).toBe(false);
    expect(s.turn.activeRowId).toBeNull();
  });

  it('endRound without a Joker discards the cards in play', () => {
    const start = makeState({ rows: [row('A', { currentCardId: 'KS' })], active: 'A' });
    const s = reducer(start, endRound());
    expect(s.deck.discard).toEqual(['KS']);
    expect(byId(s, 'A').candidateIds).toEqual([]);
  });

  it('dealing from an empty deck reshuffles the discard pile', () => {
    const start = makeState({ rows: [row('A', { currentCardId: 'KS' })], active: 'A' });
    const s0 = { ...start, deck: { ...start.deck, remaining: [], discard: start.deck.remaining } };
    const s = reducer(s0, addCandidateCard('A'));
    expect(byId(s, 'A').candidateIds).toHaveLength(2);
    expectDeckInvariant(s);
  });
});

describe('discardExtraCandidates (GL12)', () => {
  it('discards every candidate except the keeper', () => {
    const start = makeState({ rows: [row('A', { currentCardId: 'KS' })], active: 'A', topOfDeck: ['2C', '3C'] });
    let s = reducer(start, addCandidateCard('A'));
    s = reducer(s, addCandidateCard('A'));
    expect(byId(s, 'A').candidateIds).toEqual(['KS', '3C', '2C']);
    s = reducer(s, discardExtraCandidates('A'));
    expect(byId(s, 'A').candidateIds).toEqual(['KS']);
    expect(s.deck.discard).toEqual(['3C', '2C']);
    expectDeckInvariant(s);
  });

  it('is a no-op with no extra candidates', () => {
    const start = makeState({ rows: [row('A', { currentCardId: 'KS' })], active: 'A' });
    expect(reducer(start, discardExtraCandidates('A'))).toBe(start);
  });
});

describe('endInitiative', () => {
  it('keeps rows, clears cards and holds, resets the deck', () => {
    const start = makeState({
      privacy: true,
      rows: [row('A', { currentCardId: 'KS', onHold: true }), row('N', { type: 'NPC', revealed: true, currentCardId: '2C' })],
      active: 'A',
      round: 4,
    });
    const s = reducer(start, endInitiative());
    expect(ids(s)).toEqual(['A', 'N']);
    expect(s.rows.every(r => !r.onHold && !r.currentCardId && r.candidateIds.length === 0)).toBe(true);
    expect(byId(s, 'N').revealed).toBe(false);
    expect(s.deck.remaining).toHaveLength(54);
    expect(s).toMatchObject({ round: 0, phase: 'setup', turn: { activeRowId: null } });
  });
});

describe('no-op actions return the same reference', () => {
  const start = makeState({ rows: [row('A')], active: 'A' });
  it.each<[string, UnknownAction]>([
    ['unknown row hold', setHold({ id: 'x', value: true })],
    ['same hold value', setHold({ id: 'A', value: false })],
    ['same inactive value', setInactive({ id: 'A', value: false })],
    ['blank rename', renameParticipant({ id: 'A', name: '   ' })],
    ['remove unknown', removeParticipant('x')],
    ['loseHold unknown', loseHold('x')],
    ['startRound in round', startRound()],
    ['addCandidate unknown', addCandidateCard('x')],
    ['same privacy', setPrivacy(false)],
  ])('%s', (_name, action) => {
    expect(reducer(start, action)).toBe(start);
  });

  it('addCandidateCard outside a dealt round does nothing', () => {
    const setup = makeState({ phase: 'setup', rows: [row('A')] });
    expect(reducer(setup, addCandidateCard('A'))).toBe(setup);
  });

  // R4-A1: a reducer whose input changes nothing must not build new arrays/objects, or the
  // store stamps a new revision, writes the room and records an empty undo checkpoint.
  const dealt = (phase: Phase = 'in_round') =>
    makeState({
      phase,
      rows: [row('A', { currentCardId: 'KS' }), row('B', { currentCardId: 'QS' }), row('N', { type: 'NPC', currentCardId: '5C' })],
      active: phase === 'in_round' ? 'A' : null,
      privacy: true,
    });
  const fresh = () => ({ ...makeState({ phase: 'setup', round: 0, rows: [row('A'), row('N', { type: 'NPC', revealed: false })], privacy: true }) });
  it.each<[string, () => EncounterState, UnknownAction]>([
    ['selectKeeperCard with the only candidate (in round, acted)', () => dealt(), selectKeeperCard({ participantId: 'A', cardId: 'KS' })],
    ['selectKeeperCard with the only candidate (not acted)', () => dealt(), selectKeeperCard({ participantId: 'B', cardId: 'QS' })],
    ['selectKeeperCard with the only candidate (cards_dealt)', () => dealt('cards_dealt'), selectKeeperCard({ participantId: 'N', cardId: '5C' })],
    ['loseHold on a row with no card and no hold (setup)', () => fresh(), loseHold('A')],
    ['loseHold on a row with no card and no hold (between rounds)', () => ({ ...fresh(), phase: 'between_rounds' as Phase, round: 2 }), loseHold('A')],
    ['insertActNow after, already right after the active row', () => dealt(), insertActNow({ id: 'B', placement: 'after' })],
    ['endInitiative on a fresh setup', () => fresh(), endInitiative()],
    ['setRevealed same value', () => dealt(), setRevealed({ id: 'A', value: true })],
    ['setParticipantType same type', () => dealt(), setParticipantType({ id: 'N', type: 'NPC' })],
    ['renameParticipant same name', () => dealt(), renameParticipant({ id: 'A', name: ' A ' })],
    ['setActiveParticipant same row', () => dealt(), setActiveParticipant('A')],
    ['removeAllNpcsAndExtras with only PCs', () => makeState({ rows: [row('A')] }), removeAllNpcsAndExtras()],
    ['undoLastDraw with only the keeper', () => dealt(), undoLastDraw('A')],
    ['discardExtraCandidates with none', () => dealt(), discardExtraCandidates('A')],
    ['dealRound in round', () => dealt(), dealRound()],
    ['endRound outside a round', () => fresh(), endRound()],
  ])('%s', (_name, make, action) => {
    const state = make();
    expect(reducer(state, action)).toBe(state);
  });

  it('a no-op Choose Card is not stamped by the store', () => {
    const store = createAppStore({ writerId: 'me', getMinRevision: () => 0 });
    store.dispatch(restoreSnapshot(dealt()));
    const before = store.getState().swade;
    store.dispatch(selectKeeperCard({ participantId: 'B', cardId: 'QS' }));
    expect(store.getState().swade).toBe(before);
  });
});

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('deck invariant under random play', () => {
  it.each([1, 2, 3, 42])('seed %i: remaining + inPlay + discard = 54 unique, inPlay = row cards', (seed) => {
    const rng = mulberry32(seed);
    const seedOf = () => Math.floor(rng() * 0x1_0000_0000); // reproducible action seeds
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rng() * items.length)];
    const types = ['PC', 'NPC', 'GROUP'] as const;

    let s = initializeEmptyState(seed);
    for (let i = 0; i < 4; i++) s = reducer(s, createParticipant({ name: `R${i}`, type: pick(types) }));

    for (let step = 0; step < 600; step++) {
      const r = s.rows.length ? pick(s.rows) : undefined;
      const id = r?.id ?? 'none';
      const actions: UnknownAction[] = [
        dealRound(seedOf()),
        startRound(),
        endRound(seedOf()),
        endRound(seedOf()),
        createParticipant({ name: `N${step}`, type: pick(types) }, seedOf()),
        removeParticipant(id),
        setHold({ id, value: rng() < 0.3 }),
        setInactive({ id, value: rng() < 0.2 }),
        loseHold(id),
        addCandidateCard(id, seedOf()),
        addCandidateCard(id, seedOf()),
        undoLastDraw(id),
        discardExtraCandidates(id),
        insertActNow({ id, placement: rng() < 0.5 ? 'before' : 'after' }),
        setParticipantType({ id, type: pick(types) }),
      ];
      const next = s.rows.length ? pick(s.rows) : undefined;
      if (next) actions.push(setActiveParticipant(next.id));
      if (r && r.candidateIds.length) actions.push(selectKeeperCard({ participantId: id, cardId: pick(r.candidateIds) }));
      if (rng() < 0.01) actions.push(removeAllNpcsAndExtras(), endInitiative(seedOf()));

      s = reducer(s, pick(actions));
      expectDeckInvariant(s);
      if (s.turn.activeRowId) expect(s.rows.some(x => x.id === s.turn.activeRowId)).toBe(true);
    }
  });
});

describe('incapacitated Extras never take a turn (F-L1)', () => {
  const goons = () => row('G', { type: 'GROUP', inactive: true, revealed: false });

  it('Next does not land on an inactive GROUP and it is not revealed', () => {
    let s = makeState({ rows: [row('H'), goons()], phase: 'setup', privacy: true, round: 0 });
    s = reducer(s, dealRound());
    s = reducer(s, startRound());
    expect(s.turn.activeRowId).toBe('H');
    expect(byId(s, 'G').currentCardId).toBeUndefined();
    expect(selectNextParticipant(root(s))).toBeNull();
    expect(byId(s, 'G').revealed).toBe(false);
  });

  it('startRound skips an inactive GROUP when every other row is held', () => {
    const s0 = makeState({ rows: [row('H', { onHold: true }), goons()], phase: 'cards_dealt', privacy: true });
    const s = reducer(s0, startRound());
    expect(s.turn.activeRowId).toBeNull();
    expect(byId(s, 'G').revealed).toBe(false);
  });

  it('removing the active row does not hand the turn to an inactive GROUP', () => {
    const s0 = makeState({ rows: [row('H', { currentCardId: 'KS' }), goons()], active: 'H', privacy: true });
    const s = reducer(s0, removeParticipant('H'));
    expect(s.turn.activeRowId).toBeNull();
    expect(byId(s, 'G').revealed).toBe(false);
  });

  it('Previous with nobody active does not step back to an inactive GROUP with a card', () => {
    const s = makeState({ rows: [row('H', { currentCardId: 'KS' }), row('G', { type: 'GROUP', inactive: true, currentCardId: '2C' })] });
    expect(selectPreviousParticipant(root(s))?.id).toBe('H');
  });

  it('Act Now is a no-op for an incapacitated Extra on Hold or holding an unacted Joker (R3-L1)', () => {
    for (const extra of [
      row('G', { type: 'GROUP', inactive: true, onHold: true, revealed: false }),
      row('G', { type: 'GROUP', inactive: true, revealed: false, currentCardId: RED_JOKER_ID }),
    ]) {
      for (const active of ['A', null]) {
        const start = makeState({ rows: [row('A', { currentCardId: 'KS' }), extra], active, privacy: true });
        for (const placement of ['before', 'after'] as const) {
          expect(reducer(start, insertActNow({ id: 'G', placement }))).toBe(start);
        }
      }
    }
  });

  it('marking a held Extra incapacitated keeps the hold, which returns when it is revived (R3-L1)', () => {
    const start = makeState({ rows: [row('A', { currentCardId: 'KS' }), row('G', { type: 'GROUP', onHold: true })], active: 'A' });
    const down = reducer(start, setInactive({ id: 'G', value: true }));
    expect(byId(down, 'G').onHold).toBe(true);
    expect(selectNextParticipant(root(down))).toBeNull();
    const revived = reducer(down, setInactive({ id: 'G', value: false }));
    expect(byId(revived, 'G')).toMatchObject({ onHold: true, inactive: false });
  });

  it('an inactive PC or NPC still takes its turn (only Extras are skipped)', () => {
    const s = makeState({ rows: [row('H', { currentCardId: 'KS' }), row('N', { type: 'NPC', inactive: true, currentCardId: '2C' })], active: 'H' });
    expect(selectNextParticipant(root(s))?.id).toBe('N');
  });
});

describe('undoLastDraw keeps the Joker flag after a mid-round reshuffle (F-L3)', () => {
  it('undoing a non-Joker draw leaves the flag set', () => {
    // A Joker came up this round and was discarded; the deck then ran out and the
    // discard pile (Joker included) was shuffled back into the deck.
    const start = makeState({ rows: [row('A', { currentCardId: 'KS' })], active: 'A' });
    const jokers: CardId[] = [RED_JOKER_ID, BLACK_JOKER_ID];
    const rest = [...jokers, ...start.deck.remaining.filter(id => id !== '5S' && !jokers.includes(id))];
    identityShuffle(); // a non-Joker is drawn
    const s0: EncounterState = {
      ...start,
      deck: { remaining: ['5S'], inPlay: start.deck.inPlay, discard: rest, reshuffleAfterRound: true },
    };
    let s = reducer(s0, addCandidateCard('A')); // takes 5S; deck now empty
    s = reducer(s, addCandidateCard('A')); // reshuffles discard (Jokers) into the deck
    expect(s.deck.discard).toEqual([]);
    expect(byId(s, 'A').candidateIds.at(-1)).not.toMatch(/^JK/);
    s = reducer(s, undoLastDraw('A'));
    expect(s.deck.reshuffleAfterRound).toBe(true);
    expectDeckInvariant(s);
  });
});

describe('Joker flag with Undo Last Draw (all cases)', () => {
  /** Row A keeps KS; `top` is dealt next (last element first); the rest is discarded. */
  function startWith(top: CardId[]): EncounterState {
    const start = makeState({ rows: [row('A', { currentCardId: 'KS' })], active: 'A' });
    const discard = ALL_IDS.filter(id => id !== 'KS' && !top.includes(id));
    return { ...start, deck: { remaining: top, inPlay: ['KS'], discard, reshuffleAfterRound: false } };
  }

  it('one Joker dealt then undone clears the flag', () => {
    let s = reducer(startWith([BLACK_JOKER_ID, '5S', RED_JOKER_ID]), addCandidateCard('A')); // Black stays undealt
    expect(s.deck.reshuffleAfterRound).toBe(true);
    s = reducer(s, undoLastDraw('A'));
    expect(s.deck.reshuffleAfterRound).toBe(false);
    expectDeckInvariant(s);
  });

  it('both Jokers dealt, then one undone, keeps the flag; undoing both clears it', () => {
    let s = reducer(startWith(['5S', BLACK_JOKER_ID, RED_JOKER_ID]), addCandidateCard('A'));
    s = reducer(s, addCandidateCard('A'));
    s = reducer(s, undoLastDraw('A'));
    expect(s.deck.reshuffleAfterRound).toBe(true);
    s = reducer(s, undoLastDraw('A'));
    expect(s.deck.reshuffleAfterRound).toBe(false);
    expectDeckInvariant(s);
  });

  it('both Jokers dealt, one reshuffled back mid-round, the other undone: flag stays', () => {
    identityShuffle();
    let s = reducer(startWith([BLACK_JOKER_ID, '5S', RED_JOKER_ID]), addCandidateCard('A')); // Red
    s = reducer(s, addCandidateCard('A')); // 5S
    s = reducer(s, selectKeeperCard({ participantId: 'A', cardId: 'KS' })); // Red, 5S discarded
    s = reducer(s, addCandidateCard('A')); // Black; deck now empty
    s = reducer(s, addCandidateCard('A')); // reshuffle (Red back in the deck), draws 5S
    expect(s.deck.remaining).toContain(RED_JOKER_ID);
    expect(byId(s, 'A').candidateIds.at(-1)).toBe('5S');
    s = reducer(s, undoLastDraw('A')); // 5S
    s = reducer(s, undoLastDraw('A')); // Black
    expect(byId(s, 'A').candidateIds).toEqual(['KS']);
    expect(s.deck.reshuffleAfterRound).toBe(true);
    expectDeckInvariant(s);
  });

  it('a Joker reshuffled mid-round and dealt again keeps the flag when the second deal is undone', () => {
    identityShuffle();
    let s = reducer(startWith(['5S', RED_JOKER_ID]), addCandidateCard('A')); // Red
    s = reducer(s, discardExtraCandidates('A')); // Red discarded (top of discard)
    s = reducer(s, addCandidateCard('A')); // 5S; deck empty
    s = reducer(s, addCandidateCard('A')); // reshuffle, Red drawn again
    expect(byId(s, 'A').candidateIds.at(-1)).toBe(RED_JOKER_ID);
    s = reducer(s, undoLastDraw('A'));
    expect(s.deck.reshuffleAfterRound).toBe(true);
    expectDeckInvariant(s);
  });

  it('the only Joker, dealt after a mid-round reshuffle and undone, clears the flag', () => {
    identityShuffle();
    const s0 = startWith(['5S']);
    const discard = [...s0.deck.discard.filter(id => id !== RED_JOKER_ID), RED_JOKER_ID];
    let s = reducer({ ...s0, deck: { ...s0.deck, discard } }, addCandidateCard('A')); // 5S; deck empty
    s = reducer(s, addCandidateCard('A')); // reshuffle, Red drawn
    expect(byId(s, 'A').candidateIds.at(-1)).toBe(RED_JOKER_ID);
    s = reducer(s, undoLastDraw('A'));
    expect(s.deck.reshuffleAfterRound).toBe(false);
    expectDeckInvariant(s);
  });

  it('endRound resets the count, so a later single Joker undo clears the flag', () => {
    let s = reducer(startWith(['5S', BLACK_JOKER_ID, RED_JOKER_ID]), addCandidateCard('A'));
    s = reducer(s, addCandidateCard('A'));
    s = reducer(s, endRound());
    expect(s.deck.jokersDealtThisRound ?? 0).toBe(0);
  });

  it('a state without the count (older writer) falls back to the visible Jokers', () => {
    const start = makeState({ rows: [row('A', { candidateIds: ['KS', RED_JOKER_ID], currentCardId: 'KS' })], active: 'A' });
    expect(start.deck.jokersDealtThisRound).toBeUndefined();
    const s = reducer(start, undoLastDraw('A'));
    expect(s.deck.reshuffleAfterRound).toBe(false);
    expectDeckInvariant(s);
  });
});

describe('createParticipant image URL', () => {
  it('drops a non-https image URL', () => {
    const s0 = makeState({ phase: 'setup' });
    const s = reducer(s0, createParticipant({ name: 'X', type: 'PC', imageUrl: 'javascript:alert(1)' }));
    expect(s.rows[0].imageUrl).toBeUndefined();
    const s2 = reducer(s0, createParticipant({ name: 'Y', type: 'PC', imageUrl: 'http://x.test/a.png' }));
    expect(s2.rows[0].imageUrl).toBeUndefined();
  });

  it('keeps an https image URL', () => {
    const s = reducer(makeState({ phase: 'setup' }), createParticipant({ name: 'X', type: 'PC', imageUrl: 'https://x.test/a.png' }));
    expect(s.rows[0].imageUrl).toBe('https://x.test/a.png');
  });
});

describe('one turn rule for Next and Previous (TURN-FIX)', () => {
  const next = (s: EncounterState) => selectNextParticipant(root(s))?.id ?? null;
  const prev = (s: EncounterState) => selectPreviousParticipant(root(s))?.id ?? null;
  const step = (s: EncounterState, id: string | null) => reducer(s, setActiveParticipant(id));

  it('after Lose Turn, Previous then Next does not land on the row with no card (E2E bug A)', () => {
    let s = makeState({
      rows: [row('A', { currentCardId: 'AS' }), row('Pat', { currentCardId: 'KS' }), row('B', { currentCardId: 'QS' }), row('C', { currentCardId: '9S' })],
      active: 'A',
    });
    s = step(s, next(s)); // Pat
    s = reducer(s, setHold({ id: 'Pat', value: true }));
    s = step(s, next(s)); // B
    expect(s.turn.activeRowId).toBe('B');
    s = reducer(s, loseHold('Pat'));
    expect(ids(s)).toEqual(['A', 'Pat', 'B', 'C']);
    expect(prev(s)).toBe('A');
    s = step(s, prev(s));
    expect(next(s)).toBe('B');
  });

  it('an Extra revived mid-round gets no turn this round and is not revealed (R2-L3)', () => {
    let s = makeState({
      privacy: true,
      rows: [row('A', { currentCardId: 'KS' }), row('G', { type: 'GROUP', inactive: true, revealed: false }), row('B', { currentCardId: 'QS' })],
      active: 'A',
    });
    s = reducer(s, setInactive({ id: 'G', value: false }));
    expect(next(s)).toBe('B');
    s = step(s, 'B');
    expect(prev(s)).toBe('A');
    s = step(s, 'G');
    expect(byId(s, 'G').revealed).toBe(false);
    // It is dealt in as normal next round.
    s = reducer(reducer(s, endRound()), dealRound());
    expect(byId(s, 'G').currentCardId).toBeDefined();
  });

  it('Act Now After: a held-over row with no card gets the next turn, and Previous can step back to it', () => {
    let s = makeState({
      rows: [row('A', { currentCardId: 'KS' }), row('B', { currentCardId: 'QS' }), row('H', { onHold: true })],
      active: 'A',
    });
    s = reducer(s, insertActNow({ id: 'H', placement: 'after' }));
    expect(ids(s)).toEqual(['A', 'H', 'B']);
    expect(byId(s, 'H').actNowTurn).toBe(true);
    expect(next(s)).toBe('H');
    s = step(s, 'H');
    expect(next(s)).toBe('B');
    s = step(s, 'B');
    expect(prev(s)).toBe('H');
  });

  it('Act Now Before: a held-over row with no card acts now; Next goes on, Previous can step back to it', () => {
    let s = makeState({
      rows: [row('A', { currentCardId: 'KS' }), row('B', { currentCardId: 'QS' }), row('H', { onHold: true })],
      active: 'B',
    });
    s = reducer(s, insertActNow({ id: 'H', placement: 'before' }));
    expect(ids(s)).toEqual(['A', 'H', 'B']);
    expect(s.turn.activeRowId).toBe('H');
    expect(prev(s)).toBe('A');
    expect(next(s)).toBe('B');
    s = step(s, 'B');
    expect(prev(s)).toBe('H');
  });

  it('Act Now with a card held this round needs no flag', () => {
    const s = reducer(
      makeState({ rows: [row('A', { currentCardId: 'KS' }), row('H', { onHold: true, currentCardId: '2C' })], active: 'A' }),
      insertActNow({ id: 'H', placement: 'after' }),
    );
    expect(byId(s, 'H').actNowTurn).toBeUndefined();
    expect(next(s)).toBe('H');
  });

  it('the Act Now flag is cleared by End Round, End Initiative and Lose Turn', () => {
    const flagged = makeState({
      rows: [row('A', { currentCardId: 'KS' }), row('H', { actNowTurn: true })],
      active: 'A',
    });
    expect(byId(reducer(flagged, endRound()), 'H').actNowTurn).toBeUndefined();
    expect(byId(reducer(flagged, endInitiative()), 'H').actNowTurn).toBeUndefined();
    expect(byId(reducer(flagged, loseHold('H')), 'H').actNowTurn).toBeUndefined();
  });

  it('a late joiner is dealt a card and gets its turn from Next and Previous', () => {
    let s = makeState({ rows: [row('A', { currentCardId: 'KS' }), row('B', { currentCardId: '3C' })], active: 'A', topOfDeck: ['5D'] });
    s = reducer(s, createParticipant({ name: 'L', type: 'PC' }));
    const late = s.rows.find(r => r.name === 'L')!;
    expect(late.currentCardId).toBe('5D');
    expect(ids(s)).toEqual(['A', late.id, 'B']);
    expect(next(s)).toBe(late.id);
    s = step(s, 'B');
    expect(prev(s)).toBe(late.id);
  });

  it('an inactive Extra with a card is skipped by both Next and Previous', () => {
    const rows = [row('A', { currentCardId: 'KS' }), row('G', { type: 'GROUP', inactive: true, currentCardId: '9C' }), row('B', { currentCardId: '3C' })];
    expect(next(makeState({ rows, active: 'A' }))).toBe('B');
    expect(prev(makeState({ rows, active: 'B' }))).toBe('A');
  });
});

describe('reducers are pure and deterministic (seeded shuffles)', () => {
  /** States that reach every shuffle: deal, mid-round reshuffle on draw, end-of-round reshuffle. */
  function states(): EncounterState[] {
    const setup = makeState({ rows: [row('A'), row('B', { type: 'NPC' }), row('C', { type: 'GROUP' })], phase: 'setup', round: 0, privacy: true });
    const between = { ...setup, phase: 'between_rounds' as const, round: 2 };
    const dealt = makeState({ rows: [row('A', { currentCardId: 'KS' }), row('B', { currentCardId: '2C' })], phase: 'cards_dealt' });
    const inRound = makeState({ rows: [row('A', { currentCardId: 'KS' }), row('B', { currentCardId: RED_JOKER_ID })], active: 'A' });
    // Deck empty: the next draw reshuffles the discard pile.
    const emptyDeck: EncounterState = {
      ...inRound,
      deck: { ...inRound.deck, remaining: [], discard: inRound.deck.remaining, reshuffleAfterRound: true },
    };
    return [initializeEmptyState(1), setup, between, dealt, inRound, emptyDeck];
  }

  /** Every action (made before the Math.random spy: prepare callbacks may use it). */
  function actions(): UnknownAction[] {
    const made: UnknownAction[] = [
      dealRound(),
      startRound(),
      endRound(),
      endInitiative(),
      reset(),
      createParticipant({ name: 'Late', type: 'NPC' }),
      removeAllNpcsAndExtras(),
      setPrivacy(false),
      setActiveParticipant('B'),
      restoreSnapshot(makeState({})),
      setEncounterState(makeState({})),
    ];
    for (const id of ['A', 'B']) {
      made.push(
        addCandidateCard(id),
        undoLastDraw(id),
        discardExtraCandidates(id),
        selectKeeperCard({ participantId: id, cardId: 'KS' }),
        removeParticipant(id),
        setHold({ id, value: true }),
        setInactive({ id, value: true }),
        setRevealed({ id, value: true }),
        setParticipantType({ id, type: 'PC' }),
        renameParticipant({ id, name: 'New' }),
        loseHold(id),
        insertActNow({ id, placement: 'before' }),
        insertActNow({ id, placement: 'after' }),
      );
    }
    // Built by hand without a seed (e.g. an older logged action): still deterministic.
    made.push({ type: dealRound.type }, { type: endRound.type }, { type: addCandidateCard.type, payload: 'A' }, { type: reset.type });
    return made;
  }

  it('every reducer gives deep-equal results for the same state and action, without Math.random', () => {
    const all = actions();
    const bases = states();
    const random = vi.spyOn(Math, 'random');
    const cryptoRandom = vi.spyOn(globalThis.crypto, 'getRandomValues');    for (const state of bases) {
      for (const action of all) {
        const first = reducer(structuredClone(state), action);
        const second = reducer(structuredClone(state), action);
        expect(second, action.type).toEqual(first);
        expectDeckInvariant(first);
      }
    }
    expect(random).not.toHaveBeenCalled();
    expect(cryptoRandom).not.toHaveBeenCalled();
  });

  it('the action creators carry a seed; an explicit seed is kept', () => {
    for (const action of [dealRound(), endRound(), endInitiative(), reset(), addCandidateCard('A'), createParticipant({ name: 'X', type: 'PC' })]) {
      expect(typeof action.meta?.seed, action.type).toBe('number');
    }
    expect(dealRound(7).meta.seed).toBe(7);
    expect(addCandidateCard('A', 7)).toMatchObject({ payload: 'A', meta: { seed: 7 } });
  });

  it('replaying a dealRound on the same base deals the same cards and leaves the same deck', () => {
    const base = states()[1];
    const deal = dealRound();
    const a = reducer(base, deal);
    const b = reducer(structuredClone(base), deal);
    expect(b.deck).toEqual(a.deck);
    expect(b.rows.map(r => r.currentCardId)).toEqual(a.rows.map(r => r.currentCardId));
  });

  it('a seed decides each reshuffle: same seed same order, other seeds another order', () => {
    const start = states()[5];
    const draw = (seed: number) => reducer(start, addCandidateCard('A', seed)).deck.remaining;
    expect(draw(5)).toEqual(draw(5));
    expect(new Set([1, 2, 3, 4, 5].map(seed => draw(seed).join())).size).toBeGreaterThan(1);
    const between = { ...states()[4], deck: { ...states()[4].deck, reshuffleAfterRound: true } };
    const end = (seed: number) => reducer(between, endRound(seed)).deck.remaining;
    expect(end(9)).toEqual(end(9));
    expect(end(9)).not.toEqual(end(10));
    expect(reducer(start, reset(3)).deck).toEqual(initializeEmptyState(3).deck);
    expect(reducer(start, endInitiative(3)).deck).toEqual(reducer(start, endInitiative(3)).deck);
  });
});

describe('setActiveParticipant outside a round (R2-note1)', () => {
  it.each<Phase>(['setup', 'cards_dealt', 'between_rounds'])('is a no-op in %s', (phase) => {
    const s = makeState({ phase, rows: [row('A', { currentCardId: phase === 'cards_dealt' ? 'KS' : undefined }), row('N', { type: 'NPC', revealed: false })], privacy: true });
    expect(reducer(s, setActiveParticipant('A'))).toBe(s);
    expect(reducer(s, setActiveParticipant('N'))).toBe(s);
    expect(reducer(s, setActiveParticipant(null))).toBe(s);
  });

  it('still works in a round', () => {
    const s = makeState({ rows: [row('A', { currentCardId: 'KS' }), row('B', { currentCardId: 'QS' })], active: 'A' });
    expect(reducer(s, setActiveParticipant('B')).turn.activeRowId).toBe('B');
  });
});

describe('canAddCandidateCard (R4-nit2)', () => {
  const dealtRows = () => [row('A', { currentCardId: 'KS' })];
  it('is true only in a dealt round, for an existing row, with a card to draw', () => {
    expect(canAddCandidateCard(makeState({ phase: 'cards_dealt', rows: dealtRows() }), 'A')).toBe(true);
    expect(canAddCandidateCard(makeState({ phase: 'in_round', rows: dealtRows(), active: 'A' }), 'A')).toBe(true);
    for (const phase of ['setup', 'between_rounds'] as Phase[]) {
      expect(canAddCandidateCard(makeState({ phase, rows: [row('A')] }), 'A'), phase).toBe(false);
    }
    expect(canAddCandidateCard(makeState({ rows: dealtRows(), active: 'A' }), 'x')).toBe(false);
    expect(canAddCandidateCard(makeState({ rows: dealtRows(), active: 'A' }), null)).toBe(false);
    const empty = makeState({ rows: dealtRows(), active: 'A' });
    empty.deck.inPlay.push(...empty.deck.remaining);
    empty.deck.remaining = [];
    expect(canAddCandidateCard(empty, 'A')).toBe(false);
    empty.deck.discard = [empty.deck.inPlay.pop()!];
    expect(canAddCandidateCard(empty, 'A')).toBe(true);
  });

  it('agrees with the reducer: false exactly when addCandidateCard returns the same state', () => {
    const cases = [
      makeState({ phase: 'cards_dealt', rows: dealtRows() }),
      makeState({ rows: dealtRows(), active: 'A' }),
      makeState({ phase: 'setup', rows: [row('A')] }),
      makeState({ phase: 'between_rounds', rows: [row('A')] }),
    ];
    for (const s of cases) {
      for (const id of ['A', 'x']) {
        expect(reducer(s, addCandidateCard(id, 1)) !== s, `${s.phase} ${id}`).toBe(canAddCandidateCard(s, id));
      }
    }
  });
});

describe('turn navigation invariants under random play', () => {
  const nextId = (s: EncounterState) => selectNextParticipant(root(s))?.id ?? null;
  const prevId = (s: EncounterState) => selectPreviousParticipant(root(s))?.id ?? null;
  const active = (s: EncounterState) => s.rows.find(r => r.id === s.turn.activeRowId);

  /** Next and Previous as ControlBar does them: only when the selector names a row. */
  const navigate = (s: EncounterState, target: string | null) => (target ? reducer(s, setActiveParticipant(target)) : s);

  it.each([1, 2, 3, 7, 42, 99])('seed %i: Next/Previous agree; every newly active row can act and is revealed', (seed) => {
    const rng = mulberry32(seed);
    const seedOf = () => Math.floor(rng() * 0x1_0000_0000);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rng() * items.length)];
    const types = ['PC', 'NPC', 'GROUP'] as const;

    let s = initializeEmptyState(seed);
    s = reducer(s, setPrivacy(true));
    for (let i = 0; i < 5; i++) s = reducer(s, createParticipant({ name: `R${i}`, type: pick(types) }, seedOf()));

    for (let step = 0; step < 800; step++) {
      // Previous/Next agreement from the current position.
      if (s.phase === 'in_round') {
        const prev = prevId(s);
        const cur = active(s);
        if (prev) {
          const back = navigate(s, prev);
          expect(canTakeTurn(active(back)!), `step ${step}: Previous landed on a row Next skips`).toBe(true);
          if (cur && canTakeTurn(cur)) expect(nextId(back), `step ${step}: Next(Previous(x)) !== x`).toBe(cur.id);
          if (!cur) expect(nextId(back), `step ${step}: Next after stepping back into a finished round`).toBeNull();
        }
        const next = nextId(s);
        if (next && cur && canTakeTurn(cur)) {
          expect(prevId(navigate(s, next)), `step ${step}: Previous(Next(x)) !== x`).toBe(cur.id);
        }
      }

      const r = s.rows.length ? pick(s.rows) : undefined;
      const id = r?.id ?? 'none';
      const actions: UnknownAction[] = [
        dealRound(seedOf()),
        startRound(),
        startRound(),
        endRound(seedOf()),
        createParticipant({ name: `N${step}`, type: pick(types) }, seedOf()),
        removeParticipant(id),
        setHold({ id, value: rng() < 0.3 }),
        setInactive({ id, value: rng() < 0.2 }),
        loseHold(id),
        addCandidateCard(id, seedOf()),
        selectKeeperCard({ participantId: id, cardId: r?.candidateIds.at(-1) ?? 'none' }),
        insertActNow({ id, placement: rng() < 0.5 ? 'before' : 'after' }),
        setParticipantType({ id, type: pick(types) }),
        // UI navigation (weighted up so rounds get walked through).
        { type: 'nav/next' },
        { type: 'nav/next' },
        { type: 'nav/next' },
        { type: 'nav/prev' },
        // A raw jump in any phase: must be a no-op outside a round.
        ...(s.phase !== 'in_round' && r ? [setActiveParticipant(id)] : []),
      ];
      if (rng() < 0.01) actions.push(endInitiative(seedOf()));

      const action = pick(actions);
      const before = s;
      s = action.type === 'nav/next' ? navigate(s, nextId(s)) : action.type === 'nav/prev' ? navigate(s, prevId(s)) : reducer(s, action);

      // No active row outside a round.
      if (s.phase !== 'in_round') expect(s.turn.activeRowId, `step ${step}: ${action.type} in ${s.phase}`).toBeNull();
      // Every row that becomes active can take a turn and is revealed to players.
      if (s.turn.activeRowId && s.turn.activeRowId !== before.turn.activeRowId) {
        const now = active(s)!;
        expect(now, `step ${step}: ${action.type}`).toBeDefined();
        expect(canTakeTurn(now), `step ${step}: ${action.type} activated a row that cannot act`).toBe(true);
        expect(now.revealed, `step ${step}: ${action.type} activated a hidden row`).toBe(true);
      }
      expectDeckInvariant(s);
    }
  });
});

describe('setHold on an incapacitated Extra (final sweep)', () => {
  it('does not put an incapacitated Extra on Hold, but can clear an existing hold', () => {
    const s = makeState({
      rows: [row('g', { type: 'GROUP', inactive: true, currentCardId: 'KS', candidateIds: ['KS'] })],
      active: 'g',
    });
    expect(reducer(s, setHold({ id: 'g', value: true }))).toBe(s);
    const held = makeState({ rows: [row('g', { type: 'GROUP', inactive: true, onHold: true })], active: null });
    expect(byId(reducer(held, setHold({ id: 'g', value: false })), 'g').onHold).toBe(false);
  });
});
