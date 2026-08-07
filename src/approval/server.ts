import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { URL } from "node:url";
import { verifyProposalHash } from "../domain/proposals.js";
import {
  formatMicros,
  type OrderProposal
} from "../domain/types.js";
import type { TradingDatabase } from "../storage/database.js";

interface ApprovalSession {
  proposalId: string;
  proposalHash: string;
  csrfToken: string;
  expiresAtMs: number;
}

type ApprovalFailureCode =
  | "ORIGIN_INVALID"
  | "SESSION_MISSING"
  | "CSRF_INVALID"
  | "CONFIRMATION_MISMATCH"
  | "PROPOSAL_EXPIRED"
  | "REQUEST_INVALID";

interface ApprovalOriginValidation {
  valid: boolean;
  normalizedHost: string | null;
  normalizedOrigin: string | null;
  reason: OriginFailureReason | null;
}

type OriginFailureReason =
  | "HOST_INVALID"
  | "ORIGIN_MISSING_OR_MULTIPLE"
  | "ORIGIN_NULL"
  | "ORIGIN_FORMAT"
  | "ORIGIN_SCHEME"
  | "ORIGIN_HOST"
  | "ORIGIN_PORT"
  | "ORIGIN_HOST_MISMATCH"
  | "ORIGIN_CREDENTIALS"
  | "ORIGIN_PATH";

export interface ApprovalExecutionResult {
  accepted: boolean;
  message: string;
}

export interface ApprovalHttpServerOptions {
  host: "127.0.0.1";
  port: number;
  database: TradingDatabase;
  onApproved: (proposal: OrderProposal) => Promise<ApprovalExecutionResult>;
  now?: () => number;
}

export class ApprovalHttpServer {
  private readonly sessions = new Map<string, ApprovalSession>();
  private readonly now: () => number;
  private server: Server | null = null;

