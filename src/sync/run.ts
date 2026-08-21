import fs from "node:fs/promises";
import { createClassAppClient, SessionExpiredError } from "../classapp/client.js";
import { uploadAsset, addTagToAsset, ensureTag, setAssetDescription } from "../immich/client.js";
import { stampBufferAtNoon, closeExifTool } from "../exif.js";
import { loadState, saveState, isAttachmentImported, recordImportedAttachment } from "./state.js";
import { decodeHtmlEntities } from "../htmlEntities.js";
import { runWithConcurrency } from "../pool.js";
import type { ClassAppMessageSummary } from "../types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Quantos dias antes do último sync as mensagens são reexaminadas. Cobre
 * mensagens antigas que receberam fotos novas depois de já terem sido
 * sincronizadas (o ClassApp lista mensagens por data de criação, então uma
 * edição não as "traz de volta" para o topo). O custo extra é só um
 * getMessageDetail por mensagem com foto na janela — a deduplicação por
 * attachmentId evita qualquer reenvio.
 */
const LOOKBACK_DAYS = Number(process.env.SYNC_LOOKBACK_DAYS) || 30;
const TAG_PREFIX = process.env.IMMICH_TAG_PREFIX || "ClassApp";
const CONCURRENCY = Number(process.env.SYNC_CONCURRENCY) || 6;

interface AttachmentTask {
  message: ClassAppMessageSummary;
  attachmentId: string;
  url: string;
  filename?: string;
  description: string | null;
  tagName: string;
}

export async function runSync(options: { full?: boolean } = {}): Promise<void> {
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
  const since =
    options.full || !state.lastSyncAt
      ? null
      : new Date(new Date(state.lastSyncAt).getTime() - LOOKBACK_DAYS * DAY_MS);

  console.log(
    since
      ? `Sincronizando mensagens a partir de ${since.toISOString()} (lookback de ${LOOKBACK_DAYS} dias sobre o último sync).`
      : `Sincronizando o histórico completo de mensagens${options.full ? " (--full)" : ""}.`
  );

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const profiles = await classapp.listStudentProfiles();
    const tasks: AttachmentTask[] = [];

    // Fase 1 (produtor): busca mensagens + conteúdo/fotos de cada uma, em paralelo.
    for (const profile of profiles) {
      const tagName = `${TAG_PREFIX}/${firstName(profile.name)}`;
      await ensureTag(tagName);

      console.log(`Buscando mensagens de "${profile.name}" (tag: ${tagName})...`);
      const messages = await classapp.listMessagesSince({ profileId: profile.id, since });
      const withImages = messages.filter((m) => m.imagesCount > 0);

      await runWithConcurrency(withImages, CONCURRENCY, async (message) => {
        const detail = await classapp.getMessageDetail({ profileId: profile.id, messageId: message.id });
        const description = detail.content ? decodeHtmlEntities(detail.content).trim() || null : null;

        for (const attachment of detail.images) {
          if (isAttachmentImported(state, attachment.id)) {
            skipped++;
            continue;
          }
          tasks.push({
            message,
            attachmentId: attachment.id,
            url: attachment.url,
            filename: attachment.filename,
            description,
            tagName,
          });
        }
      });
    }

    // Fase 2 (consumidor): baixa, ajusta EXIF, envia ao Immich e aplica tag/descrição, em paralelo.
    await runWithConcurrency(tasks, CONCURRENCY, async (t) => {
      let tmpPath: string | undefined;
      try {
        const buffer = await classapp.downloadAttachment(t.url);
        tmpPath = await stampBufferAtNoon(buffer, t.message.createdAt, t.filename);
        const stamped = await fs.readFile(tmpPath);

        const assetId = await uploadAsset({
          buffer: stamped,
          filename: t.filename || `classapp-${t.attachmentId}.jpg`,
          takenAt: noon(t.message.createdAt),
          deviceAssetId: `classapp-${t.attachmentId}`,
        });

        await addTagToAsset(assetId, t.tagName);
        if (t.description) await setAssetDescription(assetId, t.description);

        recordImportedAttachment(state, {
          messageId: t.message.id,
          attachmentId: t.attachmentId,
          immichAssetId: assetId,
        });
        imported++;
        console.log(`  [${imported} novas / ${skipped} já existentes] ${t.filename}`);

        // Salva o progresso a cada foto: evita perder/reimportar tudo se o processo for interrompido.
        await saveState(state);
      } catch (err) {
        if (err instanceof SessionExpiredError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ERRO] Falha ao importar anexo ${t.attachmentId}: ${msg}`);
        failed++;
      } finally {
        if (tmpPath) await fs.unlink(tmpPath).catch(() => {});
      }
    });

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
