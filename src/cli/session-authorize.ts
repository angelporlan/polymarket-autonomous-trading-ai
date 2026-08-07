import { loadConfig } from "../config.js";
import { parseDecimalToMicros, formatMicros } from "../domain/types.js";
import { TradingDatabase } from "../storage/database.js";

function optionValue(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? "" : "";
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const pendingSessionId = optionValue(argv, "--pending");
  const amount = optionValue(argv, "--amount");
  const challenge = optionValue(argv, "--challenge");
  if (!pendingSessionId || !amount || !challenge) {
    throw new Error(
      "Usage: npm run session:authorize -- --pending <id> --amount <pUSD> --challenge <challenge>"
    );
  }

  const config = loadConfig();
  const database = new TradingDatabase(config.databasePath);
  try {
    const amountMicros = parseDecimalToMicros(amount);
    database.recordSessionAuthorization(
      pendingSessionId,
      amountMicros,
      challenge
    );
    process.stdout.write(
      `${JSON.stringify({
        pendingSessionId,
        authorizedAmountPusd: formatMicros(amountMicros)
      })}\n`
    );
  } finally {
    database.close();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "SESSION_AUTHORIZATION_FAILED";
    process.stderr.write(`[session-authorize] ${message}\n`);
    process.exitCode = 1;
  }
}
