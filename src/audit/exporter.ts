import {
  chmodSync,
  mkdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import type { AuditEventRecord } from "../storage/database.js";
import type { TradingDatabase } from "../storage/database.js";
import { formatMicros } from "../domain/types.js";
import {
  convertPusdToEurMicros,
  formatEurMicros,
  validateEurFxQuote,
  type EurFxQuote
} from "../accounting/valuation.js";

export interface LedgerExportResult {
  jsonPath: string;
  csvPath: string;
  accountingCsvPath: string;
  auditChainValid: boolean;
  exportedAt: string;
}

export function exportLedger(
  database: TradingDatabase,
  outputDirectory: string,
  nowMs = Date.now(),
  eurFxQuote?: EurFxQuote
): LedgerExportResult {
  const directory = path.resolve(outputDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  const exportedAt = new Date(nowMs).toISOString();
  const auditChainValid = database.verifyAuditChain();
  const proposals = database.listProposals();
  const executions = database.listExecutions();
  const paperTrades = database.listPaperTrades();
  const auditEvents = database.listAuditEvents();
  const valuation = buildLedgerValuation(auditEvents, nowMs, eurFxQuote);
  const payload = {
    schemaVersion: 2,
    exportedAt,
    auditChainValid,
    valuation,
    proposals,
    executions: executions.map((execution) => ({
      ...execution,
      response: safeParseJson(execution.responseJson)
    })),
    paperTrades,
    auditEvents
  };

  const jsonPath = path.join(directory, "ledger.json");
  const csvPath = path.join(directory, "ledger.csv");
  const accountingCsvPath = path.join(directory, "accounting.csv");
  atomicPrivateWrite(jsonPath, `${exactJson(payload)}\n`);

  const rows: string[][] = [
    [
      "event_id",
      "created_at",
      "event_type",
      "subject_id",
      "previous_hash",
      "event_hash",
      "payload_json"
    ],
    ...auditEvents.map((event) => [
      String(event.id),
      new Date(event.createdAtMs).toISOString(),
      event.eventType,
      event.subjectId ?? "",
      event.previousHash,
      event.eventHash,
      exactJson(event.payload)
    ])
  ];
  atomicPrivateWrite(
    csvPath,
    `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`
  );
  atomicPrivateWrite(
    accountingCsvPath,
    `${buildAccountingRows(valuation)
      .map((row) => row.map(csvCell).join(","))
      .join("\n")}\n`
  );

  return {
    jsonPath,
    csvPath,
    accountingCsvPath,
    auditChainValid,
    exportedAt
  };
}

interface LedgerValuation {
  currency: "EUR";
  status: "AVAILABLE" | "UNAVAILABLE";
  valuationAt: string;
  reason: string | null;
  quote: {
    baseCurrency: "pUSD";
    quoteCurrency: "EUR";
    rateEurPerPusd: string;
    observedAt: string;
    validUntil: string;
    sourceName: string;
    sourceUrl: string;
  } | null;
  paper: {
    recordedAt: string;
    realizedPnlPusd: string;
    realizedPnlEur: string | null;
    unrealizedPnlPusd: string;
    unrealizedPnlEur: string | null;
    netPnlPusd: string;
    netPnlEur: string | null;
    totalFeesPusd: string;
    totalFeesEur: string | null;
  } | null;
}

function buildLedgerValuation(
  auditEvents: AuditEventRecord[],
  nowMs: number,
  eurFxQuote: EurFxQuote | undefined
): LedgerValuation {
  const valuationAt = new Date(nowMs).toISOString();
  const checkpoint = latestPaperCheckpoint(auditEvents);
  try {
    const quote = validateEurFxQuote(eurFxQuote, nowMs);
    const paper =
      checkpoint === null
        ? null
        : paperValuation(checkpoint, quote);
    return {
      currency: "EUR",
      status: "AVAILABLE",
      valuationAt,
      reason: null,
      quote: {
        baseCurrency: quote.baseCurrency,
        quoteCurrency: quote.quoteCurrency,
        rateEurPerPusd: formatMicros(quote.rateEurPerPusdMicros),
        observedAt: new Date(quote.observedAtMs).toISOString(),
        validUntil: new Date(quote.validUntilMs).toISOString(),
        sourceName: quote.sourceName,
        sourceUrl: quote.sourceUrl
      },
      paper
    };
  } catch (error) {
    return {
      currency: "EUR",
      status: "UNAVAILABLE",
      valuationAt,
      reason:
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "EUR_QUOTE_INVALID",
      quote: null,
      paper:
        checkpoint === null ? null : paperValuation(checkpoint, null)
    };
  }
}

function paperValuation(
  checkpoint: Record<string, unknown>,
  quote: EurFxQuote | null
): LedgerValuation["paper"] {
  const recordedAtMs = readFiniteInteger(checkpoint.recordedAtMs);
  const realizedPnlMicros = readBigInt(checkpoint.realizedPnlMicros);
  const unrealizedPnlMicros = readBigInt(checkpoint.unrealizedPnlMicros);
  const netPnlMicros = readBigInt(checkpoint.netPnlMicros);
  const totalFeesMicros = readBigInt(checkpoint.totalFeesMicros);
  return {
    recordedAt: new Date(recordedAtMs).toISOString(),
    realizedPnlPusd: formatMicros(realizedPnlMicros),
    realizedPnlEur:
      quote === null
        ? null
        : formatEurMicros(convertPusdToEurMicros(realizedPnlMicros, quote)),
    unrealizedPnlPusd: formatMicros(unrealizedPnlMicros),
    unrealizedPnlEur:
      quote === null
        ? null
        : formatEurMicros(
            convertPusdToEurMicros(unrealizedPnlMicros, quote)
          ),
    netPnlPusd: formatMicros(netPnlMicros),
    netPnlEur:
      quote === null
        ? null
        : formatEurMicros(convertPusdToEurMicros(netPnlMicros, quote)),
    totalFeesPusd: formatMicros(totalFeesMicros),
    totalFeesEur:
      quote === null
        ? null
        : formatEurMicros(convertPusdToEurMicros(totalFeesMicros, quote))
  };
}

function latestPaperCheckpoint(
  auditEvents: AuditEventRecord[]
): Record<string, unknown> | null {
  for (const event of [...auditEvents].reverse()) {
    if (
      event.eventType === "PAPER_RECONCILIATION_CHECKPOINT" &&
      isRecord(event.payload)
    ) {
      return event.payload;
    }
  }
  return null;
}

function buildAccountingRows(valuation: LedgerValuation): string[][] {
  const header = [
    "scope",
    "recorded_at",
    "metric",
    "pUSD",
    "EUR",
    "fx_rate_eur_per_pUSD",
    "fx_source",
    "fx_observed_at",
    "valuation_status",
    "valuation_reason"
  ];
  const quote = valuation.quote;
  const fx = quote?.rateEurPerPusd ?? "";
  const source = quote?.sourceName ?? "";
  const observedAt = quote?.observedAt ?? "";
  const base = [
    fx,
    source,
    observedAt,
    valuation.status,
    valuation.reason ?? ""
  ];
  if (valuation.paper === null) {
    return [
      header,
      [
        "paper",
        "",
        "status",
        "",
        "",
        ...base
      ]
    ];
  }
  const recordedAt = valuation.paper.recordedAt;
  return [
    header,
    ["paper", recordedAt, "realized_pnl", valuation.paper.realizedPnlPusd, valuation.paper.realizedPnlEur ?? "", ...base],
    ["paper", recordedAt, "unrealized_pnl", valuation.paper.unrealizedPnlPusd, valuation.paper.unrealizedPnlEur ?? "", ...base],
    ["paper", recordedAt, "net_pnl", valuation.paper.netPnlPusd, valuation.paper.netPnlEur ?? "", ...base],
    ["paper", recordedAt, "fees", valuation.paper.totalFeesPusd, valuation.paper.totalFeesEur ?? "", ...base]
  ];
}

function readBigInt(value: unknown): bigint {
  if (typeof value !== "bigint") {
    throw new Error("EUR_CHECKPOINT_VALUE_INVALID");
  }
  return value;
}

function readFiniteInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("EUR_CHECKPOINT_TIMESTAMP_INVALID");
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, candidate: unknown) =>
      typeof candidate === "bigint" ? candidate.toString() : candidate,
    2
  );
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { unavailable: true };
  }
}

function atomicPrivateWrite(filename: string, contents: string): void {
  const temporary = `${filename}.tmp`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, filename);
  chmodSync(filename, 0o600);
}

function csvCell(value: string): string {
  const protectedValue = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}
