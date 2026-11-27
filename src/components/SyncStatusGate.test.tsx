import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));
vi.mock("../store/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../store/store")>()),
  useSyncStatus: vi.fn(),
}));

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { obr, resetObrMock } from "../test/obrMock";
import { store, useSyncStatus } from "../store/store";
import type { SyncSnapshot, SyncStatus } from "../store/syncEngine";
import { createParticipant } from "../store/swadeSlice";
import { SyncStatusGate } from "./SyncStatusGate";

const mocked = vi.mocked(useSyncStatus);
const snapshot = (status: SyncStatus, loaded: boolean): SyncSnapshot => ({ status, loaded, bytes: 0, nearLimit: false });

beforeEach(() => {
  resetObrMock();
});

const renderGate = () => render(<SyncStatusGate><div>tracker</div></SyncStatusGate>);

describe("SyncStatusGate", () => {
  it("shows a spinner while loading", () => {
    mocked.mockReturnValue(snapshot("loading", false));
    renderGate();
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    expect(screen.queryByText("tracker")).not.toBeInTheDocument();
  });

  it("shows a 'cannot reach' panel when the first read keeps failing", () => {
    mocked.mockReturnValue(snapshot("error", false));
    renderGate();
    expect(screen.getByText("Cannot reach the room")).toBeInTheDocument();
    expect(screen.queryByText("tracker")).not.toBeInTheDocument();
  });

  it.each(["ready", "absent-player", "error", "too-large"] as const)("shows the children once loaded with status %s", (status) => {
    mocked.mockReturnValue(snapshot(status, true));
    renderGate();
    expect(screen.getByText("tracker")).toBeInTheDocument();
  });

  it("asks for a reload when the room holds a newer version", () => {
    mocked.mockReturnValue(snapshot("too-new", true));
    renderGate();
    expect(screen.getByText("A newer version of the initiative tracker is in use")).toBeInTheDocument();
    expect(screen.queryByText("tracker")).not.toBeInTheDocument();
  });

  it("invalid data: a player is told to ask the GM", async () => {
    obr().setRole("PLAYER");
    mocked.mockReturnValue(snapshot("invalid", true));
    renderGate();
    expect(screen.getByText("Tracker data cannot be read")).toBeInTheDocument();
    expect(await screen.findByText("Ask the GM to reset the tracker.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset tracker" })).not.toBeInTheDocument();
  });

  it("invalid data: the GM can reset the tracker", async () => {
    const user = userEvent.setup();
    mocked.mockReturnValue(snapshot("invalid", true));
    store.dispatch(createParticipant({ name: "Hero", type: "PC" }));
    renderGate();
    await user.click(await screen.findByRole("button", { name: "Reset tracker" }));
    expect(store.getState().swade.rows).toEqual([]);
  });

  it("follows role changes", async () => {
    obr().setRole("PLAYER");
    mocked.mockReturnValue(snapshot("invalid", true));
    renderGate();
    expect(await screen.findByText("Ask the GM to reset the tracker.")).toBeInTheDocument();
    await act(async () => {
      obr().setRole("GM");
    });
    expect(await screen.findByRole("button", { name: "Reset tracker" })).toBeInTheDocument();
  });
});
