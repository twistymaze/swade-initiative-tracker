import type { EncounterState } from './types';
import { generateAllCardIds } from '../utils/cardIds';
import { fisherYatesShuffle, randomSeed, seededRandom } from '../utils/shuffle';

/**
 * A fresh encounter: no rows, full shuffled deck, revision 0, no writer.
 * The same `seed` always gives the same deck order (reducers pass the action's seed).
 */
export function initializeEmptyState(seed: number = randomSeed()): EncounterState {
  return {
    version: 2,
    round: 0,
    phase: 'setup',
    deck: {
      remaining: fisherYatesShuffle(generateAllCardIds(), seededRandom(seed)),
      inPlay: [],
      discard: [],
      reshuffleAfterRound: false,
    },
    rows: [],
    turn: { activeRowId: null },
    settings: { hideNpcFromPlayers: true },
    revision: 0,
    writerId: '',
  };
}
