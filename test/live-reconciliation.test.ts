import { describe, expect, it, vi } from "vitest";
import { createOrderProposal } from "../src/domain/proposals.js";
import { createTradingSession } from "../src/domain/session.js";
import {
  formatMicros,
  type OrderProposal,
  type PortfolioSnapshot,
  type UserTradeActivity
} from "../src/domain/types.js";
import { TradingService } from "../src/application/trading-service.js";
import type {
  LiveTradingPort,
  MarketDataPort,
  OnchainSettlementPort
} from "../src/application/ports.js";
import { stringifyWithBigInts } from "../src/storage/codec.js";
import { TradingDatabase } from "../src/storage/database.js";
import { intentFixture, riskContextFixture } from "./fixtures.js";

const NOW_MS = Date.parse("2026-07-23T12:00:00.000Z");
const PROFILE = `0x${"a".repeat(40)}`;
const SIGNER = `0x${"b".repeat(40)}`;
const ORDER_ID = `0x${"c".repeat(64)}`;
const TX_HASH = `0x${"d".repeat(64)}`;
const BLOCK_HASH = `0x${"e".repeat(64)}`;
const TRADE_ID = "fixture-live-trade";

describe("live reconciliation convergence", () => {
  it("attributes a fresh Data API fill in the same cycle and confirms only after every source converges", async () => {
    const harness = liveHarness(true);

    await expect(harness.service.monitorLiveSafety()).resolves.toBe(true);

    const execution = harness.database.getExecution(harness.proposal.id);
    expect(execution?.status).toBe("CONFIRMED");
    expect(harness.onchain.verifySettlement).toHaveBeenCalledOnce();
    expect(harness.database.countCanaryEligibleExecutions()).toBe(1);
    await expect(harness.service.monitorLiveSafety()).resolves.toBe(false);
    harness.database.close();
  });

  it("refuses to confirm a fill that lacks authenticated User WebSocket evidence", async () => {
    const harness = liveHarness(false, NOW_MS + 20_000);

    await expect(harness.service.monitorLiveSafety()).rejects.toThrow(
      "USER_CHANNEL_EVIDENCE_MISSING"
    );
    expect(harness.onchain.verifySettlement).not.toHaveBeenCalled();
    expect(
      harness.database.getExecution(harness.proposal.id)?.status
    ).toBe("SUBMITTED_UNRECONCILED");
    harness.database.close();
  });
});

