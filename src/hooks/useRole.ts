import { useSyncExternalStore } from "react";
import { getRole, subscribeRole, type Role } from "../store/store";

/** This player's role. All users in one iframe share one OBR subscription (see store.ts). */
export function useRole(): Role {
  return useSyncExternalStore(subscribeRole, getRole);
}
