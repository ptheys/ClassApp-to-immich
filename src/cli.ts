import "dotenv/config";
import { login } from "./classapp/session.js";
import { runSync } from "./sync/run.js";
import { backfillDescriptions } from "./sync/backfillDescriptions.js";

const command = process.argv[2];
const flags = new Set(process.argv.slice(3));

async function main(): Promise<void> {
  switch (command) {
    case "login":
      await login();
      break;
    case "sync":
      await runSync({ full: flags.has("--full") });
      break;
    case "backfill-descriptions":
      await backfillDescriptions();
      break;
    default:
      console.error(`Uso: npm run login | npm run sync [-- --full] | npm run backfill-descriptions`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("[ERRO]", err instanceof Error ? err.message : err);
  process.exit(1);
});