function liveHarness(includeUserChannel: boolean, nowMs = NOW_MS): {
  service: TradingService;
  database: TradingDatabase;
  proposal: OrderProposal;
  onchain: OnchainSettlementPort & {
    verifySettlement: ReturnType<typeof vi.fn>;
  };
} {
  const database = new TradingDatabase(":memory:");
  database.setAccountBinding({
    profileAddress: PROFILE,
    funderAddress: PROFILE,
    signerAddress: SIGNER,
    signatureType: 1,
    verifiedAtMs: NOW_MS - 1_000
  });
  database.setLiveActivation(true, NOW_MS - 500);

  const intent = intentFixture(NOW_MS);
  intent.executionMode = "live";
  const session = createTradingSession({
    executionMode: "live",
    authorizedBudgetMicros: 10n * 1_000_000n,
    nowMs: NOW_MS
  });
  database.saveTradingSession(session);
  intent.sessionId = session.id;
  const proposal = createOrderProposal(intent, riskContextFixture(NOW_MS));
  const expiration =
    Math.floor(proposal.createdAtMs / 1_000) + 60 + 15 * 60;
  database.stageProposal(proposal);
  database.transitionProposal(
    proposal.id,
    "STAGED",
    "AWAITING_LOCAL",
    NOW_MS + 1
  );
  database.transitionProposal(
    proposal.id,
    "AWAITING_LOCAL",
    "LOCALLY_APPROVED",
    NOW_MS + 2
  );
  database.recordLocalApproval({
    proposalId: proposal.id,
    proposalHash: proposal.hash,
    approvedAtMs: NOW_MS + 2,
    expiresAtMs: proposal.expiresAtMs,
    nonceHash: "fixture-nonce-hash",
    consumedAtMs: null
  });
  expect(database.claimExecution(proposal.id, proposal.hash, NOW_MS + 3)).toBe(
    true
  );
  database.markExecutionSubmitted({
    proposalId: proposal.id,
    proposalHash: proposal.hash,
    clobOrderId: ORDER_ID,
    status: "SUBMITTED_UNRECONCILED",
    submittedAtMs: NOW_MS + 4,
    responseJson: stringifyWithBigInts({
      success: true,
      orderID: ORDER_ID,
      status: "matched",
      tradeIDs: [TRADE_ID],
      localOrder: {
        orderHash: ORDER_ID,
        metadata: `0x${proposal.hash}`,
        builder: `0x${"00".repeat(32)}`,
        expiration,
        timestampMs: NOW_MS,
        makerAmountMicros: proposal.maxCostMicros,
        takerAmountMicros: proposal.sharesMicros
      }
    })
  });

  if (includeUserChannel) {
    database.appendAudit("USER_CHANNEL_TRADE", ORDER_ID, {
      proposalId: proposal.id,
      proposalHash: proposal.hash,
      role: "TAKER",
      event: {
        kind: "trade",
        tradeId: TRADE_ID,
        conditionId: proposal.market.conditionId,
        tokenId: proposal.market.tokenId,
        side: proposal.side,
        sizeMicros: proposal.sharesMicros,
        priceMicros: proposal.limitPriceMicros,
        status: "CONFIRMED",
        takerOrderId: ORDER_ID,
        makerOrders: [],
        matchTimeMs: NOW_MS,
        timestampMs: NOW_MS,
        lastUpdateMs: NOW_MS
      }
    });
  }

  const remoteOrder = {
    id: ORDER_ID,
    status: "MATCHED",
    originalSize: proposal.sharesMicros.toString(),
    sizeMatched: proposal.sharesMicros.toString(),
    market: proposal.market.conditionId,
    assetId: proposal.market.tokenId,
    makerAddress: PROFILE,
    side: proposal.side,
    orderType: "GTD",
    price: formatMicros(proposal.limitPriceMicros),
    expiration: String(expiration),
    associateTrades: [TRADE_ID]
  };
  const remoteTrade = {
    id: TRADE_ID,
    status: "CONFIRMED",
    traderSide: "TAKER",
    transactionHash: TX_HASH,
    matchTime: String(Math.floor(NOW_MS / 1_000)),
    lastUpdate: String(Math.floor(NOW_MS / 1_000)),
    market: proposal.market.conditionId,
    takerOrderId: ORDER_ID,
    assetId: proposal.market.tokenId,
    side: proposal.side,
    makerAddress: PROFILE,
    feeRateBps: String(proposal.market.feeRateBps),
    size: proposal.sharesMicros.toString(),
    price: formatMicros(proposal.limitPriceMicros)
  };
  const activity: UserTradeActivity = {
    profileAddress: PROFILE,
    transactionHash: TX_HASH,
    conditionId: proposal.market.conditionId,
    tokenId: proposal.market.tokenId,
    side: proposal.side,
    timestampMs: NOW_MS,
    sizeMicros: proposal.sharesMicros,
    priceMicros: proposal.limitPriceMicros,
    notionalMicros: proposal.maxCostMicros
  };
  const portfolio: PortfolioSnapshot = {
    profileAddress: PROFILE,
    pUsdBalanceMicros: null,
    totalPositionValueMicros: proposal.maxCostMicros,
    totalPnlMicros: 0n,
    positions: [
      {
        tokenId: proposal.market.tokenId,
        conditionId: proposal.market.conditionId,
        question: proposal.market.question,
        outcome: proposal.market.outcome,
        sizeMicros: proposal.sharesMicros,
        averagePriceMicros: proposal.limitPriceMicros,
        currentPriceMicros: proposal.limitPriceMicros,
        currentValueMicros: proposal.maxCostMicros,
        cashPnlMicros: 0n,
        realizedPnlMicros: 0n,
        endTimeMs: proposal.market.endTimeMs
      }
    ],
    capturedAtMs: nowMs,
    source: "public"
  };
  const marketData: MarketDataPort = {
    async profileExists() {
      return true;
    },
    async getPortfolio() {
      return portfolio;
    },
    async getUserActivity() {
      return [activity];
    },
    async scanCandidates() {
      return [];
    },
    async getMarketSnapshot() {
      return { ...proposal.market, capturedAtMs: nowMs };
    },
    async checkGeoblock() {
      return {
        blocked: false,
        country: "ES",
        region: "MD",
        checkedAtMs: nowMs
      };
    }
  };
  const liveTrading: LiveTradingPort = {
    async configured() {
      return true;
    },
    async submitGtd() {
      throw new Error("not used");
    },
    async cancelOrder() {
      return {};
    },
    async cancelAll() {
      return {};
    },
    async getOrderStatus() {
      return remoteOrder;
    },
    async getOpenOrders() {
      return [];
    },
    async getTrades() {
      return [remoteTrade];
    },
    async startHeartbeat() {},
    async stopHeartbeat() {}
  };
  const verifySettlement = vi.fn(async () => ({
    finalized: true,
    filledSharesMicros: proposal.sharesMicros,
    grossCostMicros: proposal.maxCostMicros,
    feeMicros: 0n,
    transactionHashes: [TX_HASH],
    blockNumbers: [100n],
    blockHashes: [BLOCK_HASH],
    blockTimestampsMs: [NOW_MS]
  }));
  const onchain = {
    verifySettlement
  } as OnchainSettlementPort & {
    verifySettlement: ReturnType<typeof vi.fn>;
  };
  const service = new TradingService({
    profileAddress: PROFILE,
    liveEnvironmentEnabled: true,
    database,
    marketData,
    accountBinding: {
      async signerConfigured() {
        return true;
      },
      async signerAddress() {
        return SIGNER;
      },
      async signatureType() {
        return 1;
      },
      async funderAddress() {
        return PROFILE;
      }
    },
    riskContexts: {
      async forOrder() {
        return riskContextFixture(nowMs);
      },
      async summary() {
        return {
          dailyPnlMicros: 0n,
          dailyPnlKnown: true,
          totalOpenExposureMicros: proposal.maxCostMicros,
          openMarketCount: 1,
          liveTradeCount: 0,
          emergencyStopped: false,
          coolingDownUntilMs: null
        };
      }
    },
    paperGate: {
      async metrics() {
        return {
          firstTradeAtMs: NOW_MS - 31 * 24 * 60 * 60_000,
          totalTrades: 50,
          closedTrades: 50,
          netPnlMicros: 1n,
          maxDrawdownMicros: 0n,
          riskViolations: 0,
          reconciliationErrors: 0
        };
      },
      async result() {
        return { passed: true, reasons: [] };
      }
    },
    liveTrading,
    onchainSettlement: onchain,
    approvals: {
      approvalUrl() {
        return "http://127.0.0.1:8787/";
      }
    },
    now: () => nowMs
  });
  return { service, database, proposal, onchain };
}
