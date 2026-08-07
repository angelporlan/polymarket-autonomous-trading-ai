import { DEFAULT_RISK_POLICY } from "./risk-policy.js";
import { type ExitState, type OrderSide, type PositionRecord } from "./types.js";

export const POSITION_STOP_LOSS_PCT = 0.30; // -30%
export const POSITION_TAKE_PROFIT_PCT = 0.50; // +50%
export const MAX_HOLDING_DURATION_MS = 14 * 24 * 60 * 60 * 1_000; // 14 days
export const PRICE_SHOCK_THRESHOLD_PCT = 0.20; // 20% price move
export const RESOLUTION_URGENCY_WINDOW_MS = 24 * 60 * 60 * 1_000; // 24 hours
export const EDGE_EXIT_THRESHOLD_MICROS = DEFAULT_RISK_POLICY.minEdgeMicros / 2n;

export interface EvaluationAction {
  shouldExit: boolean;
  triggerReason: ExitState;
  explanation: string;
  recommendedOrderSide: OrderSide;
}

export function evaluatePositionExitPolicy(
  position: PositionRecord,
  currentPriceMicros: bigint,
  currentEstimatedProbabilityMicros: bigint | null,
  currentResearchBundleId: string | null,
  marketEndTimeMs: number,
  nowMs: number = Date.now()
): EvaluationAction {
  const recommendedOrderSide: OrderSide = position.side === "BUY" ? "SELL" : "BUY";

  // Check 0: Legacy unverified position
  if (position.exitState === "LEGACY_UNVERIFIED") {
    return {
      shouldExit: false,
      triggerReason: "LEGACY_UNVERIFIED",
      explanation: "Position lacks verified local entry evidence; manual verification required.",
      recommendedOrderSide
    };
  }

  // Check 1: Resolution urgency (less than 24h to market end) -> Hold until resolution
  if (marketEndTimeMs - nowMs <= RESOLUTION_URGENCY_WINDOW_MS) {
    return {
      shouldExit: false,
      triggerReason: "HOLD_UNTIL_RESOLUTION",
      explanation: "Market ends in less than 24 hours; holding position until native market resolution.",
      recommendedOrderSide
    };
  }

  if (position.averagePriceMicros <= 0n) {
    return {
      shouldExit: false,
      triggerReason: "HOLDING",
      explanation: "Invalid average entry price.",
      recommendedOrderSide
    };
  }

  // Check 3: Stop-loss (-30%)
  if (currentPriceMicros * 100n <= position.averagePriceMicros * 70n) {
    return {
      shouldExit: true,
      triggerReason: "STOP_LOSS_TRIGGERED",
      explanation: "Stop-loss triggered: market price is at or below 70% of the average entry price.",
      recommendedOrderSide
    };
  }

  // Check 4: Take-profit (+50%)
  if (currentPriceMicros * 100n >= position.averagePriceMicros * 150n) {
    return {
      shouldExit: true,
      triggerReason: "TAKE_PROFIT_TRIGGERED",
      explanation: "Take-profit triggered: market price is at or above 150% of the average entry price.",
      recommendedOrderSide
    };
  }

  // Check 5: Max duration (14 days)
  if (nowMs - position.openedAtMs >= MAX_HOLDING_DURATION_MS) {
    return {
      shouldExit: true,
      triggerReason: "MAX_DURATION_EXPIRED",
      explanation: `Position held for over 14 days (opened ${new Date(position.openedAtMs).toISOString()}).`,
      recommendedOrderSide
    };
  }

  // Check 6: Price shock (>= 20% move since last evaluation)
  if (
    position.lastMarketPriceMicros > 0n &&
    absDifference(currentPriceMicros, position.lastMarketPriceMicros) * 100n >=
      position.lastMarketPriceMicros * 20n
  ) {
    return {
      shouldExit: false,
      triggerReason: "RESEARCH_REQUIRED",
      explanation: "Market price moved by at least 20%; a fresh research bundle is required before evaluating edge.",
      recommendedOrderSide
    };
  }

  // Check 7: Edge disappearance only with fresh probability and research.
  if (
    currentEstimatedProbabilityMicros === null ||
    currentEstimatedProbabilityMicros <= 0n ||
    currentResearchBundleId === null ||
    currentResearchBundleId.trim().length === 0
  ) {
    return {
      shouldExit: false,
      triggerReason: "HOLDING",
      explanation: "No valid research bundle is available; edge-based exit remains blocked.",
      recommendedOrderSide
    };
  }

  const currentEdgeMicros =
    position.side === "BUY"
      ? currentEstimatedProbabilityMicros - currentPriceMicros
      : currentPriceMicros - currentEstimatedProbabilityMicros;
  if (
    currentEdgeMicros < 0n ||
    currentEdgeMicros < EDGE_EXIT_THRESHOLD_MICROS
  ) {
    return {
      shouldExit: true,
      triggerReason: "EDGE_DISAPPEARED",
      explanation: `Expected edge is ${currentEdgeMicros} micros, below the conservative ${EDGE_EXIT_THRESHOLD_MICROS}-micros threshold.`,
      recommendedOrderSide
    };
  }

  return {
    shouldExit: false,
    triggerReason: "HOLDING",
    explanation: "Position remains healthy within parameters.",
    recommendedOrderSide
  };
}

function absDifference(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}
