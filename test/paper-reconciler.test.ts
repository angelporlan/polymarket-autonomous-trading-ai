import { describe, expect, it } from "vitest";
import { createOrderProposal } from "../src/domain/proposals.js";
import {
  PUSD_SCALE,
  type MarketSnapshot,
  type PaperTrade
} from "../src/domain/types.js";
import {
  PaperReconciler,
  PaperReconciliationError,
  ReconciledPaperGate
} from "../src/paper/reconciler.js";
import { PaperSimulator } from "../src/paper/simulator.js";
import { TradingDatabase } from "../src/storage/database.js";
import {
  intentFixture,
  marketFixture,
  riskContextFixture
} from "./fixtures.js";

class SnapshotSource {
  constructor(private readonly snapshot: MarketSnapshot) {}

  async getMarketSnapshot(): Promise<MarketSnapshot> {
    return this.snapshot;
  }
}

function stageFilledTrade(
  database: TradingDatabase,
  nowMs: number
): PaperTrade {
  const proposal = createOrderProposal(
    intentFixture(nowMs),
    riskContextFixture(nowMs)
  );
  database.stageProposal(proposal);
  const trade = new PaperSimulator().tryImmediateFill(
    proposal,
    proposal.market
  );
  const openedTrade = { ...trade, openedAtMs: nowMs };
  database.savePaperTrade(openedTrade);
  database.transitionProposal(proposal.id, "STAGED", "SIMULATED", nowMs);
  return openedTrade;
}

