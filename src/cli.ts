import "dotenv/config";
import { login } from "./classapp/session.js";
import { runSync } from "./sync/run.js";

const command = process.argv[2];

async function main(): Promise<void> {
  switch (command) {
    case "login":
      await login();
      break;
    case "sync":
      await runSync();
      break;
    default:
      console.error(`Uso: npm run login | npm run sync`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("[ERRO]", err instanceof Error ? err.message : err);
  process.exit(1);
});
