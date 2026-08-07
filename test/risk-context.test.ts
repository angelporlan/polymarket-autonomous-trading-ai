import { describe, expect, it } from "vitest";
import { DatabaseRiskContext, zonedDayKey } from "../src/application/risk-context.js";
import type { MarketDataPort } from "../src/application/ports.js";
import {
  createOrderProposal,
  ProposalRejectedError
} from "../src/domain/proposals.js";
import { createTradingSession } from "../src/domain/session.js";
import {
  PUSD_SCALE,
  type LocalApproval,
  type OrderProposal,
  type PaperTrade,
  type PortfolioSnapshot
} from "../src/domain/types.js";
import { PaperSimulator } from "../src/paper/simulator.js";
import { TradingDatabase } from "../src/storage/database.js";
import { intentFixture, marketFixture, riskContextFixture } from "./fixtures.js";

const PROFILE_ADDRESS = `0x${"a".repeat(40)}`;

function marketDataFor(
  readPortfolio: () => PortfolioSnapshot
): MarketDataPort {
  return {
    async profileExists() {
      return true;
    },
    async getPortfolio() {
      return readPortfolio();
    },
    async getUserActivity() {
      return [];
    },
    async scanCandidates() {
      return [];
    },
    async getMarketSnapshot() {
      return marketFixture();
    },
    async checkGeoblock() {
      return {
        blocked: false,
        country: "ES",
        region: "MD",
        checkedAtMs: Date.now()
      };
    }
  };
}

function submitProposal(
  database: TradingDatabase,
  proposal: OrderProposal,
  remoteStatus: string,
  nowMs: number
): void {
  database.stageProposal(proposal);
  expect(
    database.transitionProposal(
      proposal.id,
      "STAGED",
      "AWAITING_LOCAL",
      nowMs + 1
    )
  ).not.toBeNull();
  expect(
    database.transitionProposal(
      proposal.id,
      "AWAITING_LOCAL",
      "LOCALLY_APPROVED",
      nowMs + 2
    )
  ).not.toBeNull();
  const approval: LocalApproval = {
    proposalId: proposal.id,
    proposalHash: proposal.hash,
    approvedAtMs: nowMs + 2,
    expiresAtMs: proposal.expiresAtMs,
    nonceHash: `nonce-${proposal.id}`,
    consumedAtMs: null
  };
  database.recordLocalApproval(approval);
  expect(database.claimExecution(proposal.id, proposal.hash, nowMs + 3)).toBe(
    true
  );
  database.markExecutionSubmitted({
    proposalId: proposal.id,
    proposalHash: proposal.hash,
    clobOrderId: `0x${proposal.hash}`,
    status: "SUBMITTED_UNRECONCILED",
    submittedAtMs: nowMs + 4,
    responseJson: JSON.stringify({ status: remoteStatus })
  });
  database.updateExecutionStatus(
    proposal.id,
    remoteStatus,
    JSON.stringify({ status: remoteStatus }),
    nowMs + 5
  );
}

function recordPaperProposal(
  database: TradingDatabase,
  proposal: OrderProposal,
  openedAtMs: number
): PaperTrade {
  database.stageProposal(proposal);
  const trade = {
    ...new PaperSimulator().tryImmediateFill(proposal, proposal.market),
    openedAtMs
  };
  database.savePaperTrade(trade);
  expect(
    database.transitionProposal(
      proposal.id,
      "STAGED",
      "SIMULATED",
      openedAtMs
    )
  ).not.toBeNull();
  return trade;
}

