import { beforeEach, describe, expect, it, vi } from "vitest";
import OBR, { Math2 } from "@owlbear-rodeo/sdk";
import {
  createClient,
  flushObr,
  hub,
  obr,
  resetObrMock,
  setRole,
  setSceneReady,
  simulateRemoteWrite,
} from "./obrMock";

vi.mock("@owlbear-rodeo/sdk", () => import("./obrMock").then((m) => m.createSdkModule()));

describe("obrMock", () => {
  beforeEach(() => {
    resetObrMock();
  });

  it("replaces the default export and keeps SDK math helpers", async () => {
    expect(OBR.isAvailable).toBe(true);
    expect(await OBR.player.getRole()).toBe("GM");
    expect(Math2.add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
  });

  it("merges room metadata shallowly and deletes undefined keys", async () => {
    await OBR.room.setMetadata({ a: 1, b: { nested: true } });
    await OBR.room.setMetadata({ a: undefined, c: "x" });
    expect(await OBR.room.getMetadata()).toEqual({ b: { nested: true }, c: "x" });
  });

  it("fires metadata listeners asynchronously for own writes", async () => {
    const listener = vi.fn();
    OBR.room.onMetadataChange(listener);
    const write = OBR.room.setMetadata({ k: 1 });
    expect(listener).not.toHaveBeenCalled(); // never synchronous
    await write;
    await flushObr();
    expect(listener).toHaveBeenCalledWith({ k: 1 });
  });

  it("syncs writes between clients sharing a hub", async () => {
    const player = createClient({ role: "PLAYER", name: "Alice" });
    const seen = vi.fn();
    player.room.onMetadataChange(seen);

    await OBR.room.setMetadata({ state: { round: 2 } });
    await flushObr();
    expect(seen).toHaveBeenCalledWith({ state: { round: 2 } });
    expect(await player.room.getMetadata()).toEqual({ state: { round: 2 } });

    hub().setActiveClient(player);
    expect(await OBR.player.getRole()).toBe("PLAYER");
  });

  it("simulates remote writes, role changes and scene readiness", async () => {
    const meta = vi.fn();
    const role = vi.fn();
    const ready = vi.fn();
    OBR.scene.onMetadataChange(meta);
    OBR.player.onChange(role);
    OBR.scene.onReadyChange(ready);

    simulateRemoteWrite("scene", { s: true });
    setRole("PLAYER");
    setSceneReady(false);
    await flushObr();

    expect(meta).toHaveBeenCalledWith({ s: true });
    expect(role.mock.calls[0][0].role).toBe("PLAYER");
    expect(ready).toHaveBeenCalledWith(false);
    expect(await OBR.scene.isReady()).toBe(false);
    await expect(OBR.scene.getMetadata()).rejects.toThrow();
  });

  it("records context menus and action calls", async () => {
    const onClick = vi.fn();
    await OBR.contextMenu.create({ id: "menu", icons: [], onClick });
    obr().clickContextMenu("menu", []);
    expect(onClick).toHaveBeenCalled();
    await OBR.contextMenu.remove("menu");
    expect(obr().state.contextMenus.has("menu")).toBe(false);

    await OBR.action.setHeight(200);
    expect(OBR.action.setHeight).toHaveBeenCalledWith(200);
    expect(obr().state.action.height).toBe(200);
  });
});
