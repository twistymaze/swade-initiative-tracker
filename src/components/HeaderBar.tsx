import { useState, type MouseEvent } from "react";
import {
  Divider,
  Typography,
  Box,
  IconButton,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Tooltip,
} from "@mui/material";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import OBR from "@owlbear-rodeo/sdk";

import { useAppSelector, useAppDispatch } from "../store/hooks";
import { selectRound, selectPhase, selectDeckCountsForRole, selectPrivacyMode } from "../store/selectors";
import { reset, setPrivacy, removeAllNpcsAndExtras } from "../store/swadeSlice";
import { getPluginId } from "../getPluginId";
import { useUndo } from "../hooks/useUndo";
import { UndoButton } from "./UndoButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { SyncIndicator } from "./SyncIndicator";

interface HeaderBarProps {
  role?: "GM" | "PLAYER";
}

export function HeaderBar({ role }: HeaderBarProps) {
  const dispatch = useAppDispatch();
  const round = useAppSelector(selectRound);
  const phase = useAppSelector(selectPhase);
  const deckCounts = useAppSelector((state) => selectDeckCountsForRole(state, role));
  const privacyEnabled = useAppSelector(selectPrivacyMode);
  const { captureCheckpoint, clearUndoHistory } = useUndo();

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  // Controlled so a click closes it: the title changes on click, and the button keeps
  // focus, so a focus-opened tooltip would otherwise stay up after the mouse leaves.
  const [privacyTipOpen, setPrivacyTipOpen] = useState(false);

  const handleAddParticipant = () => {
    // The modal captures its own undo checkpoint when it adds a combatant.
    OBR.modal
      .open({
        id: getPluginId("add-participant"),
        url: "/?view=add-participant",
        width: 400,
        height: 220,
        hideBackdrop: false,
      })
      .catch((error) => console.error("[SWADE] Failed to open the add combatant modal", error));
  };

  const handleTogglePrivacy = () => {
    setPrivacyTipOpen(false);
    captureCheckpoint(privacyEnabled ? "Disable Privacy" : "Enable Privacy");
    dispatch(setPrivacy(!privacyEnabled));
  };

  const handleMenuOpen = (event: MouseEvent<HTMLElement>) => setMenuAnchor(event.currentTarget);
  const handleMenuClose = () => setMenuAnchor(null);

  const handleFullResetClick = () => {
    handleMenuClose();
    setConfirmResetOpen(true);
  };

  const handleConfirmReset = () => {
    setConfirmResetOpen(false);
    clearUndoHistory();
    // A normal change: the sync engine writes the fresh state (and notifies on failure).
    dispatch(reset());
  };

  const handleRemoveAllNpcsAndExtras = () => {
    handleMenuClose();
    captureCheckpoint("Remove All NPCs/Extras");
    dispatch(removeAllNpcsAndExtras());
  };

  return (
    <>
      <Box sx={{ px: 2, py: 1.5 }}>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 0.5 }}>
          <Typography variant="h6" sx={{ fontSize: "1.125rem", fontWeight: "bold", color: "text.primary" }}>
            Initiative
          </Typography>
          {role === "GM" && (
            <Box sx={{ display: "flex", gap: 0.5 }}>
              <UndoButton />
              <Tooltip
                disableInteractive
                title={privacyEnabled ? "Hide NPCs by default from players" : "Show all combatants to players"}
                open={privacyTipOpen}
                onOpen={() => setPrivacyTipOpen(true)}
                onClose={() => setPrivacyTipOpen(false)}
                disableFocusListener
              >
                <IconButton
                  aria-label={privacyEnabled ? "Disable privacy" : "Enable privacy"}
                  onClick={handleTogglePrivacy}
                  size="small"
                  sx={{ color: "text.primary" }}
                >
                  {privacyEnabled ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
              <Tooltip disableInteractive title="Add Combatant Manually">
                <IconButton aria-label="Add combatant" onClick={handleAddParticipant} size="small" sx={{ color: "primary.main" }}>
                  <PersonAddIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip disableInteractive title="More Options">
                <IconButton aria-label="More options" onClick={handleMenuOpen} size="small" sx={{ color: "text.secondary" }}>
                  <MoreVertIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          )}
        </Box>
        <Box sx={{ display: "flex", gap: 2, alignItems: "baseline", flexWrap: "wrap" }}>
          <Typography variant="subtitle1" color="text.primary" sx={{ fontWeight: 500 }}>
            {phase === "setup" ? "Not Active" : `Round ${round}`}
          </Typography>
          {/* Null for players with privacy on: deck counts would reveal hidden combatants. */}
          {deckCounts && (
            <Typography variant="body2" color="text.secondary">
              Deck: {deckCounts.remaining}R • {deckCounts.inPlay}P • {deckCounts.discard}D
            </Typography>
          )}
          <SyncIndicator role={role} />
        </Box>
      </Box>

      {role === "GM" && (
        <>
          <Menu
            anchorEl={menuAnchor}
            open={Boolean(menuAnchor)}
            onClose={handleMenuClose}
            transformOrigin={{ horizontal: "right", vertical: "top" }}
            anchorOrigin={{ horizontal: "right", vertical: "bottom" }}
          >
            <MenuItem onClick={handleRemoveAllNpcsAndExtras}>
              <ListItemIcon>
                <DeleteSweepIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="Remove All NPCs/Extras" />
            </MenuItem>
            <MenuItem onClick={handleFullResetClick}>
              <ListItemIcon>
                <RestartAltIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="Full Reset" />
            </MenuItem>
          </Menu>
          <ConfirmDialog
            open={confirmResetOpen}
            title="Reset the tracker?"
            message="This removes all combatants and restarts from scratch. It cannot be undone."
            confirmLabel="Reset"
            onConfirm={handleConfirmReset}
            onCancel={() => setConfirmResetOpen(false)}
          />
        </>
      )}

      <Divider variant="middle" />
    </>
  );
}
