import { loadConfig } from "../config.js";
import path from "node:path";
import { formatMicros } from "../domain/types.js";
import { MacOSKeychain } from "../security/keychain.js";
import { TradingDatabase } from "../storage/database.js";

function optionValue(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? "" : "";
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const pendingSessionId = optionValue(argv, "--pending");
  if (!pendingSessionId || argv.includes("--amount") || argv.includes("--challenge")) {
    throw new Error(
      "Usage: npm run session:authorize -- --pending <id>\nThe amount is entered only in the native macOS authorization window."
    );
  }

  const config = loadConfig();
  const database = new TradingDatabase(config.databasePath);
  try {
    const pending = database.getPendingTradingSession(pendingSessionId);
    if (!pending) {
      throw new Error("Pending trading session is missing or expired.");
    }
    const keychain = new MacOSKeychain({
      helperPath: path.resolve("bin/polymarket-keychain-helper")
    });
    const attestation = await keychain.authorizeTradingSession({
      pendingSessionId: pending.id,
      executionMode: pending.executionMode,
      maximumAuthorizableMicros: pending.maximumAuthorizableMicros,
      expiresAtMs: pending.expiresAtMs
    });
    database.recordSessionAuthorization(attestation);
    process.stdout.write(
      `${JSON.stringify({
        pendingSessionId,
        authorizedAmountPusd: formatMicros(attestation.amountMicros),
        authorizationSource: attestation.attestationSource
      })}\n`
    );
  } finally {
    database.close();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "SESSION_AUTHORIZATION_FAILED";
    process.stderr.write(`[session-authorize] ${message}\n`);
    process.exitCode = 1;
  });
}
