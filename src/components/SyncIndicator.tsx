import { Box, Chip, Tooltip } from "@mui/material";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import WarningIcon from "@mui/icons-material/Warning";
import { retrySync, useSyncStatus } from "../store/store";

interface SyncIndicatorProps {
  role?: "GM" | "PLAYER";
}

/**
 * Shows save problems after the tracker loaded: a failed write (`error`), a state
 * too large for the room (`too-large`), or a state near the room size limit.
 * A GM can click either "Not saved" chip to retry the write now.
 */
export function SyncIndicator({ role }: SyncIndicatorProps) {
  const { status, nearLimit } = useSyncStatus();
  const isGm = role === "GM";

  if (status === "error") {
    return (
      <Box component="span" role="status">
        <Tooltip disableInteractive title={isGm ? "Changes could not be saved to the room. Click to retry now." : "Changes could not be saved to the room."}>
          <Chip
            size="small"
            color="error"
            variant="outlined"
            icon={<CloudOffIcon />}
            label={isGm ? "Not saved – retry" : "Not saved"}
            onClick={isGm ? () => void retrySync() : undefined}
          />
        </Tooltip>
      </Box>
    );
  }
  if (status === "too-large") {
    return (
      <Box component="span" role="status">
        <Tooltip disableInteractive title={isGm ? "Too much data to save in this room. Remove some combatants, or click to retry now." : "Too much data to save in this room."}>
          <Chip
            size="small"
            color="error"
            variant="outlined"
            icon={<WarningIcon />}
            label="Not saved – too large"
            onClick={isGm ? () => void retrySync() : undefined}
          />
        </Tooltip>
      </Box>
    );
  }
  if (nearLimit) {
    return (
      <Tooltip disableInteractive title="Room storage is almost full. Remove some combatants.">
        <Chip role="status" size="small" color="warning" variant="outlined" icon={<WarningIcon />} label="Storage almost full" />
      </Tooltip>
    );
  }
  return null;
}
