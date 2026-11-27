import { Stack } from "@mui/material";

import { HeaderBar } from "./components/HeaderBar";
import { ParticipantList } from "./components/ParticipantList";
import { ControlBar } from "./components/ControlBar";
import { BetweenRoundsMessage } from "./components/BetweenRoundsMessage";
import { InitiativeInactiveMessage } from "./components/InitiativeInactiveMessage";
import { PhaseReminder } from "./components/PhaseReminder";
import { useAppSelector } from "./store/hooks";
import { selectPhase } from "./store/selectors";
import { useObrPanelHeight } from "./hooks/useObrPanelHeight";
import { useRole } from "./hooks/useRole";

// Token context menus are registered by the background page (src/background.ts).
export function InitiativeTracker() {
  const role = useRole();
  const phase = useAppSelector(selectPhase);

  const { containerRef, participantListRef, maxHeight } = useObrPanelHeight();

  return (
    <Stack ref={containerRef} sx={{ pb: 0, maxHeight }}>
      <HeaderBar role={role} />

      {/* Show different content for players vs GMs during special phases */}
      {phase === "setup" && role === "PLAYER" ? (
        <InitiativeInactiveMessage />
      ) : phase === "between_rounds" && role === "PLAYER" ? (
        <BetweenRoundsMessage />
      ) : (
        <ParticipantList role={role} ref={participantListRef} />
      )}

      {/* Phase-specific reminders - compact panels above ControlBar */}
      {phase === "between_rounds" && role === "GM" && (
        <PhaseReminder 
          title="End of Round"
          description="Resolve effects, upkeep, bleeding out, and environmental damage."
        />
      )}
      
      {phase === "cards_dealt" && (
        <PhaseReminder
          title="Cards Dealt"
          description={role === "GM" 
            ? "Make card adjustments now (Bennies, Edges, Hindrances, etc.)"
            : "Request card adjustments now (Bennies, Edges, Hindrances, etc.)"
          }
        />
      )}

      <ControlBar role={role} />
    </Stack>
  );
}
