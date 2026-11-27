import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));
vi.mock("../store/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../store/store")>()),
  useSyncStatus: vi.fn(() => ({ status: "invalid", loaded: true, bytes: 0, nearLimit: false })),
}));

import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { obr, resetObrMock } from "../test/obrMock";
import { getRole, startSync, store, syncEngine } from "../store/store";
import { SyncStatusGate } from "../components/SyncStatusGate";
import { AppErrorBoundary } from "../components/AppErrorBoundary";
import { useRole } from "./useRole";

function ShowRole() {
  return <span>role: {useRole()}</span>;
}

beforeEach(() => {
  resetObrMock();
});

afterEach(() => {
  syncEngine.stop();
});

describe("useRole", () => {
  it("follows the player's role", async () => {
    obr().setRole("PLAYER");
    render(<ShowRole />);
    expect(await screen.findByText("role: PLAYER")).toBeInTheDocument();
    await act(async () => {
      obr().setRole("GM");
    });
    expect(screen.getByText("role: GM")).toBeInTheDocument();
  });

  it("stops the subscription when the last user unmounts", async () => {
    const { unmount } = render(<ShowRole />);
    await act(async () => {});
    expect(obr().emitters.player.size).toBe(1);
    unmount();
    expect(obr().emitters.player.size).toBe(0);
  });

  // Last: startSync keeps its subscription for the rest of the file.
  it("keeps one player.onChange subscription per iframe, in StrictMode too", async () => {
    render(
      <StrictMode>
        <Provider store={store}>
          <AppErrorBoundary>
            <SyncStatusGate>
              <ShowRole />
            </SyncStatusGate>
            <ShowRole />
          </AppErrorBoundary>
        </Provider>
      </StrictMode>
    );
    await act(async () => {
      await startSync();
    });

    expect(obr().emitters.player.size).toBe(1);
    expect(getRole()).toBe("GM");
    expect(screen.getByRole("button", { name: "Reset tracker" })).toBeInTheDocument();

    await act(async () => {
      obr().setRole("PLAYER");
    });
    expect(getRole()).toBe("PLAYER");
    expect(screen.getAllByText("role: PLAYER")).toHaveLength(1);
    expect(screen.getByText("Ask the GM to reset the tracker.")).toBeInTheDocument();
  });
});
