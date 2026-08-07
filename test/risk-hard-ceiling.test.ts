import { describe, expect, it } from "vitest";
import {
  DEFAULT_RISK_POLICY,
  RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD,
  RISK_HARD_DAILY_STOP_PUSD,
  validatePolicyAdjustments,
  evaluateOrderRisk
} from "../src/domain/risk-policy.js";
import { PUSD_SCALE, type OrderIntent, type RiskContext } from "../src/domain/types.js";

describe("Risk Hard Ceilings Guardrails", () => {
  it("exports immutable hard ceiling constants", () => {
    expect(RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD).toBe(100n * PUSD_SCALE);
    expect(RISK_HARD_DAILY_STOP_PUSD).toBe(10n * PUSD_SCALE);
  });

  it("validates that DEFAULT_RISK_POLICY respects hard ceilings", () => {
    expect(() => validatePolicyAdjustments(DEFAULT_RISK_POLICY)).not.toThrow();
  });

  it("rejects policy adjustments attempting to exceed total open exposure ceiling", () => {
    const invalidPolicy = {
      ...DEFAULT_RISK_POLICY,
      pilotMaxOpenExposureMicros: 150n * PUSD_SCALE // Exceeds 100 pUSD
    };

    expect(() => validatePolicyAdjustments(invalidPolicy)).toThrow("exceeds hard ceiling");
  });

  it("rejects policy adjustments attempting to exceed daily stop ceiling", () => {
    const invalidPolicy = {
      ...DEFAULT_RISK_POLICY,
      dailyStopMicros: 25n * PUSD_SCALE // Exceeds 10 pUSD
    };

    expect(() => validatePolicyAdjustments(invalidPolicy)).toThrow("exceeds hard daily stop");
  });

  it("evaluateOrderRisk returns HARD_CEILING_EXCEEDED if post-trade total exposure breaches hard limit", () => {
    const mockIntent: OrderIntent = {
      executionMode: "live",
      side: "BUY",
      sharesMicros: 200n * PUSD_SCALE,
      limitPriceMicros: 600_000n, // Cost 120 pUSD
      estimatedProbabilityMicros: 700_000n,
      thesis: "This is a valid long thesis with more than 20 characters.",
      counterThesis: "This is a valid counter thesis with more than 20 characters.",
      sources: [
        {
          url: "https://www.reuters.com/news",
          title: "Primary source for news",
          publishedAt: new Date().toISOString(),
          retrievedAt: new Date().toISOString(),
          primary: true
        },
        {
          url: "https://www.bbc.com/news",
          title: "Secondary source for news",
          publishedAt: new Date().toISOString(),
          retrievedAt: new Date().toISOString(),
          primary: false
        }
      ],
      correlationKey: "event:test",
      market: {
        conditionId: "0x123",
        tokenId: "token_1",
        eventId: "event_1",
        question: "Test question?",
        slug: "test-slug",
        outcome: "Yes",
        category: "politics",
        rules: "Standard rules statement longer than 20 chars",
        resolutionSource: "Official Source",
        endTimeMs: Date.now() + 10 * 86400 * 1000,
        active: true,
        closed: false,
        acceptingOrders: true,
        negRisk: false,
        tickSizeMicros: 10_000n,
        minOrderSizeMicros: 1n * PUSD_SCALE,
        feesEnabled: false,
        feeRateBps: 0,
        bestBidMicros: 590_000n,
        bestAskMicros: 600_000n,
        spreadMicros: 10_000n,
        depthPusdMicrosAtLimit: 1000n * PUSD_SCALE,
        bids: [],
        asks: [],
        capturedAtMs: Date.now()
      }
    };

    const mockContext: RiskContext = {
      nowMs: Date.now(),
      liveTradeCount: 20,
      dailyPnlMicros: 0n,
      dailyPnlKnown: true,
      totalOpenExposureMicros: 0n,
      marketExposureMicros: 0n,
      correlatedExposureMicros: 0n,
      openMarketCount: 1,
      heldSharesMicros: 0n,
      emergencyStopped: false
    };

    const evalResult = evaluateOrderRisk(mockIntent, mockContext, DEFAULT_RISK_POLICY);
    expect(evalResult.violations.some((v) => v.code === "HARD_CEILING_EXCEEDED")).toBe(true);
  });
});
