import { describe, expect, it } from "vitest";
import { computeLegacyImport } from "../src/domain/legacy-import.js";
import type {
  PortfolioPosition,
  UserTradeActivity
} from "../src/domain/types.js";
import { TradingDatabase } from "../src/storage/database.js";
import { TradingService } from "../src/application/trading-service.js";

const PROFILE = `0x${"a".repeat(40)}`;
const CONDITION = `0x${"b".repeat(64)}`;
const TOKEN = "legacy-token-1";
const TX = `0x${"c".repeat(64)}`;
const NOW_MS = 1_759_000_000_000;

const position: PortfolioPosition = {
  tokenId: TOKEN,
  conditionId: CONDITION,
  question: "Will the event happen?",
  outcome: "Yes",
  sizeMicros: 2_000_000n,
  averagePriceMicros: 400_000n,
  currentPriceMicros: 350_000n,
  currentValueMicros: 700_000n,
  cashPnlMicros: -100_000n,
  realizedPnlMicros: 0n,
  endTimeMs: NOW_MS + 10 * 86_400_000
};

const activity: UserTradeActivity[] = [
  {
    profileAddress: PROFILE,
    transactionHash: TX,
    conditionId: CONDITION,
    tokenId: TOKEN,
    side: "BUY",
    timestampMs: NOW_MS - 86_400_000,
    sizeMicros: 2_000_000n,
    priceMicros: 400_000n,
    notionalMicros: 800_000n
  }
];

describe("legacy position import", () => {
  it("marks a consistent public history as price-only when local fills or fees are absent", () => {
    const result = computeLegacyImport({
      position,
      activity,
      activityAvailable: true,
      local: {
        orderCount: 0,
        reconciledOrderCount: 0,
        fills: [],
        feesMicros: null,
        transactionHashes: []
      },
      remoteOpenOrderCount: 0,
      ordersChecked: false
    });

    expect(result.quality).toBe("PARTIALLY_VERIFIED");
    expect(result.automaticExitPolicy).toBe("PRICE_ONLY");
    expect(result.openedAtMs).toBe(NOW_MS - 86_400_000);
    expect(result.feesMicros).toBeNull();
  });

  it("requires reconciled local fills, fees, and order checks for full verification", () => {
    const result = computeLegacyImport({
      position,
      activity,
      activityAvailable: true,
      local: {
        orderCount: 1,
        reconciledOrderCount: 1,
        fills: [
          {
            side: "BUY",
            sharesMicros: 2_000_000n,
            priceMicros: 400_000n,
            timestampMs: NOW_MS - 86_400_000,
            transactionHash: TX
          }
        ],
        feesMicros: 800n,
        transactionHashes: [TX]
      },
      remoteOpenOrderCount: 0,
      ordersChecked: true
    });

    expect(result.quality).toBe("VERIFIED");
    expect(result.automaticExitPolicy).toBe("FULL");
    expect(result.transactionHashes).toEqual([TX]);
  });

  it("blocks an inconsistent or unavailable history without inventing an entry date", () => {
    const result = computeLegacyImport({
      position,
      activity: [],
      activityAvailable: false,
      local: {
        orderCount: 0,
        reconciledOrderCount: 0,
        fills: [],
        feesMicros: null,
        transactionHashes: []
      },
      remoteOpenOrderCount: 0,
      ordersChecked: false
    });

    expect(result.quality).toBe("LEGACY_UNVERIFIED");
    expect(result.automaticExitPolicy).toBe("BLOCKED");
    expect(result.openedAtMs).toBeNull();
  });

  it("persists the report and does not import the same position twice", async () => {
    const database = new TradingDatabase(":memory:");
    const service = new TradingService({
      profileAddress: PROFILE,
      liveEnvironmentEnabled: false,
      database,
      marketData: {
        profileExists: async () => true,
        getPortfolio: async () => ({
          profileAddress: PROFILE,
          pUsdBalanceMicros: null,
          totalPositionValueMicros: position.currentValueMicros,
          totalPnlMicros: position.cashPnlMicros,
          positions: [position],
          capturedAtMs: NOW_MS,
          source: "public" as const
        }),
        getUserActivity: async () => activity,
        scanCandidates: async () => [],
        getMarketSnapshot: async () => {
          throw new Error("not used");
        },
        checkGeoblock: async () => ({
          blocked: false,
          country: "ES",
          region: "ES-M",
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
        forOrder: async () => {
          throw new Error("not used");
        },
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
          totalTrades: 0,
          closedTrades: 0,
          netPnlMicros: 0n,
          maxDrawdownMicros: 0n,
          riskViolations: 0,
          reconciliationErrors: 0
        }),
        result: async () => ({ passed: false, reasons: [] })
      },
      liveTrading: null,
      onchainSettlement: {
        verifySettlement: async () => {
          throw new Error("not used");
        }
      },
      now: () => NOW_MS
    });

    database.savePositionRecord(
      {
        tokenId: TOKEN,
        conditionId: CONDITION,
        question: position.question,
        outcome: position.outcome,
        side: "BUY",
        sharesMicros: position.sizeMicros,
        averagePriceMicros: position.averagePriceMicros,
        evidenceQuality: "LEGACY_UNVERIFIED",
        entryFeesMicros: null,
        entryTransactionHashesJson: "[]",
        entryProbabilityMicros: null,
        entryEdgeMicros: null,
        openedAtMs: null,
        lastEvaluatedAtMs: NOW_MS,
        lastMarketPriceMicros: position.currentPriceMicros,
        lastEstimatedProbabilityMicros: null,
        lastResearchBundleId: null,
        sourcesJson: "[]",
        researchRequiredSinceMs: null,
        researchRequiredAtPriceMicros: null,
        minimumResearchCreatedAtMs: null,
        exitState: "LEGACY_UNVERIFIED",
        activeExitProposalId: null,
        activeExitOrderId: null
      },
      NOW_MS
    );
    const first = await service.importLegacyPosition(TOKEN);
    const second = await service.importLegacyPosition(TOKEN);
    expect(first.imported).toBe(true);
    expect(second.imported).toBe(false);
    expect(database.getLatestLegacyImportReport(TOKEN)?.id).toBe(first.report.id);
    expect(database.getPositionRecord(TOKEN)?.evidenceQuality).toBe(
      "PARTIALLY_VERIFIED"
    );
    database.close();
  });
});
