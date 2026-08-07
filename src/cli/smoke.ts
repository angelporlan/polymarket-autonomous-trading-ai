import { loadConfig } from "../config.js";
import { PolymarketPublicClient } from "../polymarket/public-client.js";
import { TradingDatabase } from "../storage/database.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface SmokeResult {
  ok: boolean;
  auditChainValid: boolean;
  geoblock: "allowed" | "blocked";
  profile: "not-configured" | "found" | "not-found";
  candidateCount: number;
  snapshotChecked: boolean;
  checkedAt: string;
}

/**
 * Performs public, read-only connectivity checks. It never creates an
 * authenticated client, reads Keychain, stages a proposal, or submits an order.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const database = new TradingDatabase(config.databasePath);
  try {
    const client = new PolymarketPublicClient({
      gammaHost: config.gammaHost,
      dataHost: config.dataHost,
      clobHost: config.clobHost
    });
    const [geo, candidates, profileExists] = await Promise.all([
      client.checkGeoblock(),
      client.scanCandidates(["politics", "economics", "technology"]),
      config.profileAddress === ZERO_ADDRESS
        ? Promise.resolve<boolean | null>(null)
        : client.profileExists(config.profileAddress)
    ]);

    let snapshotChecked = false;
    for (const candidate of candidates) {
      if (
        !candidate.active ||
        !candidate.acceptingOrders ||
        candidate.tokenIds.length === 0
      ) {
        continue;
      }
      try {
        const firstTokenId = candidate.tokenIds[0];
        if (firstTokenId === undefined) {
          continue;
        }
        const reference = await client.resolveMarketReference({
          conditionId: candidate.conditionId,
          tokenId: firstTokenId
        });
        await client.getMarketSnapshot(reference);
        snapshotChecked = true;
        break;
      } catch {
        // Try next candidate if snapshot is stale or temporarily unavailable
      }
    }

    const auditChainValid = database.verifyAuditChain();
    const result: SmokeResult = {
      ok: auditChainValid && !geo.blocked && snapshotChecked,
      auditChainValid,
      geoblock: geo.blocked ? "blocked" : "allowed",
      profile:
        profileExists === null
          ? "not-configured"
          : profileExists
            ? "found"
            : "not-found",
      candidateCount: candidates.length,
      snapshotChecked,
      checkedAt: new Date().toISOString()
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    database.close();
  }
}

void main().catch(() => {
  process.stderr.write(
    "[smoke] La comprobación pública falló de forma segura; no se usaron credenciales ni se enviaron órdenes.\n"
  );
  process.exitCode = 1;
});
