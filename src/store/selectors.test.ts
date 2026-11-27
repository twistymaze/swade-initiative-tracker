import { describe, expect, it } from 'vitest';
import {
  selectActiveIndex,
  selectActiveParticipant,
  selectDeckCounts,
  selectDeckCountsForRole,
  selectHasActed,
  selectNextParticipant,
  selectPreviousParticipant,
  selectVisibleParticipants,
} from './selectors';
import type { RootState } from './store';
import { initializeEmptyState } from './initialState';
import type { EncounterState, ParticipantRow, Phase } from './types';

function row(id: string, overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return { id, name: id, type: 'PC', inactive: false, onHold: false, revealed: true, candidateIds: [], ...overrides };
}

function rootState(opts: { rows: ParticipantRow[]; active?: string | null; privacy?: boolean; phase?: Phase }): RootState {
  const base = initializeEmptyState();
  const swade: EncounterState = {
    ...base,
    phase: opts.phase ?? 'in_round',
    rows: opts.rows,
    turn: { activeRowId: opts.active ?? null },
    settings: { hideNpcFromPlayers: opts.privacy ?? true },
    deck: { ...base.deck, remaining: base.deck.remaining.slice(4), inPlay: base.deck.remaining.slice(0, 3), discard: base.deck.remaining.slice(3, 4) },
  };
  return { swade } as RootState;
}

describe('selectVisibleParticipants (privacy matrix)', () => {
  const rows = [row('pc'), row('hidden', { type: 'NPC', revealed: false }), row('shown', { type: 'NPC', revealed: true })];

  it.each([
    ['GM', true, ['pc', 'hidden', 'shown']],
    ['GM', false, ['pc', 'hidden', 'shown']],
    ['PLAYER', true, ['pc', 'shown']],
    ['PLAYER', false, ['pc', 'hidden', 'shown']],
    [undefined, true, ['pc', 'shown']],
  ] as const)('role %s, privacy %s', (role, privacy, expected) => {
    const visible = selectVisibleParticipants(rootState({ rows, privacy }), role);
    expect(visible.map(r => r.id)).toEqual(expected);
  });

  it('a player with privacy on never receives an unrevealed row', () => {
    const visible = selectVisibleParticipants(rootState({ rows, privacy: true }), 'PLAYER');
    expect(visible.every(r => r.revealed)).toBe(true);
  });
});

describe('selectDeckCountsForRole (GL11)', () => {
  it('GM sees all counts', () => {
    const s = rootState({ rows: [] });
    expect(selectDeckCountsForRole(s, 'GM')).toEqual({ remaining: 50, inPlay: 3, discard: 1, total: 54 });
    expect(selectDeckCounts(s).total).toBe(54);
  });

  it('players with privacy on see no deck counts (F-L2)', () => {
    expect(selectDeckCountsForRole(rootState({ rows: [], privacy: true }), 'PLAYER')).toBeNull();
  });

  it('players with privacy off see all counts', () => {
    expect(selectDeckCountsForRole(rootState({ rows: [], privacy: false }), 'PLAYER')).toMatchObject({ inPlay: 3 });
  });
});

describe('turn navigation', () => {
  const rows = [row('A', { currentCardId: 'KS' }), row('B', { onHold: true }), row('C', { currentCardId: '9S' }), row('D', { onHold: true })];

  it('Next skips held rows and stops at the end', () => {
    expect(selectNextParticipant(rootState({ rows, active: 'A' }))?.id).toBe('C');
    expect(selectNextParticipant(rootState({ rows, active: 'C' }))).toBeNull();
  });

  it('Previous skips held rows', () => {
    expect(selectPreviousParticipant(rootState({ rows, active: 'C' }))?.id).toBe('A');
    expect(selectPreviousParticipant(rootState({ rows, active: 'A' }))).toBeNull();
  });

  it('with no active row outside a round both are null', () => {
    const s = rootState({ rows, active: null, phase: 'cards_dealt' });
    expect(selectNextParticipant(s)).toBeNull();
    expect(selectPreviousParticipant(s)).toBeNull();
    expect(selectActiveParticipant(s)).toBeNull();
    expect(selectActiveIndex(s)).toBe(-1);
  });

  it('in a round with nobody active: Next is null (no wrap), Previous is the last row that can act', () => {
    const s = rootState({ rows, active: null });
    expect(selectNextParticipant(s)).toBeNull();
    expect(selectPreviousParticipant(s)?.id).toBe('C');
    expect(selectPreviousParticipant(rootState({ rows: [row('H', { onHold: true })], active: null }))).toBeNull();
    expect(selectActiveParticipant(s)).toBeNull();
    expect(selectActiveIndex(s)).toBe(-1);
  });

  it('selectActiveIndex and selectActiveParticipant', () => {
    const s = rootState({ rows, active: 'C' });
    expect(selectActiveIndex(s)).toBe(2);
    expect(selectActiveParticipant(s)?.id).toBe('C');
  });
});

describe('selectHasActed (GL10)', () => {
  const rows = [row('A'), row('B'), row('C')];

  it('rows above the active row have acted; the active row and rows below have not', () => {
    const s = rootState({ rows, active: 'B' });
    expect(selectHasActed(s, 'A')).toBe(true);
    expect(selectHasActed(s, 'B')).toBe(false);
    expect(selectHasActed(s, 'C')).toBe(false);
    expect(selectHasActed(s, 'missing')).toBe(false);
  });

  it('in a round with nobody active, every row that is not held has acted', () => {
    const s = rootState({ rows: [row('A'), row('H', { onHold: true })], active: null });
    expect(selectHasActed(s, 'A')).toBe(true);
    expect(selectHasActed(s, 'H')).toBe(false);
    expect(selectHasActed(s, 'missing')).toBe(false);
  });

  it('is false outside a running round', () => {
    expect(selectHasActed(rootState({ rows, active: 'C', phase: 'cards_dealt' }), 'A')).toBe(false);
  });
});
