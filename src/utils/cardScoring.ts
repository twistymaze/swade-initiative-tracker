// SWADE Card Scoring Utility
// Shared function to avoid circular dependencies between slices and selectors

import { CardId } from "../store/types";
import { BLACK_JOKER_ID, RANKS, RED_JOKER_ID, SUITS, getCardId } from "./cardIds";

/**
 * Score table for all 54 cards. Higher scores go first in initiative order.
 *
 * - Black Joker: 1001 (highest)
 * - Red Joker: 1000
 * - Regular cards: rank * 10 + suit
 *   - Ranks: A=14, K=13, Q=12, J=11, 10=10, ..., 2=2
 *   - Suits: S=4, H=3, D=2, C=1
 */
const CARD_SCORES: Record<CardId, number> = (() => {
  const scores: Record<CardId, number> = {
    [BLACK_JOKER_ID]: 1001,
    [RED_JOKER_ID]: 1000,
  };
  RANKS.forEach((rank, rankIndex) => {
    SUITS.forEach((suit, suitIndex) => {
      scores[getCardId(rank, suit)] = (14 - rankIndex) * 10 + (4 - suitIndex);
    });
  });
  return scores;
})();

/**
 * Calculate the SWADE initiative score for a card.
 * Returns -1 for no card and 0 for an unknown card ID.
 */
export const getCardScore = (cardId: CardId | undefined): number => {
  if (!cardId) return -1;
  return CARD_SCORES[cardId] ?? 0;
};
