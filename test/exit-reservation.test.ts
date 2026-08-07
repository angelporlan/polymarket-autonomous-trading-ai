import { describe, expect, it, vi } from "vitest";
import { TradingService } from "../src/application/trading-service.js";
import { createOrderProposal } from "../src/domain/proposals.js";
import { PUSD_SCALE, type PortfolioSnapshot } from "../src/domain/types.js";
import { TradingDatabase } from "../src/storage/database.js";
import { intentFixture, marketFixture, riskContextFixture } from "./fixtures.js";

const NOW_MS = Date.parse("2026-07-23T12:00:00.000Z");

function exitProposal(nowMs = NOW_MS, sharesMicros = 10n * PUSD_SCALE) {
  const intent = intentFixture(nowMs);
  intent.executionMode = "live";
  intent.intent = "EXIT";
  intent.sessionId = null;
  intent.side = "SELL";
  intent.exitReason = "STOP_LOSS_TRIGGERED";
  intent.sharesMicros = sharesMicros;
  intent.limitPriceMicros = 300_000n;
  intent.estimatedProbabilityMicros = 300_000n;
  return createOrderProposal(intent, {
    ...riskContextFixture(nowMs),
    heldSharesMicros: 10n * PUSD_SCALE
  });
}

describe("live EXIT reservations", () => {
  it("reserves settled shares atomically and blocks a competing full exit", () => {
    const database = new TradingDatabase(":memory:");
    const first = exitProposal();
    const second = exitProposal();

    database.stageProposal(first, 10n * PUSD_SCALE);
    expect(database.getReservedExitShares(first.market.tokenId, NOW_MS)).toBe(
      10n * PUSD_SCALE
    );
    expect(() => database.stageProposal(second, 10n * PUSD_SCALE)).toThrow(
      "EXIT_SHARES_ALREADY_RESERVED"
    );
    expect(database.getProposal(second.id)).toBeNull();
    expect(database.getReservedExitShares(first.market.tokenId, NOW_MS)).toBe(
      10n * PUSD_SCALE
    );
    database.close();
  });

  it("reduces the reservation after a partial fill and releases it at terminal reconciliation", () => {
    const database = new TradingDatabase(":memory:");
    const proposal = exitProposal();
    database.stageProposal(proposal, 10n * PUSD_SCALE);
    expect(
      database.claimAutonomousExecution(proposal.id, proposal.hash, null, NOW_MS + 1)
    ).toBe(true);
    database.markExecutionSubmitted({
      proposalId: proposal.id,
      proposalHash: proposal.hash,
      clobOrderId: `0x${"a".repeat(64)}`,
      status: "SUBMITTED_UNRECONCILED",
      submittedAtMs: NOW_MS + 2,
      responseJson: "{}"
    });

    expect(
      database.updateExecutionStatus(
        proposal.id,
        "PARTIALLY_FILLED",
        JSON.stringify({ order: { sizeMatched: "4000000" } }),
        NOW_MS + 3
      )
    ).toBe(true);
    expect(database.getReservedExitShares(proposal.market.tokenId, NOW_MS + 3)).toBe(
      6n * PUSD_SCALE
    );

    expect(
      database.updateExecutionStatus(
        proposal.id,
        "CANCELLED",
        JSON.stringify({ order: { sizeMatched: "4000000" } }),
        NOW_MS + 4
      )
    ).toBe(true);
    expect(database.getReservedExitShares(proposal.market.tokenId, NOW_MS + 4)).toBe(
      0n
    );
    database.close();
  });

  it("does not mark a position CLOSING when the exit execution is rejected", async () => {
    const database = new TradingDatabase(":memory:");
    const market = marketFixture(NOW_MS);
    const portfolio: PortfolioSnapshot = {
      profileAddress: `0x${"a".repeat(40)}`,
      pUsdBalanceMicros: 20n * PUSD_SCALE,
      totalPositionValueMicros: PUSD_SCALE,
      totalPnlMicros: 0n,
      positions: [
        {
          tokenId: market.tokenId,
          conditionId: market.conditionId,
          question: market.question,
          outcome: market.outcome,
          sizeMicros: 2n * PUSD_SCALE,
          averagePriceMicros: 500_000n,
          currentPriceMicros: 300_000n,
          currentValueMicros: 600_000n,
          cashPnlMicros: -400_000n,
          realizedPnlMicros: 0n,
          endTimeMs: market.endTimeMs
        }
      ],
      capturedAtMs: NOW_MS,
      source: "public"
    };
    database.savePositionRecord({
      tokenId: market.tokenId,
      conditionId: market.conditionId,
      question: market.question,
      outcome: market.outcome,
      side: "BUY",
      sharesMicros: 2n * PUSD_SCALE,
      averagePriceMicros: 500_000n,
      entryProbabilityMicros: 550_000n,
      entryEdgeMicros: 50_000n,
      openedAtMs: NOW_MS - 2 * 24 * 60 * 60_000,
      lastEvaluatedAtMs: NOW_MS - 1_000,
      lastMarketPriceMicros: 500_000n,
      lastEstimatedProbabilityMicros: null,
      lastResearchBundleId: null,
      sourcesJson: "[]",
      exitState: "HOLDING",
      activeExitProposalId: null,
      activeExitOrderId: null
    }, NOW_MS);

    const service = new TradingService({
      profileAddress: portfolio.profileAddress,
      liveEnvironmentEnabled: true,
      database,
      marketData: {
        profileExists: async () => true,
        getPortfolio: async () => portfolio,
        getUserActivity: async () => [],
        scanCandidates: async () => [],
        getMarketSnapshot: async () => market,
        checkGeoblock: async () => ({
          blocked: false,
          country: "ES",
          region: "MD",
          checkedAtMs: NOW_MS
        })
      },
      accountBinding: {
        signerConfigured: async () => false,
        signerAddress: async () => null,
        signatureType: async () => null,
        funderAddress: async () => null
      },
      riskContexts: {
        forOrder: async () => riskContextFixture(NOW_MS),
        summary: async () => ({
          dailyPnlMicros: 0n,
          dailyPnlKnown: true,
          totalOpenExposureMicros: 0n,
          openMarketCount: 0,
          liveTradeCount: 0,
          emergencyStopped: false,
          coolingDownUntilMs: null
        })
      },
      paperGate: {
        metrics: async () => ({
          firstTradeAtMs: null,
          daysObserved: 0,
          totalTrades: 0,
          closedTrades: 0,
          netPnlMicros: 0n,
          maxDrawdownMicros: 0n,
          riskViolations: 0,
          reconciliationErrors: 0
        }),
        result: async () => ({
          passed: false,
          skipped: false,
          reasons: []
        })
      },
      liveTrading: null,
      onchainSettlement: {
        verifySettlement: async () => ({
          finalized: false,
          filledSharesMicros: 0n,
          grossCostMicros: 0n,
          feeMicros: 0n,
          transactionHashes: [],
          blockNumbers: [],
          blockHashes: [],
          blockTimestampsMs: []
        })
      },
      approvals: { approvalUrl: (proposalId: string) => `/approve/${proposalId}` },
      now: () => NOW_MS
    });
    const exitIntent = intentFixture(NOW_MS);
    exitIntent.executionMode = "live";
    exitIntent.intent = "EXIT";
    exitIntent.side = "SELL";
    exitIntent.sessionId = null;
    exitIntent.exitReason = "STOP_LOSS_TRIGGERED";
    exitIntent.sharesMicros = PUSD_SCALE;
    exitIntent.limitPriceMicros = 390_000n;
    const exitProposal = createOrderProposal(exitIntent, {
      ...riskContextFixture(NOW_MS),
      heldSharesMicros: 2n * PUSD_SCALE
    });
    vi.spyOn(service, "stageOrder").mockResolvedValue({
      proposal: exitProposal,
      paperTrade: null
    });
    vi.spyOn(service, "executeStagedProposal").mockResolvedValue({
      accepted: false,
      message: "blocked"
    });

    await service.supervisePositions();
    expect(database.getPositionRecord(market.tokenId)?.exitState).not.toBe(
      "CLOSING"
    );
    database.close();
  });
});
