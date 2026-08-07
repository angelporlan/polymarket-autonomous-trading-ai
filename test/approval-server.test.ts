import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalHttpServer } from "../src/approval/server.js";
import { createOrderProposal } from "../src/domain/proposals.js";
import type { OrderIntent } from "../src/domain/types.js";
import { TradingDatabase } from "../src/storage/database.js";
import { intentFixture, riskContextFixture } from "./fixtures.js";

const servers: ApprovalHttpServer[] = [];
const databases: TradingDatabase[] = [];
let nextPort = 20_000 + (process.pid % 20_000);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("ApprovalHttpServer", () => {
  it("accepts a canonical 127.0.0.1 Chrome-style POST and blocks replay", async () => {
    const harness = await createHarness();
    const challenge = await getChallenge(harness);
    expect(challenge.html).toContain(
      `action="http://127.0.0.1:${harness.port}/approve/${harness.proposal.id}"`
    );

    const result = await postApproval(harness, challenge, {
      origin: `http://127.0.0.1:${harness.port}`,
      extraHeaders: chromeNavigationHeaders()
    });
    expect(result.status).toBe(200);
    expect(harness.approvals()).toBe(1);
    expect(harness.database.getProposal(harness.proposal.id)?.status).toBe(
      "LOCALLY_APPROVED"
    );

    const replay = await postApproval(harness, challenge, {
      origin: `http://127.0.0.1:${harness.port}`
    });
    expect(replay.status).toBe(409);
    expect(replay.body).toContain("PROPOSAL_EXPIRED");
    expect(harness.approvals()).toBe(1);
  });

  it("normalizes localhost casing and a trailing slash without mixing aliases", async () => {
    const harness = await createHarness();
    const host = `LOCALHOST:${harness.port}`;
    const challenge = await getChallenge(harness, host);
    expect(challenge.html).toContain(
      `action="http://localhost:${harness.port}/approve/${harness.proposal.id}"`
    );

    const result = await postApproval(harness, challenge, {
      host,
      origin: `HTTP://LOCALHOST:${harness.port}/`
    });
    expect(result.status).toBe(200);
    expect(harness.approvals()).toBe(1);
  });

  it("rejects cross-alias loopback origins (127.0.0.1 and localhost)", async () => {
    const harness = await createHarness();
    const challenge = await getChallenge(harness);

    const result = await postApproval(harness, challenge, {
      host: `127.0.0.1:${harness.port}`,
      origin: `http://localhost:${harness.port}`
    });
    expect(result.status).toBe(403);
    expect(result.body).toContain("ORIGIN_INVALID");
    expect(harness.approvals()).toBe(0);
  });

  it("rejects absent, null, foreign, extension, malformed, and out-of-spec origins", async () => {
    const harness = await createHarness();
    const challenge = await getChallenge(harness);
    const expectedOrigin = `http://127.0.0.1:${harness.port}`;
    const invalidOrigins: Array<{
      label: string;
      origin?: string | string[];
    }> = [
      { label: "missing" },
      { label: "null", origin: "null" },
      { label: "foreign", origin: "http://attacker.invalid" },
      { label: "extension", origin: "chrome-extension://abcdefghijklmnop" },
      { label: "https", origin: `https://127.0.0.1:${harness.port}` },
      { label: "wrong port", origin: "http://127.0.0.1:9999" },
      {
        label: "credentials",
        origin: `http://user@127.0.0.1:${harness.port}`
      },
      { label: "query", origin: `${expectedOrigin}/?unexpected=1` },
      { label: "fragment", origin: `${expectedOrigin}/#unexpected` },
      {
        label: "multiple",
        origin: [expectedOrigin, expectedOrigin]
      }
    ];

    for (const invalid of invalidOrigins) {
      const result = await postApproval(
        harness,
        challenge,
        invalid.origin === undefined ? {} : { origin: invalid.origin }
      );
      expect(result.status, invalid.label).toBe(403);
      expect(result.body, invalid.label).toContain("ORIGIN_INVALID");
    }
    expect(harness.approvals()).toBe(0);
    expect(harness.database.getProposal(harness.proposal.id)?.status).toBe(
      "AWAITING_LOCAL"
    );

    const valid = await postApproval(harness, challenge, {
      origin: expectedOrigin
    });
    expect(valid.status).toBe(200);
    expect(harness.approvals()).toBe(1);
  });

  it("reports distinct session, CSRF, confirmation, and expiration failures", async () => {
    const harness = await createHarness();
    const origin = `http://127.0.0.1:${harness.port}`;

    const missingSessionChallenge = await getChallenge(harness);
    const missingSession = await postApproval(
      harness,
      missingSessionChallenge,
      { origin, omitCookie: true }
    );
    expect(missingSession.status).toBe(403);
    expect(missingSession.body).toContain("SESSION_MISSING");

    const invalidCsrf = await postApproval(harness, missingSessionChallenge, {
      origin,
      csrf: "invalid"
    });
    expect(invalidCsrf.status).toBe(403);
    expect(invalidCsrf.body).toContain("CSRF_INVALID");

    const confirmationChallenge = await getChallenge(harness);
    const confirmationMismatch = await postApproval(
      harness,
      confirmationChallenge,
      { origin, hashSuffix: "000000" }
    );
    expect(confirmationMismatch.status).toBe(400);
    expect(confirmationMismatch.body).toContain("CONFIRMATION_MISMATCH");

    const expirationChallenge = await getChallenge(harness);
    harness.setNow(harness.proposal.expiresAtMs + 1);
    const expired = await postApproval(harness, expirationChallenge, {
      origin
    });
    expect(expired.status).toBe(409);
    expect(expired.body).toContain("PROPOSAL_EXPIRED");
    expect(harness.approvals()).toBe(0);
  });

  it("escapes market text while preserving the fail-closed approval page", async () => {
    const harness = await createHarness((intent) => {
      intent.market.question = "<script>window.pwned=true</script>";
    });
    const challenge = await getChallenge(harness);
    expect(challenge.html).not.toContain("<script>");
    expect(challenge.html).toContain("&lt;script&gt;");
  });
});

