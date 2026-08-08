import path from "node:path";
import { fileURLToPath } from "node:url";
import { installSupervisor } from "./install-supervisor.js";
import { PolymarketRuntime } from "../runtime.js";
import { KeychainHelperError } from "../security/keychain.js";

const DEFAULT_SESSION_TTL_HOURS = 8;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const ttlHours = parseTtlHours(argv);
  const runtime = new PolymarketRuntime();
  let createdSessionId: string | null = null;
  // Closing this short-lived CLI runtime must not revoke the user's explicit
  // local live activation; the launchd supervisor owns the long-lived process.
  let preserveLiveActivation = true;
  try {
    const account = await runtime.getAccountStatus();
    if (account.status !== "LIVE_READY") {
      throw new Error(
        `LIVE_NOT_READY: account status is ${account.status}; complete onboarding first.`
      );
    }
    const current = await runtime.getTradingSession({ executionMode: "live" });
    let session = current.activeSession;
    let authorization: { authorizedAmountPusd: string } | null = null;

    if (session === null) {
      const existingPending = await runtime.getPendingTradingSession({
        executionMode: "live"
      });
      let pending =
        existingPending ??
        (await runtime.prepareTradingSession({
          executionMode: "live",
          ttlHours
        }));
      if (existingPending?.authorized !== true) {
        try {
          authorization = await runtime.authorizeTradingSession(
            pending.pendingSessionId
          );
        } catch (error) {
          // A user-presence prompt can legitimately outlive the short-lived
          // pending challenge. Re-prepare once using fresh capacity; never
          // reuse an expired attestation or silently enlarge its budget.
          if (
            !(error instanceof KeychainHelperError) ||
            error.code !== "SESSION_AUTHORIZATION_EXPIRED"
          ) {
            throw error;
          }
          pending = await runtime.prepareTradingSession({
            executionMode: "live",
            ttlHours
          });
          authorization = await runtime.authorizeTradingSession(
            pending.pendingSessionId
          );
        }
      }
      session = await runtime.activateTradingSession({
        pendingSessionId: pending.pendingSessionId
      });
      createdSessionId = session.sessionId;
    }

    installSupervisor();
    process.stdout.write(
      `${JSON.stringify(
        {
          started: true,
          session,
          authorization,
          supervisor: "launchd"
        },
        null,
        2
      )}\n`
    );
  } catch (error) {
    if (createdSessionId !== null) {
      try {
        await runtime.endTradingSession({
          executionMode: "live",
          reason: "AUTONOMOUS_START_FAILED"
        });
      } catch {
        // The supervisor remains fail-closed if cleanup cannot be confirmed.
      }
    }
    throw error;
  } finally {
    await runtime.close({ preserveLiveActivation });
  }
}

function parseTtlHours(argv: string[]): number {
  const index = argv.indexOf("--ttl-hours");
  if (index < 0) return DEFAULT_SESSION_TTL_HOURS;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0 || value > 24) {
    throw new Error("--ttl-hours must be greater than 0 and at most 24.");
  }
  return value;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "AUTONOMOUS_START_FAILED";
    process.stderr.write(`[autonomous-start] ${message}\n`);
    process.exitCode = 1;
  });
}
