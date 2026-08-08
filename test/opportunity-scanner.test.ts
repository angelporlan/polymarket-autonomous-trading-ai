import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashCanonical } from "../src/domain/proposals.js";
import {
  evaluateOpportunity,
  snapshotHistoryPoint
} from "../src/domain/opportunity-scanner.js";
import type { CandidateMarket, ResearchBundle } from "../src/domain/types.js";
import { PUSD_SCALE } from "../src/domain/types.js";
import { TradingDatabase } from "../src/storage/database.js";
import { stringifyWithBigInts } from "../src/storage/codec.js";
import { marketFixture } from "./fixtures.js";

const NOW_MS = Date.parse("2026-08-08T12:00:00.000Z");

function candidate(): CandidateMarket {
  return {
    conditionId: `0x${"1".repeat(64)}`,
    slug: "test-market",
    question: "Test question",
    category: "politics",
    endTimeMs: NOW_MS + 7 * 24 * 60 * 60_000,
    volume24hMicros: 100n * PUSD_SCALE,
    liquidityMicros: 100n * PUSD_SCALE,
    spreadMicros: 10_000n,
    tokenIds: ["123456789"],
    active: true,
    acceptingOrders: true
  };
}

function bundle(): ResearchBundle {
  const withoutHash = {
    id: "research-test",
    marketConditionId: `0x${"1".repeat(64)}`,
    tokenId: "123456789",
    estimatedProbabilityMicros: 600_000n,
    eventVolatilityClass: "SLOW" as const,
    createdAtMs: NOW_MS - 1_000,
    expiresAtMs: NOW_MS + 60 * 60_000,
    sources: [
      {
        requestedUrl: "https://www.reuters.com/example",
        finalUrl: "https://www.reuters.com/example",
        registrableDomain: "reuters.com",
        publisher: "Reuters",
        title: "Report",
        publishedAtMs: NOW_MS - 1_000,
        retrievedAtMs: NOW_MS - 1_000,
        httpStatus: 200,
        contentType: "text/html" as const,
        excerptHash: "a".repeat(64),
        responseBodyHash: "b".repeat(64),
        supportedClaims: ["supports"],
        contradictedClaims: [],
        quotedFactHashes: ["c".repeat(64)],
        probabilityImpactMicros: 10_000n
      },
      {
        requestedUrl: "https://apnews.com/example",
        finalUrl: "https://apnews.com/example",
        registrableDomain: "apnews.com",
        publisher: "AP",
        title: "Report",
        publishedAtMs: NOW_MS - 1_000,
        retrievedAtMs: NOW_MS - 1_000,
        httpStatus: 200,
        contentType: "text/html" as const,
        excerptHash: "d".repeat(64),
        responseBodyHash: "e".repeat(64),
        supportedClaims: ["supports"],
        contradictedClaims: [],
        quotedFactHashes: ["f".repeat(64)],
        probabilityImpactMicros: -5_000n
      }
    ],
    rationale: "Verified sources support the estimate.",
    counterRationale: "The event can still resolve differently."
  } satisfies Omit<ResearchBundle, "contentHash">;
  return { ...withoutHash, contentHash: hashCanonical(withoutHash) };
}

function history(nowMs: number): ReturnType<typeof snapshotHistoryPoint>[] {
  const old = marketFixture(nowMs - 16 * 60_000);
  old.bestBidMicros = 380_000n;
  old.bestAskMicros = 390_000n;
  old.spreadMicros = 10_000n;
  const middle = marketFixture(nowMs - 5 * 60_000);
  middle.bestBidMicros = 390_000n;
  middle.bestAskMicros = 400_000n;
  middle.spreadMicros = 10_000n;
  return [snapshotHistoryPoint(old), snapshotHistoryPoint(middle)];
}

describe("deterministic opportunity scanner", () => {
  it("requires verified research, warm history, depth and net edge", () => {
    const snapshot = marketFixture(NOW_MS);
    const input = {
      candidate: candidate(),
      snapshot,
      history: history(NOW_MS),
      researchBundle: bundle(),
      nowMs: NOW_MS,
      riskMicros: 1n * PUSD_SCALE
    };
    const decision = evaluateOpportunity(input);
    expect(decision.accepted).toBe(true);
    expect(decision.features?.movement15mMicros).not.toBeNull();
    expect(decision.features?.netEdgeMicros).toBeGreaterThanOrEqual(50_000n);

    expect(evaluateOpportunity({ ...input, researchBundle: null }).reason).toBe(
      "RESEARCH_MISSING"
    );
    expect(
      evaluateOpportunity({ ...input, history: [history(NOW_MS)[1]!] }).reason
    ).toBe("HISTORY_WARMUP");
    expect(
      evaluateOpportunity({ ...input, riskMicros: 30n * PUSD_SCALE }).reason
    ).toBe("INSUFFICIENT_DEPTH");
  });

  it("treats stale snapshots and wide spreads as hard skips", () => {
    const snapshot = marketFixture(NOW_MS - 6_000);
    const input = {
      candidate: candidate(),
      snapshot,
      history: history(NOW_MS),
      researchBundle: bundle(),
      nowMs: NOW_MS,
      riskMicros: PUSD_SCALE
    };
    expect(evaluateOpportunity(input).reason).toBe("SNAPSHOT_STALE");
    const fresh = marketFixture(NOW_MS);
    fresh.spreadMicros = 40_000n;
    expect(evaluateOpportunity({ ...input, snapshot: fresh }).reason).toBe(
      "SPREAD_TOO_WIDE"
    );
  });

  it("persists append-only snapshots and rejects a tampered payload", () => {
    const database = new TradingDatabase(":memory:");
    const snapshot = marketFixture(NOW_MS);
    database.saveMarketSnapshot(snapshot);
    expect(database.listMarketSnapshots(snapshot.tokenId, NOW_MS - 1)).toEqual([
      snapshot
    ]);
    database.db
      .prepare("UPDATE market_snapshots SET payload_json = ?")
      .run(stringifyWithBigInts({ ...snapshot, bestAskMicros: 0n }));
    expect(database.listMarketSnapshots(snapshot.tokenId, NOW_MS - 1)).toEqual([]);
    database.close();
  });

  it("records a fork repair without rewriting the historical rows", () => {
    const database = new TradingDatabase(":memory:");
    database.appendAudit("FIRST", null, { value: 1 });
    database.appendAudit("SECOND", null, { value: 2 });
    const row = database.db
      .prepare("SELECT * FROM audit_events WHERE id = 2")
      .get() as {
      created_at_ms: number;
      event_type: string;
      subject_id: string | null;
      payload_json: string;
    };
    const previousHash = "fork";
    const eventHash = createHash("sha256")
      .update(
        JSON.stringify({
          previousHash,
          eventType: row.event_type,
          subjectId: row.subject_id,
          createdAtMs: row.created_at_ms,
          payload: JSON.parse(row.payload_json)
        })
      )
      .digest("hex");
    database.db
      .prepare("UPDATE audit_events SET previous_hash = ?, event_hash = ? WHERE id = 2")
      .run(previousHash, eventHash);
    expect(database.verifyAuditChain()).toBe(false);
    const repair = database.reconcileAuditChain();
    expect(repair.reconciled).toBe(true);
    expect(database.verifyAuditChain()).toBe(true);
    database.appendAudit("AFTER_REPAIR", null, { value: 3 });
    expect(database.verifyAuditChain()).toBe(true);
    database.close();
  });
});