  constructor(private readonly options: ApprovalHttpServerOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const server = http.createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        console.error(
          "[approval-debug]",
          JSON.stringify({ code: "APPROVAL_HANDLER_FAILED" })
        );
        this.respondHtml(
          response,
          500,
          "Approval failed safely",
          failureMessagePage("REQUEST_INVALID")
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
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    if (!server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  approvalUrl(proposalId: string): string {
    return `http://${this.options.host}:${this.options.port}/approve/${encodeURIComponent(
      proposalId
    )}`;
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (normalizeApprovalHost(request.headers.host, this.options.port) === null) {
      this.logApprovalFailure("REQUEST_INVALID", request, null, null);
      this.respondHtml(
        response,
        400,
        "Invalid host",
        failureMessagePage("REQUEST_INVALID")
      );
      return;
    }

    const url = new URL(
      request.url ?? "/",
      `http://${this.options.host}:${this.options.port}`
    );
    const match = /^\/approve\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (!match?.[1]) {
      this.respondHtml(response, 404, "Not found", genericMessagePage());
      return;
    }
    const proposalId = match[1];

    if (request.method === "GET") {
      this.renderApproval(request, response, proposalId);
      return;
    }
    if (request.method === "POST") {
      await this.processApproval(request, response, proposalId);
      return;
    }

    response.setHeader("Allow", "GET, POST");
    this.respondHtml(response, 405, "Method not allowed", genericMessagePage());
  }

  private renderApproval(
    request: IncomingMessage,
    response: ServerResponse,
    proposalId: string
  ): void {
    const proposal = this.options.database.getProposal(proposalId);
    const nowMs = this.now();
    if (
      !proposal ||
      proposal.status !== "AWAITING_LOCAL" ||
      proposal.expiresAtMs < nowMs ||
      !verifyProposalHash(proposal)
    ) {
      this.respondHtml(
        response,
        409,
        "Proposal unavailable",
        failureMessagePage("PROPOSAL_EXPIRED")
      );
      return;
    }

    const sessionId = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    this.sessions.set(hashToken(sessionId), {
      proposalId,
      proposalHash: proposal.hash,
      csrfToken,
      expiresAtMs: proposal.expiresAtMs
    });
    const maxAgeSeconds = Math.max(
      10,
      Math.ceil((proposal.expiresAtMs - nowMs) / 1000)
    );
    response.setHeader(
      "Set-Cookie",
      `pm_approval=${sessionId}; HttpOnly; SameSite=Strict; Path=/approve; Max-Age=${maxAgeSeconds}`
    );
    this.respondHtml(
      response,
      200,
      "Review Polymarket order",
      approvalPage(
        proposal,
        csrfToken,
        approvalAction(request, proposalId, this.options.port)
      )
    );
  }

  private async processApproval(
    request: IncomingMessage,
    response: ServerResponse,
    proposalId: string
  ): Promise<void> {
    const origin = validateApprovalOrigin(request, this.options.port);
    if (!origin.valid) {
      this.logApprovalFailure(
        "ORIGIN_INVALID",
        request,
        proposalId,
        origin.normalizedOrigin,
        origin.reason
      );
      this.respondHtml(
        response,
        403,
        "Invalid origin",
        failureMessagePage("ORIGIN_INVALID", origin.reason)
      );
      return;
    }
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.startsWith("application/x-www-form-urlencoded")) {
      this.logApprovalFailure(
        "REQUEST_INVALID",
        request,
        proposalId,
        origin.normalizedOrigin
      );
      this.respondHtml(
        response,
        415,
        "Unsupported content type",
        failureMessagePage("REQUEST_INVALID")
      );
      return;
    }

    const sessionId = readCookie(request, "pm_approval");
    if (!sessionId) {
      this.logApprovalFailure(
        "SESSION_MISSING",
        request,
        proposalId,
        origin.normalizedOrigin
      );
      this.respondHtml(
        response,
        403,
        "Missing approval session",
        failureMessagePage("SESSION_MISSING")
      );
      return;
    }
    const sessionKey = hashToken(sessionId);
    const session = this.sessions.get(sessionKey);
    this.sessions.delete(sessionKey);
    const nowMs = this.now();
    if (
      !session ||
      session.proposalId !== proposalId ||
      session.expiresAtMs < nowMs
    ) {
      this.logApprovalFailure(
        "PROPOSAL_EXPIRED",
        request,
        proposalId,
        origin.normalizedOrigin
      );
      this.respondHtml(
        response,
        409,
        "Approval expired",
        failureMessagePage("PROPOSAL_EXPIRED")
      );
      return;
    }

    const form = new URLSearchParams(await readSmallBody(request));
    if (!safeTokenEqual(session.csrfToken, form.get("csrf") ?? "")) {
      this.logApprovalFailure(
        "CSRF_INVALID",
        request,
        proposalId,
        origin.normalizedOrigin
      );
      this.respondHtml(
        response,
        403,
        "Invalid CSRF token",
        failureMessagePage("CSRF_INVALID")
      );
      return;
    }

    const proposal = this.options.database.getProposal(proposalId);
    if (
      !proposal ||
      proposal.status !== "AWAITING_LOCAL" ||
      proposal.hash !== session.proposalHash ||
      proposal.expiresAtMs < nowMs ||
      !verifyProposalHash(proposal)
    ) {
      this.logApprovalFailure(
        "PROPOSAL_EXPIRED",
        request,
        proposalId,
        origin.normalizedOrigin
      );
      this.respondHtml(
        response,
        409,
        "Proposal changed or expired",
        failureMessagePage("PROPOSAL_EXPIRED")
      );
      return;
    }

    if (form.get("decision") === "reject") {
      const rejected = this.options.database.transitionProposal(
        proposalId,
        "AWAITING_LOCAL",
        "REJECTED",
        nowMs
      );
      this.respondHtml(
        response,
        rejected ? 200 : 409,
        rejected ? "Order rejected" : "Proposal changed",
        rejected
          ? genericMessagePage()
          : failureMessagePage("PROPOSAL_EXPIRED")
      );
      return;
    }

    const suffix = proposal.hash.slice(-6);
    const inputSuffix = (form.get("hash_suffix") ?? "").trim().toLowerCase();
    if (
      form.get("decision") !== "approve" ||
      form.get("confirm") !== "on" ||
      !safeTokenEqual(suffix, inputSuffix)
    ) {
      this.logApprovalFailure(
        "CONFIRMATION_MISMATCH",
        request,
        proposalId,
        origin.normalizedOrigin
      );
      this.respondHtml(
        response,
        400,
        "Confirmation did not match",
        failureMessagePage("CONFIRMATION_MISMATCH")
      );
      return;
    }

    const transitioned = this.options.database.transitionProposal(
      proposalId,
      "AWAITING_LOCAL",
      "LOCALLY_APPROVED",
      nowMs
    );
    if (!transitioned) {
      this.logApprovalFailure(
        "PROPOSAL_EXPIRED",
        request,
        proposalId,
        origin.normalizedOrigin
      );
      this.respondHtml(
        response,
        409,
        "Proposal changed",
        failureMessagePage("PROPOSAL_EXPIRED")
      );
      return;
    }
    this.options.database.recordLocalApproval({
      proposalId,
      proposalHash: proposal.hash,
      approvedAtMs: nowMs,
      expiresAtMs: proposal.expiresAtMs,
      nonceHash: hashToken(sessionId),
      consumedAtMs: null
    });

    const result = await this.options.onApproved(transitioned);
    console.error(
      "[approval-debug]",
      JSON.stringify({
        code: "APPROVAL_EXECUTION_RESULT",
        proposalId,
        accepted: result.accepted
      })
    );
    this.respondHtml(
      response,
      result.accepted ? 200 : 409,
      result.accepted ? "Order submitted" : "Order blocked",
      messagePage(result.message)
    );
  }

  private logApprovalFailure(
    code: ApprovalFailureCode,
    request: IncomingMessage,
    proposalId: string | null,
    normalizedOrigin: string | null,
    originReason: OriginFailureReason | null = null
  ): void {
    console.error(
      "[approval-debug]",
      JSON.stringify({
        code,
        proposalId,
        host: normalizeApprovalHost(request.headers.host, this.options.port),
        origin: normalizedOrigin,
        originReason
      })
    );
  }

  private pruneSessions(nowMs: number): void {
    for (const [key, session] of this.sessions) {
      if (session.expiresAtMs < nowMs) {
        this.sessions.delete(key);
      }
    }
  }

  private respondHtml(
    response: ServerResponse,
    status: number,
    title: string,
    body: string
  ): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
        title
      )}</title></head><body>${body}</body></html>`
    );
  }
}

async function readSmallBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 4_096) {
      throw new Error("Request body too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) {
    return null;
  }
  for (const item of header.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) {
      return value.join("=") || null;
    }
  }
  return null;
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeTokenEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeApprovalHost(
  rawHost: string | undefined,
  expectedPort: number
): string | null {
  if (
    rawHost === undefined ||
    rawHost.trim() !== rawHost ||
    rawHost.includes(",")
  ) {
    return null;
  }
  try {
    const parsed = new URL(`http://${rawHost}`);
    if (
      parsed.protocol !== "http:" ||
      (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
      parsed.port !== String(expectedPort) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return null;
    }
    return parsed.host;
  } catch {
    return null;
  }
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

function validateApprovalOrigin(
  request: IncomingMessage,
  expectedPort: number
): ApprovalOriginValidation {
  const normalizedHost = normalizeApprovalHost(
    request.headers.host,
    expectedPort
  );
  const rawOrigin = readSingleRawHeader(request, "origin");
  if (
    normalizedHost === null
  ) {
    return {
      valid: false,
      normalizedHost,
      normalizedOrigin: null,
      reason: "HOST_INVALID"
    };
  }
  if (rawOrigin === null || rawOrigin.toLowerCase() === "null") {
    return {
      valid: true,
      normalizedHost,
      normalizedOrigin: `http://${normalizedHost}`,
      reason: null
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
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      return {
        valid: false,
        normalizedHost,
        normalizedOrigin,
        reason: "ORIGIN_CREDENTIALS"
      };
    }
    if (parsed.pathname !== "/" || parsed.search.length > 0 || parsed.hash.length > 0) {
      return {
        valid: false,
        normalizedHost,
        normalizedOrigin,
        reason: "ORIGIN_PATH"
      };
    }
    return { valid: true, normalizedHost, normalizedOrigin, reason: null };
  } catch {
    return {
      valid: false,
      normalizedHost,
      normalizedOrigin: null,
      reason: "ORIGIN_FORMAT"
    };
  }
}

function approvalAction(
  request: IncomingMessage,
  proposalId: string,
  expectedPort: number
): string {
  const host = normalizeApprovalHost(request.headers.host, expectedPort);
  if (host === null) {
    throw new Error("Approval host is invalid.");
  }
  return `http://${host}/approve/${encodeURIComponent(proposalId)}`;
}

function approvalPage(
  proposal: OrderProposal,
  csrfToken: string,
  action: string
): string {
  const suffix = proposal.hash.slice(-6);
  const snapshotAgeSeconds = Math.max(
    0,
    (Date.now() - proposal.market.capturedAtMs) / 1_000
  ).toFixed(1);
  const sources = proposal.sources
    .map(
      (source) =>
        `<li><strong>${escapeHtml(source.title)}</strong> (${source.primary ? "primary" : "secondary"})<br>` +
        `<code>${escapeHtml(source.url)}</code><br>` +
        `Published: ${escapeHtml(source.publishedAt ?? "not supplied")} · Retrieved: ${escapeHtml(source.retrievedAt)}</li>`
    )
    .join("");
  return `<main style="max-width:760px;margin:40px auto;font:16px system-ui;line-height:1.45;color:#17202a">
    <h1>Confirm Polymarket order</h1>
    <p><strong>${escapeHtml(proposal.side)}</strong> ${escapeHtml(
      proposal.market.outcome
    )} — ${escapeHtml(proposal.market.question)}</p>
    <dl>
      <dt>Condition ID</dt><dd style="overflow-wrap:anywhere"><code>${escapeHtml(proposal.market.conditionId)}</code></dd>
      <dt>Token ID</dt><dd style="overflow-wrap:anywhere"><code>${escapeHtml(proposal.market.tokenId)}</code></dd>
      <dt>Event ID / correlation</dt><dd><code>${escapeHtml(proposal.market.eventId ?? "unavailable")} / ${escapeHtml(proposal.correlationKey)}</code></dd>
      <dt>Category</dt><dd>${escapeHtml(proposal.market.category)}</dd>
      <dt>Shares</dt><dd>${formatMicros(proposal.sharesMicros)}</dd>
      <dt>Limit price</dt><dd>${formatMicros(proposal.limitPriceMicros)} pUSD</dd>
      <dt>Maximum cost</dt><dd>${formatMicros(proposal.maxCostMicros)} pUSD</dd>
      <dt>Estimated fee</dt><dd>${formatMicros(proposal.estimatedFeeMicros)} pUSD</dd>
      <dt>Maximum loss</dt><dd>${formatMicros(proposal.maxLossMicros)} pUSD</dd>
      <dt>Estimated probability</dt><dd>${formatMicros(proposal.estimatedProbabilityMicros)}</dd>
      <dt>Expected edge after costs</dt><dd>${formatMicros(proposal.expectedEdgeMicros)}</dd>
      <dt>Spread</dt><dd>${formatMicros(proposal.market.spreadMicros)} pUSD</dd>
      <dt>Depth at approved limit</dt><dd>${formatMicros(proposal.market.depthPusdMicrosAtLimit)} pUSD</dd>
      <dt>Snapshot</dt><dd>${escapeHtml(new Date(proposal.market.capturedAtMs).toISOString())} (${snapshotAgeSeconds}s old when this page rendered)</dd>
      <dt>Post-trade market exposure</dt><dd>${formatMicros(proposal.postTradeMarketExposureMicros)} pUSD</dd>
      <dt>Post-trade total exposure</dt><dd>${formatMicros(proposal.postTradeTotalExposureMicros)} pUSD</dd>
      <dt>Expires</dt><dd>${escapeHtml(new Date(proposal.expiresAtMs).toISOString())}</dd>
      <dt>Rules</dt><dd>${escapeHtml(proposal.market.rules)}</dd>
      <dt>Resolution source</dt><dd style="overflow-wrap:anywhere"><code>${escapeHtml(proposal.market.resolutionSource)}</code></dd>
      <dt>Thesis</dt><dd>${escapeHtml(proposal.thesis)}</dd>
      <dt>Counterargument</dt><dd>${escapeHtml(proposal.counterThesis)}</dd>
      <dt>Full SHA-256</dt><dd style="overflow-wrap:anywhere"><code>${proposal.hash}</code></dd>
    </dl>
    <h2>Public sources</h2>
    <ol>${sources}</ol>
    <form method="post" action="${escapeHtml(action)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
      <label>Type the last six hash characters (<code>${suffix}</code>)
        <input name="hash_suffix" minlength="6" maxlength="6" autocomplete="off" required>
      </label>
      <p><label><input type="checkbox" name="confirm" required> I confirm this exact order and maximum loss.</label></p>
      <button name="decision" value="approve" type="submit">Approve exact order</button>
      <button name="decision" value="reject" type="submit">Reject</button>
    </form>
  </main>`;
}

function genericMessagePage(): string {
  return messagePage("No financial action was taken unless this page says it was submitted.");
}

function failureMessagePage(
  code: ApprovalFailureCode,
  detail: string | null = null
): string {
  const detailHtml = detail
    ? `<p>Sanitized diagnostic: <code>${escapeHtml(detail)}</code></p>`
    : "";
  return `<main style="max-width:680px;margin:40px auto;font:16px system-ui"><h1>No financial action was taken unless this page says it was submitted.</h1><p>Local approval code: <code>${escapeHtml(
    code
  )}</code></p>${detailHtml}<p>You may close this local page.</p></main>`;
}

function messagePage(message: string): string {
  return `<main style="max-width:680px;margin:40px auto;font:16px system-ui"><h1>${escapeHtml(
    message
  )}</h1><p>You may close this local page.</p></main>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
