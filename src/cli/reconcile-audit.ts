import { loadConfig } from "../config.js";
import { TradingDatabase } from "../storage/database.js";

/** Append-only repair for a historical concurrent audit fork. */
export function main(): void {
  const config = loadConfig();
  const database = new TradingDatabase(config.databasePath);
  try {
    const result = database.reconcileAuditChain();
    process.stdout.write(
      `${JSON.stringify(
        {
          ...result,
          auditChainValid: database.verifyAuditChain()
        },
        null,
        2
      )}\n`
    );
  } finally {
    database.close();
  }
}

if (process.argv[1]?.endsWith("reconcile-audit.ts") === true) {
  main();
}
