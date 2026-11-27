// Undo Button Component
// Provides undo functionality with tooltip showing what will be undone

import { IconButton, Tooltip } from '@mui/material';
import UndoIcon from '@mui/icons-material/Undo';
import { useUndo } from '../hooks/useUndo';

export function UndoButton() {
  const { canUndo, undoDescription, performUndo } = useUndo();

  const tooltipTitle = !canUndo
    ? 'Nothing to undo'
    : undoDescription
      ? `Undo: ${undoDescription}`
      : 'Undo last action';

  return (
    <Tooltip disableInteractive title={tooltipTitle}>
      <span>
        <IconButton
          aria-label="Undo"
          onClick={performUndo}
          disabled={!canUndo}
          size="small"
          sx={{ color: canUndo ? 'text.primary' : 'text.disabled' }}
        >
          <UndoIcon fontSize="small" />
        </IconButton>
      </span>
    </Tooltip>
  );
}
