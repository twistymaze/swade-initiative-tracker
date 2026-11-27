import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));
vi.mock("../store/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../store/store")>()),
  useSyncStatus: vi.fn(() => ({ status: "ready", loaded: true, bytes: 0, nearLimit: false })),
  retrySync: vi.fn(() => Promise.resolve()),
}));

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { retrySync, useSyncStatus } from "../store/store";
import type { SyncSnapshot } from "../store/syncEngine";
import { SyncIndicator } from "./SyncIndicator";

const mockedSyncStatus = vi.mocked(useSyncStatus);
const mockedRetry = vi.mocked(retrySync);
const snapshot = (patch: Partial<SyncSnapshot>): SyncSnapshot => ({ status: "ready", loaded: true, bytes: 0, nearLimit: false, ...patch });

beforeEach(() => {
  mockedRetry.mockClear();
  mockedSyncStatus.mockReturnValue(snapshot({}));
});

describe("SyncIndicator retry", () => {
  it("GM clicks 'Not saved – retry' to retry the write", async () => {
    const user = userEvent.setup();
    mockedSyncStatus.mockReturnValue(snapshot({ status: "error" }));
    render(<SyncIndicator role="GM" />);
    expect(screen.getByRole("status")).toHaveTextContent("Not saved – retry");
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(mockedRetry).toHaveBeenCalledTimes(1);
  });

  it("player sees a plain 'Not saved' chip that is not clickable", () => {
    mockedSyncStatus.mockReturnValue(snapshot({ status: "error" }));
    render(<SyncIndicator role="PLAYER" />);
    expect(screen.getByRole("status")).toHaveTextContent("Not saved");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("GM clicks the too-large chip to retry (e.g. after rows were removed elsewhere)", async () => {
    const user = userEvent.setup();
    mockedSyncStatus.mockReturnValue(snapshot({ status: "too-large" }));
    render(<SyncIndicator role="GM" />);
    expect(screen.getByRole("status")).toHaveTextContent("Not saved – too large");
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(mockedRetry).toHaveBeenCalledTimes(1);
  });

  it("player sees a too-large chip that is not clickable", () => {
    mockedSyncStatus.mockReturnValue(snapshot({ status: "too-large" }));
    render(<SyncIndicator role="PLAYER" />);
    expect(screen.getByRole("status")).toHaveTextContent("Not saved – too large");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
