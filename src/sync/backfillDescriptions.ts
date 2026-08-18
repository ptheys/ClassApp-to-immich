import { createClassAppClient, SessionExpiredError } from "../classapp/client.js";
import { setAssetDescription } from "../immich/client.js";
import { decodeHtmlEntities } from "../htmlEntities.js";
import { runWithConcurrency } from "../pool.js";
import { loadState } from "./state.js";

const CONCURRENCY = Number(process.env.SYNC_CONCURRENCY) || 6;

/**
 * Preenche a descrição (texto da mensagem) nos assets já importados antes desse
 * recurso existir. Não reenvia fotos nem altera `state.json` — só chama o PUT
 * de descrição no Immich para cada asset já registrado.
 */
export async function backfillDescriptions(): Promise<void> {
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
  const profiles = await classapp.listStudentProfiles();

  const byMessage = new Map<string, { assetIds: string[] }>();
  for (const a of state.importedAttachments) {
    const entry = byMessage.get(a.messageId) ?? { assetIds: [] };
    entry.assetIds.push(a.immichAssetId);
    byMessage.set(a.messageId, entry);
  }

  console.log(`Preenchendo descrição de ${byMessage.size} mensagens (${state.importedAttachments.length} fotos)...`);

  let updated = 0;
  let noContent = 0;
  let failed = 0;

  await runWithConcurrency([...byMessage.entries()], CONCURRENCY, async ([messageId, { assetIds }]) => {
    try {
      let content: string | null = null;
      for (const profile of profiles) {
        try {
          const detail = await classapp.getMessageDetail({ profileId: profile.id, messageId });
          if (detail.content) {
            content = detail.content;
            break;
          }
        } catch {
          // mensagem pode não pertencer a este perfil; tenta o próximo
        }
      }

      if (!content) {
        noContent++;
        return;
      }

      const description = decodeHtmlEntities(content).trim();
      if (!description) {
        noContent++;
        return;
      }

      await runWithConcurrency(assetIds, CONCURRENCY, (assetId) => setAssetDescription(assetId, description));
      updated += assetIds.length;
      console.log(`  [${updated} fotos atualizadas] mensagem ${messageId} (${assetIds.length} fotos)`);
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ERRO] Falha ao processar mensagem ${messageId}: ${msg}`);
      failed += assetIds.length;
    }
  });

  console.log(`Concluído: ${updated} fotos atualizadas, ${noContent} sem conteúdo, ${failed} falhas.`);
}
