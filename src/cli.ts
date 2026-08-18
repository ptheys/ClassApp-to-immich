import "dotenv/config";
import { login } from "./classapp/session.js";
import { runSync } from "./sync/run.js";
import { backfillDescriptions } from "./sync/backfillDescriptions.js";

const command = process.argv[2];

async function main(): Promise<void> {
  switch (command) {
    case "login":
      await login();
      break;
    case "sync":
      await runSync();
      break;
    case "backfill-descriptions":
      await backfillDescriptions();
      break;
    default:
      console.error(`Uso: npm run login | npm run sync | npm run backfill-descriptions`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("[ERRO]", err instanceof Error ? err.message : err);
  process.exit(1);
});
