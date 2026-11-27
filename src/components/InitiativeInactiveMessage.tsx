import PauseCircleOutlineIcon from "@mui/icons-material/PauseCircleOutlined";
import { PlayerPhaseMessage } from "./PlayerPhaseMessage";

export function InitiativeInactiveMessage() {
  return (
    <PlayerPhaseMessage
      icon={<PauseCircleOutlineIcon />}
      title="Initiative Not Active"
      text="Waiting for the GM to start initiative and deal action cards."
    />
  );
}
