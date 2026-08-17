import fs from "node:fs/promises";
import path from "node:path";
import type { SyncState } from "../types.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_FILE = path.join(DATA_DIR, "state.json");

const EMPTY_STATE: SyncState = {
  lastSyncAt: null,
  importedAttachments: [],
};

export async function loadState(): Promise<SyncState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<SyncState>) };
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return { ...EMPTY_STATE };
    throw err;
  }
}

export async function saveState(state: SyncState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export function isAttachmentImported(state: SyncState, attachmentId: string): boolean {
  return state.importedAttachments.some((a) => a.attachmentId === attachmentId);
}

export function recordImportedAttachment(
  state: SyncState,
  args: { messageId: string; attachmentId: string; immichAssetId: string }
): void {
  state.importedAttachments.push({
    ...args,
    importedAt: new Date().toISOString(),
  });
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
