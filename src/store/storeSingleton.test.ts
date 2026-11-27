// The per-iframe singleton in store.ts: role read retries, role changes, GM-only writes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));

import { hub, obr, resetObrMock } from "../test/obrMock";
import { startSync, store, syncEngine } from "./store";
import { createParticipant } from "./swadeSlice";
import { STATE_KEY } from "./syncEngine";

beforeEach(() => {
  vi.useFakeTimers();
  resetObrMock();
});

afterEach(() => {
  syncEngine.stop();
  vi.useRealTimers();
});

describe("startSync", () => {
  it("retries the role read, is idempotent, and follows a later promotion to GM", async () => {
    obr().setRole("PLAYER");
    obr().player.getRole.mockRejectedValueOnce(new Error("not ready")).mockRejectedValueOnce(new Error("not ready"));

    const first = startSync();
    expect(startSync()).toBe(first);
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    expect(obr().player.getRole).toHaveBeenCalledTimes(3);
    expect(syncEngine.getSnapshot().status).toBe("absent-player");

    // A player change that is not a role change keeps the role.
    await obr().player.setName("Renamed");
    await vi.advanceTimersByTimeAsync(10);
    store.dispatch(createParticipant({ name: "Ignored", type: "PC" }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(obr().room.setMetadata).not.toHaveBeenCalled();

    obr().setRole("GM");
    await vi.advanceTimersByTimeAsync(10);
    store.dispatch(createParticipant({ name: "Hero", type: "PC" }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(obr().room.setMetadata).toHaveBeenCalled();
    expect(hub().roomMetadata[STATE_KEY]).toBeDefined();

    // Demoted again: local changes are no longer written.
    const writes = obr().room.setMetadata.mock.calls.length;
    obr().setRole("PLAYER");
    await vi.advanceTimersByTimeAsync(10);
    store.dispatch(createParticipant({ name: "Not saved", type: "PC" }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(obr().room.setMetadata).toHaveBeenCalledTimes(writes);
  });

  it("reads the room when the iframe becomes visible again, gets focus or comes back online (missed events)", async () => {
    // The singleton of the test above is stopped: load a fresh copy of the module.
    vi.resetModules();
    const fresh = await import("./store");
    obr().setRole("GM");
    await fresh.startSync();
    await vi.advanceTimersByTimeAsync(1_000);
    const reads = () => obr().room.getMetadata.mock.calls.length;
    const before = reads();

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10);
    expect(reads()).toBe(before); // hidden: no read

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10);
    expect(reads()).toBe(before + 1);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(10);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(10);
    expect(reads()).toBe(before + 3);
    fresh.syncEngine.stop();
  });
});
