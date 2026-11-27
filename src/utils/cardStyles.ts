import { CARDS } from "./cardIds";
import { Theme } from "@mui/material/styles";

const BASE_STYLE = {
  cursor: 'pointer',
  fontWeight: 'bold',
  minWidth: '50px',
  height: '28px',
  '& .MuiChip-label': {
    px: 1,
    fontSize: '1.2rem'
  },
  '&:hover': {
    // Cards should always be white like real playing cards
    backgroundColor: 'white',
    transform: 'none',
    opacity: 1
  }
};

/** Text colour for a card: red for hearts, diamonds and the Red Joker; black otherwise */
export const getCardColor = (cardId: string): 'red' | 'black' => {
  const card = CARDS[cardId];
  if (!card) return 'black';
  if (card.rank === 'JOKER') return card.jokerColor === 'BLACK' ? 'black' : 'red';
  return card.suit === 'H' || card.suit === 'D' ? 'red' : 'black';
};

export const getBaseCardStyle = (cardId: string, theme: Theme) => ({
  color: getCardColor(cardId),
  bgcolor: 'white',
  border: `1px solid ${theme.palette.divider}`,
  ...BASE_STYLE
});
