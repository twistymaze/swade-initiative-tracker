import { Chip, useTheme, type SxProps, type Theme } from "@mui/material";
import { getBaseCardStyle } from "../utils/cardStyles";
import { CARDS, getCardName, isJokerId } from "../utils/cardIds";

interface ActionCardProps {
  cardId: string;
  /** When omitted the card is not interactive (no button role, no pointer). */
  onClick?: () => void;
  /** Set for a selectable card (chooser): shown as a toggle button. */
  selected?: boolean;
  /** Replaces the accessible name; it must name the card itself (use getCardName). */
  ariaLabel?: string;
  sx?: SxProps<Theme>;
}

/** A SWADE action card shown as a white chip with red/black text. */
export function ActionCard({ cardId, onClick, selected, ariaLabel, sx }: ActionCardProps) {
  const theme = useTheme();
  const card = CARDS[cardId];

  if (!card) {
    console.warn(`[ActionCard] Unknown card ID: ${cardId}`);
    return null;
  }

  // The Jokers look alike except for colour: name the colour in the label and tooltip.
  const jokerName = isJokerId(cardId) ? getCardName(cardId) : undefined;
  const label = ariaLabel ?? jokerName;

  return (
    <Chip
      label={card.label}
      size="small"
      onClick={onClick}
      aria-label={label}
      title={jokerName}
      aria-pressed={onClick && selected !== undefined ? selected : undefined}
      sx={[
        {
          ...getBaseCardStyle(cardId, theme),
          outline: selected ? "3px solid" : "none",
          outlineColor: selected ? "error.main" : "transparent",
          outlineOffset: "2px",
        },
        !onClick && { cursor: "default" },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    />
  );
}
