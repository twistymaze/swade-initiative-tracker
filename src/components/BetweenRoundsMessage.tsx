import AutorenewIcon from "@mui/icons-material/Autorenew";
import { PlayerPhaseMessage } from "./PlayerPhaseMessage";

export function BetweenRoundsMessage() {
  return (
    <PlayerPhaseMessage
      icon={<AutorenewIcon />}
      title="End of Round"
      text="Resolve expiring effects, upkeep for powers & conditions, bleeding out rolls, ongoing environmental damage, etc."
      align="left"
    />
  );
}
