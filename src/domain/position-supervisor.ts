import { PUSD_SCALE, type ExitState, type OrderSide, type PositionRecord } from "./types.js";

export const POSITION_STOP_LOSS_PCT = 0.30; // -30%
export const POSITION_TAKE_PROFIT_PCT = 0.50; // +50%
export const MAX_HOLDING_DURATION_MS = 14 * 24 * 60 * 60 * 1_000; // 14 days
export const PRICE_SHOCK_THRESHOLD_PCT = 0.20; // 20% price move
export const RESOLUTION_URGENCY_WINDOW_MS = 24 * 60 * 60 * 1_000; // 24 hours

export interface EvaluationAction {
  shouldExit: boolean;
  triggerReason: ExitState;
  explanation: string;
  recommendedOrderSide: OrderSide;
}

export function evaluatePositionExitPolicy(
  position: PositionRecord,
  currentPriceMicros: bigint,
  currentProbabilityMicros: bigint,
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

  // Check 2: Max duration (14 days)
  if (nowMs - position.openedAtMs >= MAX_HOLDING_DURATION_MS) {
    return {
      shouldExit: true,
      triggerReason: "MAX_DURATION_EXPIRED",
      explanation: `Position held for over 14 days (opened ${new Date(position.openedAtMs).toISOString()}).`,
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

  // Calculate return %
  const priceDiff = currentPriceMicros - position.averagePriceMicros;
  const pnlRatio =
    position.side === "BUY"
      ? Number(priceDiff) / Number(position.averagePriceMicros)
      : Number(-priceDiff) / Number(position.averagePriceMicros);

  // Check 3: Stop-loss (-30%)
  if (pnlRatio <= -POSITION_STOP_LOSS_PCT) {
    return {
      shouldExit: true,
      triggerReason: "STOP_LOSS_TRIGGERED",
      explanation: `Stop-loss triggered: PnL ratio is ${(pnlRatio * 100).toFixed(1)}% (threshold: -30%).`,
      recommendedOrderSide
    };
  }

  // Check 4: Take-profit (+50%)
  if (pnlRatio >= POSITION_TAKE_PROFIT_PCT) {
    return {
      shouldExit: true,
      triggerReason: "TAKE_PROFIT_TRIGGERED",
      explanation: `Take-profit triggered: PnL ratio is +${(pnlRatio * 100).toFixed(1)}% (threshold: +50%).`,
      recommendedOrderSide
    };
  }

  // Check 5: Edge disappearance (use evaluated probability or stored edge, not currentPrice)
  const evaluatedProb =
    currentProbabilityMicros > 0n && currentProbabilityMicros !== currentPriceMicros
      ? currentProbabilityMicros
      : position.lastProbabilityMicros > 0n
        ? position.lastProbabilityMicros
        : position.averagePriceMicros + position.entryEdgeMicros;

  const grossEdgeMicros =
    position.side === "BUY"
      ? evaluatedProb - currentPriceMicros
      : currentPriceMicros - evaluatedProb;

  if (grossEdgeMicros <= 0n) {
    return {
      shouldExit: true,
      triggerReason: "EDGE_DISAPPEARED",
      explanation: "Expected edge has vanished or turned negative.",
      recommendedOrderSide
    };
  }

  // Check 6: Price shock (>= 20% move since last evaluation)
  if (position.lastProbabilityMicros > 0n) {
    const probDiff = Math.abs(Number(currentProbabilityMicros - position.lastProbabilityMicros));
    const probRatio = probDiff / Number(position.lastProbabilityMicros);
    if (probRatio >= PRICE_SHOCK_THRESHOLD_PCT) {
      return {
        shouldExit: false,
        triggerReason: "REVALUATION_TRIGGERED",
        explanation: `Significant price movement of ${(probRatio * 100).toFixed(1)}% detected; re-evaluation required.`,
        recommendedOrderSide
      };
    }
  }

  return {
    shouldExit: false,
    triggerReason: "HOLDING",
    explanation: "Position remains healthy within parameters.",
    recommendedOrderSide
  };
}
