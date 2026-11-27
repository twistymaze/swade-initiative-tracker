import OBR from "@owlbear-rodeo/sdk";
import { ReactNode, useEffect, useState } from "react";

/**
 * Render the children only inside Owlbear Rodeo, after the SDK is ready.
 * Used once, in main.tsx.
 */
export function PluginGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (OBR.isAvailable) {
      OBR.onReady(() => setReady(true));
    }
  }, []);

  return ready ? <>{children}</> : null;
}