interface Harness {
  database: TradingDatabase;
  proposal: ReturnType<typeof createOrderProposal>;
  port: number;
  url: string;
  approvals: () => number;
  setNow: (value: number) => void;
}

interface Challenge {
  cookie: string;
  csrf: string;
  html: string;
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

async function createHarness(
  mutateIntent?: (intent: OrderIntent) => void
): Promise<Harness> {
  const database = new TradingDatabase(":memory:");
  databases.push(database);
  let nowMs = Date.now();
  const intent = intentFixture(nowMs);
  mutateIntent?.(intent);
  const proposal = createOrderProposal(intent, riskContextFixture(nowMs));
  database.stageProposal(proposal);
  database.transitionProposal(
    proposal.id,
    "STAGED",
    "AWAITING_LOCAL",
    nowMs + 1
  );
  let approvalCount = 0;
  const port = nextPort++;
  const server = new ApprovalHttpServer({
    host: "127.0.0.1",
    port,
    database,
    now: () => nowMs,
    onApproved: async () => {
      approvalCount += 1;
      return { accepted: true, message: "Accepted by test executor." };
    }
  });
  servers.push(server);
  await server.start();
  return {
    database,
    proposal,
    port,
    url: server.approvalUrl(proposal.id),
    approvals: () => approvalCount,
    setNow: (value) => {
      nowMs = value;
    }
  };
}

async function getChallenge(
  harness: Harness,
  host = `127.0.0.1:${harness.port}`
): Promise<Challenge> {
  const page = await requestLoopback(harness, {
    method: "GET",
    host
  });
  expect(page.status).toBe(200);
  const setCookie = page.headers["set-cookie"]?.[0] ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? "";
  expect(cookie).toBeTruthy();
  expect(csrf).toBeTruthy();
  return { cookie, csrf, html: page.body };
}

async function postApproval(
  harness: Harness,
  challenge: Challenge,
  options: {
    host?: string;
    origin?: string | string[];
    omitCookie?: boolean;
    csrf?: string;
    hashSuffix?: string;
    extraHeaders?: OutgoingHttpHeaders;
  }
): Promise<HttpResult> {
  const form = new URLSearchParams({
    csrf: options.csrf ?? challenge.csrf,
    hash_suffix: options.hashSuffix ?? harness.proposal.hash.slice(-6),
    confirm: "on",
    decision: "approve"
  }).toString();
  const headers: OutgoingHttpHeaders = {
    ...(options.extraHeaders ?? {}),
    "Content-Type": "application/x-www-form-urlencoded",
    "Content-Length": Buffer.byteLength(form)
  };
  if (options.origin !== undefined) {
    headers.Origin = options.origin;
  }
  if (!options.omitCookie) {
    headers.Cookie = challenge.cookie;
  }
  return requestLoopback(harness, {
    method: "POST",
    ...(options.host === undefined ? {} : { host: options.host }),
    headers,
    body: form
  });
}

function requestLoopback(
  harness: Harness,
  options: {
    method: "GET" | "POST";
    host?: string;
    headers?: OutgoingHttpHeaders;
    body?: string;
  }
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: harness.port,
        path: new URL(harness.url).pathname,
        method: options.method,
        headers: {
          Host: options.host ?? `127.0.0.1:${harness.port}`,
          ...(options.headers ?? {})
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

function chromeNavigationHeaders(): OutgoingHttpHeaders {
  return {
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": "Mozilla/5.0 Chrome approval integration test"
  };
}
