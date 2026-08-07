import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportLedger } from "../src/audit/exporter.js";
import { createOrderProposal } from "../src/domain/proposals.js";
import { createTradingSession } from "../src/domain/session.js";
import type { OrderProposal } from "../src/domain/types.js";
import { TradingDatabase } from "../src/storage/database.js";
import { intentFixture, riskContextFixture } from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(
    path.join(tmpdir(), "polymarket-ledger-export-test-")
  );
  temporaryDirectories.push(directory);
  return directory;
}

function submitProposalWithResponse(
  database: TradingDatabase,
  proposal: OrderProposal,
  responseJson: string,
  nowMs: number
): void {
  database.stageProposal(proposal);
  expect(
    database.claimAutonomousExecution(
      proposal.id,
      proposal.hash,
      proposal.sessionId,
      nowMs + 1
    )
  ).toBe(true);
  database.markExecutionSubmitted({
    proposalId: proposal.id,
    proposalHash: proposal.hash,
    clobOrderId: `0x${proposal.hash}`,
    status: "SUBMITTED_UNRECONCILED",
    submittedAtMs: nowMs + 4,
    responseJson
  });
  database.updateExecutionStatus(
    proposal.id,
    "LIVE",
    responseJson,
    nowMs + 5
  );
}

describe("exportLedger", () => {
  it("exports exact bigint strings, sanitizes invalid response JSON, and uses private permissions", () => {
    const nowMs = Date.parse("2026-07-23T12:34:56.000Z");
    const database = new TradingDatabase(":memory:");
    const intent = intentFixture(nowMs);
    intent.executionMode = "live";
    const session = createTradingSession({
      executionMode: "live",
      authorizedBudgetMicros: 5n * 1_000_000n,
      nowMs
    });
    database.saveTradingSession(session);
    intent.sessionId = session.id;
    const proposal = createOrderProposal(intent, riskContextFixture(nowMs));
    submitProposalWithResponse(database, proposal, "{invalid-json", nowMs);
    const formulaEventHash = database.appendAudit("=SUM(1,1)", null, {
      detail: "comma, quote \" and newline\nare preserved",
      amountMicros: 42n
    });

    const directory = temporaryDirectory();
    const result = exportLedger(database, directory, nowMs);
    expect(result).toEqual({
      jsonPath: path.join(directory, "ledger.json"),
      csvPath: path.join(directory, "ledger.csv"),
      accountingCsvPath: path.join(directory, "accounting.csv"),
      auditChainValid: true,
      exportedAt: "2026-07-23T12:34:56.000Z"
    });

    const json = JSON.parse(readFileSync(result.jsonPath, "utf8")) as {
      schemaVersion: number;
      auditChainValid: boolean;
      valuation: { status: string; reason: string | null };
      proposals: Array<{ sharesMicros: string; hash: string }>;
      executions: Array<{ response: unknown; responseJson: string }>;
      auditEvents: Array<{
        eventType: string;
        eventHash: string;
        payload: { amountMicros?: string };
      }>;
    };
    expect(json.schemaVersion).toBe(2);
    expect(json.auditChainValid).toBe(true);
    expect(json.valuation).toMatchObject({
      status: "UNAVAILABLE",
      reason: "EUR_QUOTE_MISSING"
    });
    expect(json.proposals[0]).toMatchObject({
      sharesMicros: "10000000",
      hash: proposal.hash
    });
    expect(json.executions[0]?.response).toEqual({ unavailable: true });
    expect(json.executions[0]?.responseJson).toBe("{invalid-json");
    expect(json.auditEvents.at(-1)).toMatchObject({
      eventType: "=SUM(1,1)",
      eventHash: formulaEventHash,
      payload: { amountMicros: "42" }
    });

    const csv = readFileSync(result.csvPath, "utf8");
    expect(csv).toMatch(
      /^"event_id","created_at","event_type","subject_id","previous_hash","event_hash","payload_json"/u
    );
    expect(csv).toContain(`"'=SUM(1,1)"`);
    expect(csv).toContain(`"${formulaEventHash}"`);
    expect(csv).toContain(`""amountMicros"": ""42""`);
    expect(readdirSync(directory)).toEqual([
      "accounting.csv",
      "ledger.csv",
      "ledger.json"
    ]);

    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(result.jsonPath).mode & 0o777).toBe(0o600);
      expect(statSync(result.csvPath).mode & 0o777).toBe(0o600);
      expect(statSync(result.accountingCsvPath).mode & 0o777).toBe(0o600);
    }
    database.close();
  });

  it("reports a tampered audit chain in both the result and JSON export", () => {
    const database = new TradingDatabase(":memory:");
    database.appendAudit("ORIGINAL_EVENT", "subject-1", {
      state: "original"
    });
    database.db
      .prepare("UPDATE audit_events SET payload_json = ? WHERE id = 1")
      .run(JSON.stringify({ state: "tampered" }));
    expect(database.verifyAuditChain()).toBe(false);

    const directory = temporaryDirectory();
    const result = exportLedger(
      database,
      directory,
      Date.parse("2026-07-23T13:00:00.000Z")
    );
    const json = JSON.parse(readFileSync(result.jsonPath, "utf8")) as {
      auditChainValid: boolean;
    };
    expect(result.auditChainValid).toBe(false);
    expect(json.auditChainValid).toBe(false);
    database.close();
  });

  it("exports a dated EUR valuation with quote provenance", () => {
    const nowMs = Date.parse("2026-07-23T12:34:56.000Z");
    const database = new TradingDatabase(":memory:");
    database.appendAudit("PAPER_RECONCILIATION_CHECKPOINT", null, {
      recordedAtMs: nowMs,
      realizedPnlMicros: 1_000_000n,
      unrealizedPnlMicros: -250_000n,
      netPnlMicros: 750_000n,
      totalFeesMicros: 50_000n
    });
    const directory = temporaryDirectory();
    const result = exportLedger(database, directory, nowMs, {
      baseCurrency: "pUSD",
      quoteCurrency: "EUR",
      rateEurPerPusdMicros: 920_000n,
      observedAtMs: nowMs - 60_000,
      validUntilMs: nowMs + 60 * 60_000,
      sourceName: "Fixture FX source",
      sourceUrl: "https://fx.example.test/quote"
    });
    const json = JSON.parse(readFileSync(result.jsonPath, "utf8")) as {
      valuation: {
        status: string;
        quote: { rateEurPerPusd: string; sourceName: string };
        paper: { netPnlPusd: string; netPnlEur: string };
      };
    };
    expect(json.valuation).toMatchObject({
      status: "AVAILABLE",
      quote: {
        rateEurPerPusd: "0.92",
        sourceName: "Fixture FX source"
      },
      paper: {
        netPnlPusd: "0.75",
        netPnlEur: "0.69"
      }
    });
    expect(readFileSync(result.accountingCsvPath, "utf8")).toContain(
      "\"net_pnl\",\"0.75\",\"0.69\""
    );
    database.close();
  });

  it("keeps pUSD accounting when an EUR quote is stale", () => {
    const nowMs = Date.parse("2026-07-23T12:34:56.000Z");
    const database = new TradingDatabase(":memory:");
    database.appendAudit("PAPER_RECONCILIATION_CHECKPOINT", null, {
      recordedAtMs: nowMs,
      realizedPnlMicros: 1_000_000n,
      unrealizedPnlMicros: 0n,
      netPnlMicros: 1_000_000n,
      totalFeesMicros: 0n
    });
    const directory = temporaryDirectory();
    const result = exportLedger(database, directory, nowMs, {
      baseCurrency: "pUSD",
      quoteCurrency: "EUR",
      rateEurPerPusdMicros: 920_000n,
      observedAtMs: nowMs - 2 * 24 * 60 * 60_000,
      validUntilMs: nowMs + 60 * 60_000,
      sourceName: "Fixture FX source",
      sourceUrl: "https://fx.example.test/quote"
    });
    const json = JSON.parse(readFileSync(result.jsonPath, "utf8")) as {
      valuation: {
        status: string;
        reason: string;
        paper: { netPnlPusd: string; netPnlEur: string | null };
      };
    };
    expect(json.valuation).toMatchObject({
      status: "UNAVAILABLE",
      reason: "EUR_QUOTE_STALE",
      paper: { netPnlPusd: "1", netPnlEur: null }
    });
    database.close();
  });
});
