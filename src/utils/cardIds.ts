// SWADE Initiative Tracker - Card ID Utilities

import { CardId, Suit, Rank, Card } from "../store/types";

// Card ID constants
export const RED_JOKER_ID = 'JK-R' as const;
export const BLACK_JOKER_ID = 'JK-B' as const;

/** Suits in SWADE precedence order (Spades > Hearts > Diamonds > Clubs) */
export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'];

/** Ranks from high to low (Ace high) */
export const RANKS: readonly Rank[] = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];

const SUIT_SYMBOLS: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

/**
 * Generate deterministic card ID from rank and suit
 * Examples: "AS" (Ace of Spades), "10H" (Ten of Hearts), "JK-R" (Red Joker)
 */
export function getCardId(rank: Rank | 'JOKER', suit?: Suit, jokerColor?: 'RED' | 'BLACK'): CardId {
  if (rank === 'JOKER') {
    return jokerColor === 'RED' ? RED_JOKER_ID : BLACK_JOKER_ID;
  }
  return `${rank}${suit}`;
}

/** True when the card ID is either Joker */
export function isJokerId(cardId: CardId | null | undefined): boolean {
  return cardId === RED_JOKER_ID || cardId === BLACK_JOKER_ID;
}

/**
 * Generate all card IDs for a standard 54-card deck
 */
export function generateAllCardIds(): CardId[] {
  const cardIds: CardId[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cardIds.push(getCardId(rank, suit));
    }
  }
  cardIds.push(RED_JOKER_ID, BLACK_JOKER_ID);
  return cardIds;
}

/**
 * Create a complete cards lookup table with labels
 */
export function buildCardsLookup(): Record<CardId, Card> {
  const cards: Record<CardId, Card> = {};

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      const cardId = getCardId(rank, suit);
      cards[cardId] = { id: cardId, rank, suit, label: `${rank}${SUIT_SYMBOLS[suit]}` };
    }
  }

  cards[RED_JOKER_ID] = { id: RED_JOKER_ID, rank: 'JOKER', jokerColor: 'RED', label: 'Joker' };
  cards[BLACK_JOKER_ID] = { id: BLACK_JOKER_ID, rank: 'JOKER', jokerColor: 'BLACK', label: 'Joker' };

  return cards;
}

/** Static lookup of all 54 cards (never changes). */
export const CARDS: Readonly<Record<CardId, Card>> = buildCardsLookup();

/**
 * Text name of a card for screen readers and tooltips. The Jokers share the visible label
 * "Joker" (only the colour differs), so their names say the colour.
 */
export function getCardName(cardId: CardId): string {
  if (cardId === RED_JOKER_ID) return 'Red Joker';
  if (cardId === BLACK_JOKER_ID) return 'Black Joker';
  return CARDS[cardId]?.label ?? cardId;
}
