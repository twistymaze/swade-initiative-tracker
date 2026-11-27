// Token context menus: "Add as PC / NPC / Extra". Registered once by the background page
// (src/background.ts), which is loaded for the whole time the room is open
// (docs/owlbear-platform.md §9.2).
import type { ContextMenuItem, ContextMenuIcon, Item, KeyFilter } from "@owlbear-rodeo/sdk";
import { getPluginId } from "./getPluginId";
import type { ParticipantType } from "./store/types";

/** Participant type, menu label and fixed menu id suffix (ids must stay stable: the host keeps menus by id). */
export const MENU_TYPES: ReadonlyArray<readonly [ParticipantType, string, string]> = [
  ["PC", "PC", "context-menu-pc"],
  ["NPC", "NPC", "context-menu-npc"],
  ["GROUP", "Extra", "context-menu-extra"],
];

export const MENU_ICON = "/icon.svg";

/** Image tokens on the character or mount layer. */
const TOKEN_FILTER: KeyFilter[] = [
  { key: "layer", value: "CHARACTER", coordinator: "||" },
  { key: "layer", value: "MOUNT" },
  { key: "type", value: "IMAGE" },
];

/** One icon for a single token, one (plural label) for two or more. GM only. */
function icons(label: string): ContextMenuIcon[] {
  return [
    { icon: MENU_ICON, label: `Add as ${label}`, filter: { every: TOKEN_FILTER, roles: ["GM"], min: 1, max: 1 } },
    { icon: MENU_ICON, label: `Add as ${label}s`, filter: { every: TOKEN_FILTER, roles: ["GM"], min: 2 } },
  ];
}

export type AddTokens = (items: Item[], type: ParticipantType) => void | Promise<void>;

export function buildMenus(onAdd: AddTokens): ContextMenuItem[] {
  return MENU_TYPES.map(([type, label, idSuffix]) => ({
    id: getPluginId(idSuffix),
    icons: icons(label),
    onClick: (context) => {
      void onAdd(context.items, type);
    },
  }));
}

export interface ContextMenuObr {
  contextMenu: { create(item: ContextMenuItem): Promise<void> };
}

/** Register the three menus. Returns their ids. */
export function registerContextMenus(obr: ContextMenuObr, onAdd: AddTokens): string[] {
  return buildMenus(onAdd).map((menu) => {
    obr.contextMenu.create(menu).catch((error) => console.error(`[SWADE] Failed to create menu ${menu.id}`, error));
    return menu.id;
  });
}

const trimmed = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Image URL of an image token, if any. */
export function tokenImageUrl(item: Item): string | undefined {
  const url = (item as { image?: { url?: unknown } }).image?.url;
  return typeof url === "string" && url ? url : undefined;
}

/** Token label text, then item name, then the image file name, then "Token". */
export function tokenName(item: Item): string {
  const text = trimmed((item as { text?: { plainText?: unknown } }).text?.plainText);
  if (text) return text;
  const name = trimmed(item.name);
  if (name) return name;
  const file = tokenImageUrl(item)?.split("/").pop()?.split("?")[0] ?? "";
  return file.replace(/\.[^/.]+$/, "") || "Token";
}
