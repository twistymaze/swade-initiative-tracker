import { describe, expect, it, vi } from "vitest";
import type { Item } from "@owlbear-rodeo/sdk";
import { buildMenus, registerContextMenus, tokenImageUrl, tokenName } from "./contextMenu";

const token = (extra: Record<string, unknown> = {}) => ({ id: "t1", name: "", type: "IMAGE", ...extra }) as unknown as Item;

describe("buildMenus", () => {
  it("builds 3 GM-only menus with fixed ids, each with a single and a plural icon", () => {
    const menus = buildMenus(() => {});
    expect(menus.map((m) => m.id)).toEqual([
      "rodeo.owlbear.swade-initiative/context-menu-pc",
      "rodeo.owlbear.swade-initiative/context-menu-npc",
      "rodeo.owlbear.swade-initiative/context-menu-extra",
    ]);
    expect(menus.map((m) => m.icons.map((i) => i.label))).toEqual([
      ["Add as PC", "Add as PCs"],
      ["Add as NPC", "Add as NPCs"],
      ["Add as Extra", "Add as Extras"],
    ]);
    for (const menu of menus) {
      const [single, plural] = menu.icons;
      expect(single.filter).toMatchObject({ roles: ["GM"], min: 1, max: 1 });
      expect(plural.filter).toMatchObject({ roles: ["GM"], min: 2 });
      expect(plural.filter?.max).toBeUndefined();
      for (const icon of menu.icons) {
        expect(icon.icon).toBe("/icon.svg");
        expect(icon.filter?.permissions).toBeUndefined();
        expect(icon.filter?.every).toContainEqual({ key: "type", value: "IMAGE" });
      }
    }
  });

  it("onClick passes the items and the participant type", () => {
    const onAdd = vi.fn();
    const items = [token()];
    buildMenus(onAdd).forEach((menu) => menu.onClick?.({ items, selectionBounds: undefined as never }, ""));
    expect(onAdd.mock.calls.map((c) => c[1])).toEqual(["PC", "NPC", "GROUP"]);
    expect(onAdd.mock.calls[0][0]).toBe(items);
  });
});

describe("registerContextMenus", () => {
  it("creates each menu once and survives a rejected create", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const create = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("host")).mockResolvedValue(undefined);
    const ids = registerContextMenus({ contextMenu: { create } }, () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(3);
    expect(ids).toHaveLength(3);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe("token name and image", () => {
  it("prefers label text, then name, then file name, then a fallback", () => {
    const image = { url: "https://x.test/a/Goblin%20Boss.webp?v=1" };
    expect(tokenName(token({ text: { plainText: "  Label " }, name: "Name", image }))).toBe("Label");
    expect(tokenName(token({ text: { plainText: " " }, name: " Name ", image }))).toBe("Name");
    expect(tokenName(token({ image }))).toBe("Goblin%20Boss");
    expect(tokenName(token())).toBe("Token");
    expect(tokenImageUrl(token({ image }))).toBe(image.url);
    expect(tokenImageUrl(token())).toBeUndefined();
  });
});