describe("DatabaseRiskContext", () => {
  it("counts positions and unresolved BUY orders without counting terminal orders", async () => {
    const nowMs = Date.parse("2026-07-23T10:00:00.000Z");
    const database = new TradingDatabase(":memory:");
    const snapshot = marketFixture(nowMs);
    const session = createTradingSession({
      executionMode: "live",
      authorizedBudgetMicros: 10n * PUSD_SCALE,
      nowMs
    });
    database.saveTradingSession(session);

    const activeIntent = intentFixture(nowMs);
    activeIntent.executionMode = "live";
    activeIntent.sessionId = session.id;
    activeIntent.sharesMicros = 5n * PUSD_SCALE;
    activeIntent.market.eventId = "shared-event";
    activeIntent.correlationKey = "event:shared-event";
    const activeProposal = createOrderProposal(
      activeIntent,
      riskContextFixture(nowMs)
    );
    submitProposal(database, activeProposal, "LIVE", nowMs);

    const terminalIntent = intentFixture(nowMs);
    terminalIntent.executionMode = "live";
    terminalIntent.sessionId = session.id;
    terminalIntent.market = {
      ...terminalIntent.market,
      conditionId: `0x${"3".repeat(64)}`,
      tokenId: "333",
      eventId: "other-event"
    };
    terminalIntent.correlationKey = "event:other-event";
    const terminalProposal = createOrderProposal(
      terminalIntent,
      riskContextFixture(nowMs)
    );
    submitProposal(database, terminalProposal, "CONFIRMED", nowMs + 10);

    const portfolio: PortfolioSnapshot = {
      profileAddress: PROFILE_ADDRESS,
      pUsdBalanceMicros: null,
      totalPositionValueMicros: 5_500_000n,
      totalPnlMicros: 2n * PUSD_SCALE,
      positions: [
        {
          tokenId: snapshot.tokenId,
          conditionId: snapshot.conditionId,
          question: snapshot.question,
          outcome: snapshot.outcome,
          sizeMicros: 3n * PUSD_SCALE,
          averagePriceMicros: 400_000n,
          currentPriceMicros: 500_000n,
          currentValueMicros: 1_500_000n,
          cashPnlMicros: 300_000n,
          realizedPnlMicros: 0n,
          endTimeMs: snapshot.endTimeMs
        },
        {
          tokenId: "333",
          conditionId: `0x${"3".repeat(64)}`,
          question: "A second open market",
          outcome: "No",
          sizeMicros: 8n * PUSD_SCALE,
          averagePriceMicros: 500_000n,
          currentPriceMicros: 500_000n,
          currentValueMicros: 4n * PUSD_SCALE,
          cashPnlMicros: 0n,
          realizedPnlMicros: 0n,
          endTimeMs: snapshot.endTimeMs
        }
      ],
      capturedAtMs: nowMs,
      source: "public"
    };
    const contexts = new DatabaseRiskContext({
      database,
      marketData: marketDataFor(() => portfolio),
      profileAddress: PROFILE_ADDRESS,
      now: () => nowMs
    });

    const context = await contexts.forOrder(
      snapshot,
      "BUY",
      activeProposal.correlationKey,
      "live"
    );
    expect(context).toMatchObject({
      liveTradeCount: 0,
      dailyPnlMicros: 0n,
      totalOpenExposureMicros: 7_500_000n,
      marketExposureMicros: 3_500_000n,
      correlatedExposureMicros: 3_500_000n,
      openMarketCount: 2,
      heldSharesMicros: 3n * PUSD_SCALE,
      emergencyStopped: false,
      coolingDownUntilMs: null
    });

    const revalidationContext = await contexts.forOrder(
      snapshot,
      "BUY",
      activeProposal.correlationKey,
      "live",
      activeProposal.id
    );
    expect(revalidationContext.totalOpenExposureMicros).toBe(5_500_000n);
    expect(revalidationContext.marketExposureMicros).toBe(1_500_000n);
    expect(revalidationContext.correlatedExposureMicros).toBe(1_500_000n);
    expect(revalidationContext.liveTradeCount).toBe(0);
    database.close();
  });

  it("anchors daily PnL once, triggers the exact loss stop, and keeps cooldown across midnight", async () => {
    let nowMs = Date.parse("2026-07-23T10:00:00.000Z");
    const database = new TradingDatabase(":memory:");
    database.setAccountBinding({
      profileAddress: PROFILE_ADDRESS,
      funderAddress: PROFILE_ADDRESS,
      signerAddress: `0x${"b".repeat(40)}`,
      signatureType: 1,
      verifiedAtMs: nowMs
    });
    const portfolio: PortfolioSnapshot = {
      profileAddress: PROFILE_ADDRESS,
      pUsdBalanceMicros: null,
      totalPositionValueMicros: 0n,
      totalPnlMicros: 20n * PUSD_SCALE,
      positions: [],
      capturedAtMs: nowMs,
      source: "public"
    };
    const contexts = new DatabaseRiskContext({
      database,
      marketData: marketDataFor(() => ({
        ...portfolio,
        capturedAtMs: nowMs
      })),
      profileAddress: PROFILE_ADDRESS,
      now: () => nowMs,
      timeZone: "Europe/Madrid"
    });

    const initial = await contexts.summary();
    expect(initial.dailyPnlMicros).toBe(0n);
    expect(initial.dailyPnlKnown).toBe(false);

    const dayKey = zonedDayKey(nowMs, "Europe/Madrid");
    database.armDailyRiskSession(
      dayKey,
      portfolio.totalPnlMicros,
      nowMs
    );
    const armed = await contexts.summary();
    expect(armed.dailyPnlMicros).toBe(0n);
    expect(armed.dailyPnlKnown).toBe(true);
    database.armDailyRiskSession(
      dayKey,
      999n * PUSD_SCALE,
      nowMs + 1
    );
    expect((await contexts.summary()).dailyPnlMicros).toBe(0n);
    expect(database.countAuditEvents("DAILY_RISK_SESSION_ARMED")).toBe(1);
    expect(database.countAuditEvents("DAILY_RISK_SESSION_REUSED")).toBe(1);

    nowMs += 60 * 60_000;
    portfolio.totalPnlMicros = 11_000_001n;
    const beforeStop = await contexts.summary();
    expect(beforeStop.dailyPnlMicros).toBe(-8_999_999n);
    expect(beforeStop.coolingDownUntilMs).toBeNull();

    nowMs += 60 * 60_000;
    portfolio.totalPnlMicros = 10n * PUSD_SCALE;
    const breachAtMs = nowMs;
    const atStop = await contexts.summary();
    expect(atStop.dailyPnlMicros).toBe(-10n * PUSD_SCALE);
    expect(atStop.coolingDownUntilMs).toBe(
      breachAtMs + 24 * 60 * 60_000
    );
    expect(database.getCooldown()).toMatchObject({
      untilMs: breachAtMs + 24 * 60 * 60_000,
      reason: "DAILY_STOP",
      updatedAtMs: breachAtMs
    });

    nowMs += 60 * 60_000;
    portfolio.totalPnlMicros = 9n * PUSD_SCALE;
    expect((await contexts.summary()).coolingDownUntilMs).toBe(
      breachAtMs + 24 * 60 * 60_000
    );
    expect(database.countAuditEvents("COOLDOWN_SET")).toBe(1);

    nowMs = Date.parse("2026-07-23T22:30:00.000Z");
    portfolio.totalPnlMicros = -50n * PUSD_SCALE;
    const afterLocalMidnight = await contexts.summary();
    expect(afterLocalMidnight.dailyPnlMicros).toBe(0n);
    expect(afterLocalMidnight.dailyPnlKnown).toBe(false);
    expect(afterLocalMidnight.coolingDownUntilMs).toBe(
      breachAtMs + 24 * 60 * 60_000
    );
    database.armDailyRiskSession(
      zonedDayKey(nowMs, "Europe/Madrid"),
      portfolio.totalPnlMicros,
      nowMs
    );
    const rearmed = await contexts.summary();
    expect(rearmed.dailyPnlKnown).toBe(true);
    expect(rearmed.dailyPnlMicros).toBe(0n);
    expect(database.countAuditEvents("DAILY_RISK_SESSION_ARMED")).toBe(2);
    database.close();
  });

  it("derives the Europe/Madrid risk day at the local midnight boundary", () => {
    expect(
      zonedDayKey(
        Date.parse("2026-07-23T21:59:59.999Z"),
        "Europe/Madrid"
      )
    ).toBe("2026-07-23");
    expect(
      zonedDayKey(
        Date.parse("2026-07-23T22:00:00.000Z"),
        "Europe/Madrid"
      )
    ).toBe("2026-07-24");
  });

  it("uses verified paper BUY fills for a SELL even when the real wallet is empty", async () => {
    let nowMs = Date.now();
    let portfolioReads = 0;
    const database = new TradingDatabase(":memory:");
    const emptyPortfolio: PortfolioSnapshot = {
      profileAddress: PROFILE_ADDRESS,
      pUsdBalanceMicros: null,
      totalPositionValueMicros: 0n,
      totalPnlMicros: 0n,
      positions: [],
      capturedAtMs: nowMs,
      source: "public"
    };
    const contexts = new DatabaseRiskContext({
      database,
      marketData: marketDataFor(() => {
        portfolioReads += 1;
        return emptyPortfolio;
      }),
      profileAddress: PROFILE_ADDRESS,
      now: () => nowMs
    });

    const buyIntent = intentFixture(nowMs);
    buyIntent.sharesMicros = 5n * PUSD_SCALE;
    buyIntent.correlationKey = "paper-shared-event";
    const buyProposal = createOrderProposal(
      buyIntent,
      riskContextFixture(nowMs)
    );
    recordPaperProposal(database, buyProposal, nowMs);

    const sellContext = await contexts.forOrder(
      buyProposal.market,
      "SELL",
      buyProposal.correlationKey,
      "paper"
    );
    expect(sellContext).toMatchObject({
      heldSharesMicros: 5n * PUSD_SCALE,
      totalOpenExposureMicros: 2n * PUSD_SCALE,
      marketExposureMicros: 2n * PUSD_SCALE,
      openMarketCount: 1
    });

    nowMs += 100;
    const sellIntent = intentFixture(nowMs);
    sellIntent.intent = "EXIT";
    sellIntent.side = "SELL";
    sellIntent.exitReason = "EDGE_DISAPPEARED";
    sellIntent.sharesMicros = 3n * PUSD_SCALE;
    sellIntent.limitPriceMicros = 390_000n;
    sellIntent.estimatedProbabilityMicros = 300_000n;
    sellIntent.correlationKey = buyProposal.correlationKey;
    const sellProposal = createOrderProposal(sellIntent, {
      ...sellContext,
      nowMs
    });
    recordPaperProposal(database, sellProposal, nowMs);

    const afterSell = await contexts.forOrder(
      buyProposal.market,
      "SELL",
      buyProposal.correlationKey,
      "paper"
    );
    expect(afterSell).toMatchObject({
      heldSharesMicros: 2n * PUSD_SCALE,
      totalOpenExposureMicros: 800_000n,
      marketExposureMicros: 800_000n,
      correlatedExposureMicros: 800_000n,
      openMarketCount: 1
    });
    expect(portfolioReads).toBe(0);
    database.close();
  });

  it("reserves an open paper SELL and rejects another SELL above the remainder", async () => {
    const nowMs = Date.now();
    let portfolioReads = 0;
    const database = new TradingDatabase(":memory:");
    const contexts = new DatabaseRiskContext({
      database,
      marketData: marketDataFor(() => {
        portfolioReads += 1;
        throw new Error("paper mode must not read the wallet");
      }),
      profileAddress: PROFILE_ADDRESS,
      now: () => nowMs
    });
    const buyIntent = intentFixture(nowMs);
    buyIntent.sharesMicros = 5n * PUSD_SCALE;
    const buyProposal = createOrderProposal(
      buyIntent,
      riskContextFixture(nowMs)
    );
    recordPaperProposal(database, buyProposal, nowMs);

    const initialSellContext = await contexts.forOrder(
      buyProposal.market,
      "SELL",
      buyProposal.correlationKey,
      "paper"
    );
    const restingSellIntent = intentFixture(nowMs);
    restingSellIntent.intent = "EXIT";
    restingSellIntent.side = "SELL";
    restingSellIntent.exitReason = "EDGE_DISAPPEARED";
    restingSellIntent.sharesMicros = 4n * PUSD_SCALE;
    restingSellIntent.limitPriceMicros = 410_000n;
    restingSellIntent.estimatedProbabilityMicros = 300_000n;
    const restingSell = createOrderProposal(
      restingSellIntent,
      initialSellContext
    );
    expect(
      recordPaperProposal(database, restingSell, nowMs).status
    ).toBe("OPEN");

    const remaining = await contexts.forOrder(
      buyProposal.market,
      "SELL",
      buyProposal.correlationKey,
      "paper"
    );
    expect(remaining.heldSharesMicros).toBe(1n * PUSD_SCALE);

    const excessiveSell = intentFixture(nowMs);
    excessiveSell.intent = "EXIT";
    excessiveSell.side = "SELL";
    excessiveSell.exitReason = "EDGE_DISAPPEARED";
    excessiveSell.sharesMicros = 2n * PUSD_SCALE;
    excessiveSell.limitPriceMicros = 390_000n;
    excessiveSell.estimatedProbabilityMicros = 300_000n;
    expect(() => createOrderProposal(excessiveSell, remaining)).toThrowError(
      ProposalRejectedError
    );
    try {
      createOrderProposal(excessiveSell, remaining);
    } catch (error) {
      expect(error).toBeInstanceOf(ProposalRejectedError);
      expect(
        error instanceof ProposalRejectedError
          ? error.violations.map((violation) => violation.code)
          : []
      ).toContain("SELL_EXCEEDS_POSITION");
    }
    expect(portfolioReads).toBe(0);
    database.close();
  });

  it("counts filled and pending paper BUY exposure across markets and correlation", async () => {
    const nowMs = Date.now();
    let portfolioReads = 0;
    const database = new TradingDatabase(":memory:");
    const contexts = new DatabaseRiskContext({
      database,
      marketData: marketDataFor(() => {
        portfolioReads += 1;
        throw new Error("paper mode must not read the wallet");
      }),
      profileAddress: PROFILE_ADDRESS,
      now: () => nowMs
    });

    const filledIntent = intentFixture(nowMs);
    filledIntent.sharesMicros = 5n * PUSD_SCALE;
    filledIntent.correlationKey = "cross-market-paper-event";
    const filled = createOrderProposal(
      filledIntent,
      riskContextFixture(nowMs)
    );
    recordPaperProposal(database, filled, nowMs);

    const pendingIntent = intentFixture(nowMs);
    pendingIntent.market = {
      ...pendingIntent.market,
      conditionId: `0x${"4".repeat(64)}`,
      tokenId: "444",
      eventId: "44"
    };
    pendingIntent.sharesMicros = 5n * PUSD_SCALE;
    pendingIntent.limitPriceMicros = 390_000n;
    pendingIntent.estimatedProbabilityMicros = 500_000n;
    pendingIntent.correlationKey = filled.correlationKey;
    const pending = createOrderProposal(
      pendingIntent,
      riskContextFixture(nowMs)
    );
    expect(recordPaperProposal(database, pending, nowMs).status).toBe(
      "OPEN"
    );

    const context = await contexts.forOrder(
      filled.market,
      "BUY",
      filled.correlationKey,
      "paper"
    );
    expect(context).toMatchObject({
      totalOpenExposureMicros: 3_950_000n,
      marketExposureMicros: 2n * PUSD_SCALE,
      correlatedExposureMicros: 3_950_000n,
      openMarketCount: 2,
      heldSharesMicros: 5n * PUSD_SCALE
    });
    expect(portfolioReads).toBe(0);
    database.close();
  });
});