describe("paper reconciler", () => {
  it("values a partial fill from executable fresh bids", async () => {
    const nowMs = Date.now();
    const database = new TradingDatabase(":memory:");
    const trade = stageFilledTrade(database, nowMs);
    const snapshot = marketFixture(nowMs);
    snapshot.bestBidMicros = 420_000n;
    snapshot.bestAskMicros = 430_000n;
    snapshot.spreadMicros = 10_000n;
    snapshot.bids = [
      { priceMicros: 420_000n, sharesMicros: 4n * PUSD_SCALE },
      { priceMicros: 410_000n, sharesMicros: 4n * PUSD_SCALE }
    ];
    snapshot.asks = [
      { priceMicros: 430_000n, sharesMicros: 20n * PUSD_SCALE }
    ];

    const checkpoint = await new PaperReconciler(
      database,
      new SnapshotSource(snapshot),
      () => nowMs
    ).reconcile();

    expect(trade.filledSharesMicros).toBe(8n * PUSD_SCALE);
    expect(checkpoint.filledOperationCount).toBe(1);
    expect(checkpoint.positions[0]?.liquidationValueMicros).toBe(
      3_320_000n
    );
    expect(checkpoint.positions[0]?.costBasisMicros).toBe(3_200_000n);
    expect(checkpoint.netPnlMicros).toBe(120_000n);
    expect(
      database.countAuditEvents("PAPER_RECONCILIATION_CHECKPOINT")
    ).toBe(1);
    expect(database.verifyAuditChain()).toBe(true);
    database.close();
  });

  it("rejects a manually injected realized profit", async () => {
    const nowMs = Date.now();
    const database = new TradingDatabase(":memory:");
    const trade = stageFilledTrade(database, nowMs);
    database.savePaperTrade({
      ...trade,
      realizedPnlMicros: 50n * PUSD_SCALE
    });

    const reconciler = new PaperReconciler(
      database,
      new SnapshotSource(marketFixture(nowMs)),
      () => nowMs
    );
    await expect(reconciler.reconcile()).rejects.toMatchObject({
      code: "INVALID_RECORDED_FILL"
    } satisfies Partial<PaperReconciliationError>);
    expect(database.countAuditEvents("PAPER_RECONCILIATION_ERROR")).toBe(1);
    expect(
      database.countAuditEvents("PAPER_RECONCILIATION_CHECKPOINT")
    ).toBe(0);
    database.close();
  });

  it("expires an unfilled GTD order without inventing a fill", async () => {
    const openedAtMs = Date.now();
    const database = new TradingDatabase(":memory:");
    const intent = intentFixture(openedAtMs);
    intent.limitPriceMicros = 390_000n;
    intent.estimatedProbabilityMicros = 500_000n;
    const proposal = createOrderProposal(
      intent,
      riskContextFixture(openedAtMs)
    );
    database.stageProposal(proposal);
    const trade = new PaperSimulator().tryImmediateFill(
      proposal,
      proposal.market
    );
    database.savePaperTrade({ ...trade, openedAtMs });
    database.transitionProposal(
      proposal.id,
      "STAGED",
      "SIMULATED",
      openedAtMs
    );
    const nowMs = openedAtMs + 15 * 60_000;

    const checkpoint = await new PaperReconciler(
      database,
      new SnapshotSource(marketFixture(nowMs)),
      () => nowMs
    ).reconcile();

    expect(checkpoint.filledOperationCount).toBe(0);
    expect(checkpoint.expiredUnfilledOrderCount).toBe(1);
    expect(database.getPaperTradeByProposal(proposal.id)).toMatchObject({
      status: "CANCELLED",
      filledSharesMicros: 0n,
      realizedPnlMicros: 0n
    });
    database.close();
  });

  it("does not create a checkpoint from stale valuation data", async () => {
    const nowMs = Date.now();
    const database = new TradingDatabase(":memory:");
    stageFilledTrade(database, nowMs);
    const stale = marketFixture(nowMs - 6_000);
    stale.endTimeMs = nowMs + 7 * 24 * 60 * 60_000;

    const reconciler = new PaperReconciler(
      database,
      new SnapshotSource(stale),
      () => nowMs
    );
    await expect(reconciler.reconcile()).rejects.toMatchObject({
      code: "SNAPSHOT_INVALID"
    } satisfies Partial<PaperReconciliationError>);
    expect(
      database.countAuditEvents("PAPER_RECONCILIATION_CHECKPOINT")
    ).toBe(0);
    database.close();
  });

  it("derives FIFO realized PnL and both sides' fees from verified fills", async () => {
    const openedAtMs = Date.now();
    const database = new TradingDatabase(":memory:");

    const buyIntent = intentFixture(openedAtMs);
    buyIntent.market.feeRateBps = 100;
    const buyProposal = createOrderProposal(
      buyIntent,
      riskContextFixture(openedAtMs)
    );
    database.stageProposal(buyProposal);
    database.savePaperTrade({
      ...new PaperSimulator().tryImmediateFill(
        buyProposal,
        buyProposal.market
      ),
      openedAtMs
    });
    database.transitionProposal(
      buyProposal.id,
      "STAGED",
      "SIMULATED",
      openedAtMs
    );

    const sellAtMs = openedAtMs + 1_000;
    const sellIntent = intentFixture(sellAtMs);
    sellIntent.market.feeRateBps = 100;
    sellIntent.side = "SELL";
    sellIntent.sharesMicros = 4n * PUSD_SCALE;
    sellIntent.limitPriceMicros = 390_000n;
    sellIntent.estimatedProbabilityMicros = 300_000n;
    const sellRisk = riskContextFixture(sellAtMs);
    sellRisk.heldSharesMicros = 8n * PUSD_SCALE;
    sellRisk.marketExposureMicros = 3_232_000n;
    sellRisk.totalOpenExposureMicros = 3_232_000n;
    const sellProposal = createOrderProposal(sellIntent, sellRisk);
    database.stageProposal(sellProposal);
    database.savePaperTrade({
      ...new PaperSimulator().tryImmediateFill(
        sellProposal,
        sellProposal.market
      ),
      openedAtMs: sellAtMs
    });
    database.transitionProposal(
      sellProposal.id,
      "STAGED",
      "SIMULATED",
      sellAtMs
    );

    const snapshot = marketFixture(sellAtMs);
    snapshot.feeRateBps = 100;
    snapshot.bestBidMicros = 420_000n;
    snapshot.bestAskMicros = 430_000n;
    snapshot.spreadMicros = 10_000n;
    snapshot.bids = [
      { priceMicros: 420_000n, sharesMicros: 20n * PUSD_SCALE }
    ];
    snapshot.asks = [
      { priceMicros: 430_000n, sharesMicros: 20n * PUSD_SCALE }
    ];

    const checkpoint = await new PaperReconciler(
      database,
      new SnapshotSource(snapshot),
      () => sellAtMs
    ).reconcile();

    expect(checkpoint.matchedSellOperationCount).toBe(1);
    expect(checkpoint.realizedPnlMicros).toBe(-59_120n);
    expect(checkpoint.unrealizedPnlMicros).toBe(60_660n);
    expect(checkpoint.netPnlMicros).toBe(1_540n);
    expect(checkpoint.totalFeesMicros).toBe(28_720n);
    expect(checkpoint.positions[0]).toMatchObject({
      sharesMicros: 4n * PUSD_SCALE,
      costBasisMicros: 1_609_600n,
      liquidationValueMicros: 1_670_260n
    });
    database.close();
  });

  it("computes drawdown from reconciled mark-to-market checkpoints", async () => {
    let nowMs = Date.now();
    const database = new TradingDatabase(":memory:");
    stageFilledTrade(database, nowMs);
    const snapshot = marketFixture(nowMs);
    snapshot.bestBidMicros = 500_000n;
    snapshot.bestAskMicros = 510_000n;
    snapshot.spreadMicros = 10_000n;
    snapshot.bids = [
      { priceMicros: 500_000n, sharesMicros: 20n * PUSD_SCALE }
    ];
    snapshot.asks = [
      { priceMicros: 510_000n, sharesMicros: 20n * PUSD_SCALE }
    ];
    const gate = new ReconciledPaperGate(
      database,
      new PaperReconciler(
        database,
        new SnapshotSource(snapshot),
        () => nowMs
      ),
      () => nowMs
    );

    expect((await gate.metrics()).netPnlMicros).toBe(800_000n);
    nowMs += 6_000;
    snapshot.capturedAtMs = nowMs;
    snapshot.bestBidMicros = 350_000n;
    snapshot.bestAskMicros = 360_000n;
    snapshot.spreadMicros = 10_000n;
    snapshot.bids = [
      { priceMicros: 350_000n, sharesMicros: 20n * PUSD_SCALE }
    ];
    snapshot.asks = [
      { priceMicros: 360_000n, sharesMicros: 20n * PUSD_SCALE }
    ];

    const metrics = await gate.metrics();
    expect(metrics.netPnlMicros).toBe(-400_000n);
    expect(metrics.maxDrawdownMicros).toBe(1_200_000n);
    expect(metrics.totalTrades).toBe(1);
    database.close();
  });
});
