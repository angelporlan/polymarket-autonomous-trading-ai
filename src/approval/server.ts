import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { URL } from "node:url";
import { formatMicros, type OrderProposal } from "../domain/types.js";
import type { TradingDatabase } from "../storage/database.js";

export interface DashboardHttpServerOptions {
  host: "127.0.0.1";
  port: number;
  database: TradingDatabase;
  now?: () => number;
}

export type ApprovalHttpServerOptions = DashboardHttpServerOptions & {
  onApproved?: (proposal: OrderProposal) => Promise<{ accepted: boolean; message: string }>;
};

export class DashboardHttpServer {
  private readonly now: () => number;
  private server: Server | null = null;

  constructor(private readonly options: DashboardHttpServerOptions) {
    this.now = options.now ?? Date.now;
  }

  approvalUrl(_proposalId: string): string {
    return `http://${this.options.host}:${this.options.port}/dashboard`;
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
    const origin = validateApprovalOrigin(request, this.options.port);
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
        genericMessagePage("METHOD_NOT_ALLOWED", "The local dashboard operates strictly in read-only monitoring mode. Order submission and approval forms are permanently disabled.")
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
    const executions = this.options.database.listExecutions();

    return {
      status: emergency.active ? "EMERGENCY_STOPPED" : activation.active ? "LIVE_ACTIVE" : "READ_ONLY",
      emergencyStop: emergency,
      liveActivation: activation,
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
      openPositionsCount: positions.length,
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

export class ApprovalHttpServer extends DashboardHttpServer {}

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

function normalizeApprovalHost(
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

function validateApprovalOrigin(
  request: IncomingMessage,
  expectedPort: number
): { valid: boolean; normalizedHost: string | null; normalizedOrigin: string | null; reason: string | null } {
  const normalizedHost = normalizeApprovalHost(
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
