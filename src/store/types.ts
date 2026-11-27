// SWADE Initiative Tracker - Core Type Definitions

export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rank = 'A' | 'K' | 'Q' | 'J' | '10' | '9' | '8' | '7' | '6' | '5' | '4' | '3' | '2';

export type CardId = string; // deterministic id: "AS", "10H", "JK-R", "JK-B"

export interface Card {
  id: CardId;            // deterministic: rank+suit or "JK-R"/"JK-B"
  rank: Rank | 'JOKER';
  suit?: Suit;           // undefined for Jokers
  jokerColor?: 'RED' | 'BLACK'; // defined only when rank==='JOKER'
  label: string;         // e.g., 'A♠', '10♦', 'Red Joker', 'Black Joker'
}

export interface Deck {
  remaining: CardId[];    // top of deck is end of array (pop)
  inPlay: CardId[];       // cards currently assigned to participants
  discard: CardId[];
  reshuffleAfterRound: boolean; // true if any Joker appeared this round
  /**
   * Joker deals this round, net of Undo Last Draw (a Joker reshuffled mid-round and dealt
   * again counts twice). Optional: absent in states from older writers (treated as 0).
   */
  jokersDealtThisRound?: number;
}

export type ParticipantType = 'PC' | 'NPC' | 'GROUP';

export interface ParticipantRow {
  id: string;                 // short row id (distinct from OBR item id)
  name: string;               // display name
  imageUrl?: string;          // https URL of token image for avatar display
  type: ParticipantType;
  inactive: boolean;
  onHold: boolean;            // carryover hold into subsequent rounds
  revealed: boolean;          // true if visible to players (privacy system)

  // Cards for the current round
  currentCardId?: CardId;     // keeper for this round (optional if holding into new round)
  candidateIds: CardId[];     // drawn this round (includes current if already chosen)
  /**
   * True when the row has a turn this round from Act Now but no card (it was held over
   * from an earlier round). Optional: omitted when false; cleared at End Round, End
   * Initiative and Lose Turn.
   */
  actNowTurn?: boolean;
}

export interface Settings {
  hideNpcFromPlayers: boolean; // global privacy toggle
}

export type Phase = 'setup' | 'between_rounds' | 'cards_dealt' | 'in_round';

/** Identifies one state: the writer's iframe id and the revision it stamped. */
export interface StateIdentity {
  revision: number;
  writerId: string;
}

export interface EncounterState {
  version: 2;
  round: number;               // 0 before first deal; increments each Deal Round
  phase: Phase;
  deck: Deck;
  rows: ParticipantRow[];      // array in display order
  turn: {
    activeRowId: string | null;
  };
  settings: Settings;
  /** Stamped centrally (store.ts) on every local change; with writerId it identifies a state. */
  revision: number;
  /** Id of the iframe that made the last change ("" for migrated or fresh states). */
  writerId: string;
}
