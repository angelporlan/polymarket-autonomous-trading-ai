import type {
  MarketSnapshot,
  OrderIntent,
  RiskContext
} from "../src/domain/types.js";
import { PUSD_SCALE } from "../src/domain/types.js";

export function marketFixture(nowMs = Date.now()): MarketSnapshot {
  return {
    conditionId: `0x${"1".repeat(64)}`,
    tokenId: "123456789",
    eventId: "42",
    question: "Will the test event occur before the stated deadline?",
    slug: "will-test-event-occur",
    outcome: "Yes",
    category: "politics",
    rules:
      "This market resolves Yes if the official source reports that the test event occurred.",
    resolutionSource: "https://example.gov/official",
    endTimeMs: nowMs + 7 * 24 * 60 * 60_000,
    active: true,
    closed: false,
    acceptingOrders: true,
    negRisk: false,
    tickSizeMicros: 10_000n,
    minOrderSizeMicros: 1_000_000n,
    feesEnabled: false,
    feeRateBps: 0,
    feeExponent: 1,
    feesTakerOnly: true,
    bestBidMicros: 390_000n,
    bestAskMicros: 400_000n,
    spreadMicros: 10_000n,
    depthPusdMicrosAtLimit: 100n * PUSD_SCALE,
    bids: [
      { priceMicros: 390_000n, sharesMicros: 100n * PUSD_SCALE },
      { priceMicros: 380_000n, sharesMicros: 100n * PUSD_SCALE }
    ],
    asks: [
      { priceMicros: 400_000n, sharesMicros: 8n * PUSD_SCALE },
      { priceMicros: 410_000n, sharesMicros: 8n * PUSD_SCALE }
    ],
    capturedAtMs: nowMs
  };
}

export function intentFixture(nowMs = Date.now()): OrderIntent {
  return {
    intent: "ENTRY",
    executionMode: "paper",
    market: marketFixture(nowMs),
    side: "BUY",
    sharesMicros: 10n * PUSD_SCALE,
    limitPriceMicros: 400_000n,
    estimatedProbabilityMicros: 500_000n,
    thesis: "The official timetable and primary evidence support a higher probability.",
    counterThesis: "The timetable may slip or the resolution wording may be interpreted narrowly.",
    sources: [
      {
        url: "https://example.gov/official",
        title: "Official announcement",
        publishedAt: "2026-07-20T10:00:00.000Z",
        retrievedAt: new Date(nowMs).toISOString(),
        primary: true
      }
    ],
    correlationKey: "event:42"
  };
}

export function riskContextFixture(nowMs = Date.now()): RiskContext {
  return {
    nowMs,
    liveTradeCount: 0,
    dailyPnlMicros: 0n,
    totalOpenExposureMicros: 0n,
    marketExposureMicros: 0n,
    correlatedExposureMicros: 0n,
    openMarketCount: 0,
    heldSharesMicros: 0n,
    emergencyStopped: false
  };
}
