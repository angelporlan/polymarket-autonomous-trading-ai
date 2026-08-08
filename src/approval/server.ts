import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { URL } from "node:url";
import { formatMicros } from "../domain/types.js";
import type { TradingDatabase } from "../storage/database.js";

export interface DashboardHttpServerOptions {
  host: "127.0.0.1";
  port: number;
  database: TradingDatabase;
  now?: () => number;
}

export class DashboardHttpServer {
  private readonly now: () => number;
  private server: Server | null = null;

  constructor(private readonly options: DashboardHttpServerOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const server = http.createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        this.respondHtml(
          response,
          500,
          "Dashboard Error",
          genericMessagePage("ANOMALY_DETECTED", "Internal dashboard error.")
        );
      });
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 2_000;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.port, this.options.host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const origin = validateDashboardOrigin(request, this.options.port);
    if (!origin.valid) {
      this.respondHtml(
        response,
        403,
        "Invalid Origin",
        genericMessagePage("ORIGIN_INVALID", origin.reason ?? "Origin validation failed.")
      );
      return;
    }

    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      this.respondHtml(
        response,
        405,
        "Method Not Allowed",
        genericMessagePage("METHOD_NOT_ALLOWED", "The local dashboard operates strictly in read-only monitoring mode. Order submission, signing, and other financial actions are permanently disabled.")
      );
      return;
    }

    const url = new URL(
      request.url ?? "/",
      `http://${this.options.host}:${this.options.port}`
    );

    if (url.pathname === "/api/status") {
      this.respondJson(response, 200, this.getStatusData());
      return;
    }

    this.renderDashboard(response);
  }

  private getStatusData(): Record<string, unknown> {
    const nowMs = this.now();
    const emergency = this.options.database.getEmergencyStop();
    const activation = this.options.database.getLiveActivation();
    const paperSession = this.options.database.getActiveTradingSession("paper", nowMs);
    const liveSession = this.options.database.getActiveTradingSession("live", nowMs);
    const positions = this.options.database.listPositionRecords();
    const researchBundles = this.options.database.listResearchBundles();
    const proposals = this.options.database.listProposals();
    const executions = this.options.database.listExecutions();
    const paperTrades = this.options.database.listPaperTrades();
    const paperCheckpoint =
      this.options.database.getLatestPaperReconciliationCheckpoint();
    const cooldown = this.options.database.getCooldown();
    const supervisor = this.options.database.getSupervisorHeartbeat();
    const agentRun = this.options.database.getAgentRun(nowMs);
    const openPositions = positions.filter(
      (position) => position.exitState !== "CLOSED" && position.sharesMicros > 0n
    );
    const executionByProposal = new Map(
      executions.map((execution) => [execution.proposalId, execution])
    );

    return {
      status: emergency.active ? "EMERGENCY_STOPPED" : activation.active ? "LIVE_ACTIVE" : "READ_ONLY",
      emergencyStop: emergency,
      liveActivation: activation,
      agentRun: agentRun
        ? {
            agentRunId: agentRun.agentRunId,
            host: agentRun.host,
            model: agentRun.model,
            status: agentRun.status,
            startedAt: new Date(agentRun.startedAtMs).toISOString(),
            lastHeartbeatAt: new Date(agentRun.lastHeartbeatAtMs).toISOString(),
            leaseExpiresAt: new Date(agentRun.leaseExpiresAtMs).toISOString(),
            stoppedAt: toIsoOrNull(agentRun.stoppedAtMs),
            stopReason: agentRun.stopReason
          }
        : null,
      activeSessions: {
        paper: paperSession
          ? {
              id: paperSession.id,
              authorizedPusd: formatMicros(paperSession.authorizedBudgetMicros),
              remainingPusd: formatMicros(paperSession.remainingBudgetMicros),
              status: paperSession.status
            }
          : null,
        live: liveSession
          ? {
              id: liveSession.id,
              authorizedPusd: formatMicros(liveSession.authorizedBudgetMicros),
              remainingPusd: formatMicros(liveSession.remainingBudgetMicros),
              status: liveSession.status
            }
          : null
      },
      positions: openPositions.map((position) => ({
        tokenId: position.tokenId,
        conditionId: position.conditionId,
        question: position.question,
        outcome: position.outcome,
        side: position.side,
        shares: formatMicros(position.sharesMicros),
        averagePricePusd: formatMicros(position.averagePriceMicros),
        evidenceQuality: position.evidenceQuality,
        openedAt: toIsoOrNull(position.openedAtMs),
        lastEvaluatedAt: new Date(position.lastEvaluatedAtMs).toISOString(),
        lastMarketPricePusd: formatMicros(position.lastMarketPriceMicros),
        lastResearchBundleId: position.lastResearchBundleId,
        exitState: position.exitState,
        activeExitProposalId: position.activeExitProposalId,
        activeExitOrderId: position.activeExitOrderId
      })),
      researchBundles: researchBundles.map((bundle) => ({
        id: bundle.id,
        conditionId: bundle.marketConditionId,
        tokenId: bundle.tokenId,
        estimatedProbability: formatMicros(bundle.estimatedProbabilityMicros),
        eventVolatilityClass: bundle.eventVolatilityClass,
        createdAt: new Date(bundle.createdAtMs).toISOString(),
        expiresAt: new Date(bundle.expiresAtMs).toISOString(),
        sourceCount: bundle.sources.length,
        evidenceKind: bundle.evidenceKind ?? "EXTERNAL",
        marketSourceCount: bundle.marketSources?.length ?? 0,
        contentHash: bundle.contentHash
      })),
      orders: proposals.map((proposal) => {
        const execution = executionByProposal.get(proposal.id);
        return {
          proposalId: proposal.id,
          proposalHash: proposal.hash,
          status: proposal.status,
          intent: proposal.intent,
          executionMode: proposal.executionMode,
          sessionId: proposal.sessionId,
          researchBundleId: proposal.researchBundleId,
          tokenId: proposal.market.tokenId,
          conditionId: proposal.market.conditionId,
          side: proposal.side,
          shares: formatMicros(proposal.sharesMicros),
          limitPricePusd: formatMicros(proposal.limitPriceMicros),
          createdAt: new Date(proposal.createdAtMs).toISOString(),
          expiresAt: new Date(proposal.expiresAtMs).toISOString(),
          execution: execution
            ? {
                orderId: execution.clobOrderId,
                status: execution.status,
                submittedAt: new Date(execution.submittedAtMs).toISOString()
              }
            : null
        };
      }),
      pnl: {
        paper: {
          realizedPusd: formatMicros(paperCheckpoint?.realizedPnlMicros ?? 0n),
          unrealizedPusd: formatMicros(paperCheckpoint?.unrealizedPnlMicros ?? 0n),
          feesPusd: formatMicros(paperCheckpoint?.totalFeesMicros ?? 0n),
          netPusd: formatMicros(paperCheckpoint?.netPnlMicros ?? 0n),
          checkpointAt: toIsoOrNull(paperCheckpoint?.recordedAtMs ?? null),
          openTrades: paperTrades.filter((trade) => trade.status === "OPEN").length
        },
        live: {
          known: false,
          source: "remote_reconciliation"
        }
      },
      locks: {
        emergencyStop: emergency,
        liveActivation: activation,
        cooldown: {
          active: cooldown.untilMs > nowMs,
          reason: cooldown.reason,
          until: cooldown.untilMs > 0 ? new Date(cooldown.untilMs).toISOString() : null,
          updatedAt: toIsoOrNull(cooldown.updatedAtMs)
        },
        supervisor: supervisor
          ? {
              status: supervisor.status,
              pid: supervisor.pid,
              consecutiveFailures: supervisor.consecutiveFailures,
              reconciliationActive: supervisor.reconciliationActive,
              lastCycleAt: toIsoOrNull(supervisor.lastCycleAtMs),
              lastSuccessAt: toIsoOrNull(supervisor.lastSuccessAtMs),
              nextCycleAt: toIsoOrNull(supervisor.nextCycleAtMs),
              lastErrorCode: supervisor.lastErrorCode
            }
          : null
      },
      lastReconciliation: supervisor
        ? {
            at: toIsoOrNull(supervisor.lastSuccessAtMs),
            status: supervisor.status,
            active: supervisor.reconciliationActive
          }
        : null,
      openPositionsCount: openPositions.length,
      trackedPositionsCount: positions.length,
      recentExecutionsCount: executions.length,
      updatedAt: new Date(nowMs).toISOString()
    };
  }

  private renderDashboard(response: ServerResponse): void {
    const data = this.getStatusData();
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Polymarket Autonomous Trading AI - Read-Only Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 900px; margin: 0 auto; }
    .card { background: #1e293b; border-radius: 12px; padding: 24px; margin-bottom: 20px; border: 1px solid #334155; }
    h1 { font-size: 24px; margin-top: 0; color: #38bdf8; }
    h2 { font-size: 18px; color: #94a3b8; margin-top: 0; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 14px; }
    .badge-green { background: #064e3b; color: #34d399; }
    .badge-red { background: #7f1d1d; color: #f87171; }
    .badge-blue { background: #0c4a6e; color: #38bdf8; }
    pre { background: #0f172a; padding: 16px; border-radius: 8px; overflow-x: auto; color: #e2e8f0; font-size: 13px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Polymarket Autonomous Trading AI</h1>
      <h2>Read-Only Monitoring Dashboard (127.0.0.1)</h2>
      <p>System Status: <span class="badge ${data.status === "LIVE_ACTIVE" ? "badge-green" : data.status === "EMERGENCY_STOPPED" ? "badge-red" : "badge-blue"}">${escapeHtml(String(data.status))}</span></p>
    </div>
    <div class="card">
      <h2>Active Telemetry & Sessions</h2>
      <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>
    </div>
  </div>
</body>
</html>`;
    this.respondHtml(response, 200, "Dashboard", html);
  }

  private respondJson(
    response: ServerResponse,
    statusCode: number,
    body: Record<string, unknown>
  ): void {
    const payload = JSON.stringify(body);
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox;",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(payload);
  }

  private respondHtml(
    response: ServerResponse,
    statusCode: number,
    title: string,
    body: string
  ): void {
    response.writeHead(statusCode, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none';",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(body);
  }
}

function toIsoOrNull(value: number | null): string | null {
  return value === null || value <= 0 ? null : new Date(value).toISOString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function genericMessagePage(code: string, message: string): string {
  return `<!DOCTYPE html><html><head><title>${escapeHtml(code)}</title></head><body><h1>${escapeHtml(code)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function readSingleRawHeader(
  request: IncomingMessage,
  headerName: string
): string | null {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === headerName) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) {
        values.push(value);
      }
    }
  }
  return values.length === 1 ? values[0]! : null;
}

function normalizeDashboardHost(
  hostHeader: string | undefined,
  expectedPort: number
): string | null {
  if (!hostHeader) {
    return null;
  }
  const host = hostHeader.toLowerCase().trim();
  if (host === `127.0.0.1:${expectedPort}`) {
    return `127.0.0.1:${expectedPort}`;
  }
  return null;
}

function validateDashboardOrigin(
  request: IncomingMessage,
  expectedPort: number
): { valid: boolean; normalizedHost: string | null; normalizedOrigin: string | null; reason: string | null } {
  const normalizedHost = normalizeDashboardHost(
    request.headers.host,
    expectedPort
  );
  const rawOrigin = readSingleRawHeader(request, "origin");

  if (normalizedHost === null) {
    return {
      valid: false,
      normalizedHost,
      normalizedOrigin: null,
      reason: "HOST_INVALID"
    };
  }

  if (rawOrigin === null) {
    return {
      valid: true,
      normalizedHost,
      normalizedOrigin: `http://${normalizedHost}`,
      reason: null
    };
  }

  if (rawOrigin.toLowerCase() === "null") {
    return {
      valid: false,
      normalizedHost,
      normalizedOrigin: "null",
      reason: "ORIGIN_NULL"
    };
  }

  try {
    const parsed = new URL(rawOrigin);
    const normalizedOrigin = parsed.origin;
    if (parsed.protocol !== "http:") {
      return { valid: false, normalizedHost, normalizedOrigin, reason: "ORIGIN_SCHEME" };
    }
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      return { valid: false, normalizedHost, normalizedOrigin, reason: "ORIGIN_HOST" };
    }
    if (parsed.port !== String(expectedPort)) {
      return { valid: false, normalizedHost, normalizedOrigin, reason: "ORIGIN_PORT" };
    }
    if (parsed.host !== normalizedHost) {
      return {
        valid: false,
        normalizedHost,
        normalizedOrigin,
        reason: "ORIGIN_HOST_MISMATCH"
      };
    }
    return { valid: true, normalizedHost, normalizedOrigin, reason: null };
  } catch {
    return { valid: false, normalizedHost, normalizedOrigin: null, reason: "ORIGIN_FORMAT" };
  }
}
