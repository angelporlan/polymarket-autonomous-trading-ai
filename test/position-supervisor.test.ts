import { describe, expect, it } from "vitest";
import { evaluatePositionExitPolicy } from "../src/domain/position-supervisor.js";
import { PUSD_SCALE, type PositionRecord } from "../src/domain/types.js";

describe("PositionSupervisor", () => {
  const nowMs = 1700000000000;
  const futureEndMs = nowMs + 10 * 86400 * 1000;

  const basePosition: PositionRecord = {
    tokenId: "token_1",
    conditionId: "cond_1",
    question: "Will candidate win?",
    outcome: "Yes",
    side: "BUY",
    sharesMicros: 100n * PUSD_SCALE,
    averagePriceMicros: 500_000n, // $0.50 entry
    evidenceQuality: "VERIFIED",
    entryProbabilityMicros: 550_000n,
    entryEdgeMicros: 50_000n,
    openedAtMs: nowMs - 2 * 86400 * 1000, // 2 days ago
    lastEvaluatedAtMs: nowMs - 3600 * 1000,
    lastMarketPriceMicros: 500_000n,
    lastEstimatedProbabilityMicros: 600_000n,
    lastResearchBundleId: "bundle-current",
    sourcesJson: "[]",
    exitState: "HOLDING",
    activeExitProposalId: null,
    activeExitOrderId: null
  };

  it("recommends HOLDING for normal position", () => {
    const action = evaluatePositionExitPolicy(
      basePosition,
      550_000n, // Current price $0.55 (+10%)
      650_000n, // Probability $0.65 (Edge $0.10)
      "bundle-current",
      futureEndMs,
      nowMs
    );

    expect(action.shouldExit).toBe(false);
    expect(action.triggerReason).toBe("HOLDING");
    expect(action.recommendedOrderSide).toBe("SELL");
  });

  it("triggers STOP_LOSS_TRIGGERED on >= 30% loss", () => {
    const action = evaluatePositionExitPolicy(
      basePosition,
      340_000n, // Current price $0.34 (-32% loss vs $0.50 entry)
      400_000n,
      "bundle-current",
      futureEndMs,
      nowMs
    );

    expect(action.shouldExit).toBe(true);
    expect(action.triggerReason).toBe("STOP_LOSS_TRIGGERED");
    expect(action.explanation).toContain("Stop-loss triggered");
  });

  it("triggers TAKE_PROFIT_TRIGGERED on >= 50% gain", () => {
    const action = evaluatePositionExitPolicy(
      basePosition,
      760_000n, // Current price $0.76 (+52% gain vs $0.50 entry)
      850_000n,
      "bundle-current",
      futureEndMs,
      nowMs
    );

    expect(action.shouldExit).toBe(true);
    expect(action.triggerReason).toBe("TAKE_PROFIT_TRIGGERED");
    expect(action.explanation).toContain("Take-profit triggered");
  });

  it("triggers MAX_DURATION_EXPIRED on positions held over 14 days", () => {
    const oldPosition: PositionRecord = {
      ...basePosition,
      openedAtMs: nowMs - 15 * 86400 * 1000 // 15 days ago
    };

    const action = evaluatePositionExitPolicy(
      oldPosition,
      550_000n,
      650_000n,
      "bundle-current",
      futureEndMs,
      nowMs
    );

    expect(action.shouldExit).toBe(true);
    expect(action.triggerReason).toBe("MAX_DURATION_EXPIRED");
    expect(action.explanation).toContain("held for over 14 days");
  });

  it("triggers EDGE_DISAPPEARED when edge becomes <= 0", () => {
    const edgePosition = {
      ...basePosition,
      lastMarketPriceMicros: 600_000n
    };
    const action = evaluatePositionExitPolicy(
      edgePosition,
      600_000n, // Price $0.60
      580_000n, // Probability $0.58 (Edge -0.02)
      "bundle-current",
      futureEndMs,
      nowMs
    );

    expect(action.shouldExit).toBe(true);
    expect(action.triggerReason).toBe("EDGE_DISAPPEARED");
  });

  it("blocks edge exits for partially verified legacy positions", () => {
    const action = evaluatePositionExitPolicy(
      {
        ...basePosition,
        evidenceQuality: "PARTIALLY_VERIFIED",
        lastMarketPriceMicros: 600_000n
      },
      600_000n,
      580_000n,
      "bundle-current",
      futureEndMs,
      nowMs
    );

    expect(action.shouldExit).toBe(false);
    expect(action.triggerReason).toBe("HOLDING");
    expect(action.explanation).toContain("edge-based exit remains blocked");
  });

  it("requires a fresh research bundle for edge exits and never treats price as probability", () => {
    const action = evaluatePositionExitPolicy(
      {
        ...basePosition,
        lastMarketPriceMicros: 600_000n,
        lastEstimatedProbabilityMicros: null,
        lastResearchBundleId: null
      },
      600_000n,
      null,
      null,
      futureEndMs,
      nowMs
    );

    expect(action.shouldExit).toBe(false);
    expect(action.triggerReason).toBe("HOLDING");
  });

  it("requests research after a 20% market-price move without selling", () => {
    const action = evaluatePositionExitPolicy(
      basePosition,
      600_000n,
      650_000n,
      "bundle-current",
      futureEndMs,
      nowMs
    );

    expect(action.shouldExit).toBe(false);
    expect(action.triggerReason).toBe("RESEARCH_REQUIRED");
  });

  it("triggers HOLD_UNTIL_RESOLUTION when market ends in under 24 hours", () => {
    const action = evaluatePositionExitPolicy(
      basePosition,
      550_000n,
      650_000n,
      "bundle-current",
      nowMs + 12 * 3600 * 1000, // Resolution in 12h
      nowMs
    );

    expect(action.shouldExit).toBe(false);
    expect(action.triggerReason).toBe("HOLD_UNTIL_RESOLUTION");
    expect(action.explanation).toContain("less than 24 hours");
  });
});
