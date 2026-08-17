import fs from "node:fs/promises";
import { createClassAppClient, SessionExpiredError } from "../classapp/client.js";
import { uploadAsset, addTagToAsset, ensureTag } from "../immich/client.js";
import { stampBufferAtNoon, closeExifTool } from "../exif.js";
import { loadState, saveState, isAttachmentImported, recordImportedAttachment } from "./state.js";

const SYNC_MARGIN_MS = 24 * 60 * 60 * 1000; // 1 dia de margem sobre o último sync
const TAG_PREFIX = process.env.IMMICH_TAG_PREFIX || "ClassApp";

export async function runSync(): Promise<void> {
  let classapp;
  try {
    classapp = await createClassAppClient();
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      console.error(`[ERRO] ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const state = await loadState();
  const since = state.lastSyncAt
    ? new Date(new Date(state.lastSyncAt).getTime() - SYNC_MARGIN_MS)
    : null;

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const profiles = await classapp.listStudentProfiles();

    for (const profile of profiles) {
      const tagName = `${TAG_PREFIX}/${firstName(profile.name)}`;
      await ensureTag(tagName);

      console.log(`Buscando mensagens de "${profile.name}" (tag: ${tagName})...`);
      const messages = await classapp.listMessagesSince({ profileId: profile.id, since });

      for (const message of messages) {
        if (message.imagesCount === 0) continue;

        const attachments = await classapp.listMessageImages({
          profileId: profile.id,
          messageId: message.id,
        });

        for (const attachment of attachments) {
          if (isAttachmentImported(state, attachment.id)) {
            skipped++;
            continue;
          }

          let tmpPath: string | undefined;
          try {
            const buffer = await classapp.downloadAttachment(attachment.url);
            tmpPath = await stampBufferAtNoon(buffer, message.createdAt, attachment.filename);
            const stamped = await fs.readFile(tmpPath);

            const assetId = await uploadAsset({
              buffer: stamped,
              filename: attachment.filename || `classapp-${attachment.id}.jpg`,
              takenAt: noon(message.createdAt),
              deviceAssetId: `classapp-${attachment.id}`,
            });

            await addTagToAsset(assetId, tagName);

            recordImportedAttachment(state, {
              messageId: message.id,
              attachmentId: attachment.id,
              immichAssetId: assetId,
            });
            imported++;
            console.log(`  [${imported} novas / ${skipped} já existentes] ${attachment.filename}`);

            // Salva o progresso a cada foto: evita perder/reimportar tudo se o processo for interrompido.
            await saveState(state);
          } catch (err) {
            if (err instanceof SessionExpiredError) throw err;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[ERRO] Falha ao importar anexo ${attachment.id}: ${msg}`);
            failed++;
          } finally {
            if (tmpPath) await fs.unlink(tmpPath).catch(() => {});
          }
        }
      }
    }

    state.lastSyncAt = new Date().toISOString();
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      console.error(`[ERRO] ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    await saveState(state);
    await closeExifTool();
  }

  console.log(`Concluído: ${imported} novas, ${skipped} já existentes, ${failed} falhas.`);
}

function noon(date: string | Date): Date {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  return d;
}

/** Extrai o primeiro nome e normaliza a capitalização (ex: "BARBÁRA KANN THEYS" -> "Bárbara"). */
function firstName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? "";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}
