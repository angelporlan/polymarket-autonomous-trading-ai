import {
  PUSD_SCALE,
  canonicalCorrelationKey,
  type OrderIntent,
  type RiskContext,
  type RiskViolation,
  multiplyMicros
} from "./types.js";

export const RISK_POLICY_VERSION = "2026-07-pilot-v1";

export interface RiskPolicy {
  capitalMicros: bigint;
  canaryMaxOrderMicros: bigint;
  pilotMaxOrderMicros: bigint;
  canaryMaxOpenExposureMicros: bigint;
  pilotMaxOpenExposureMicros: bigint;
  maxMarketOrCorrelationMicros: bigint;
  maxOpenMarkets: number;
  dailyStopMicros: bigint;
  canaryTradeCount: number;
  proposalTtlMs: number;
  effectiveGtdMs: number;
  maxSnapshotAgeMs: number;
  minTimeToCloseMs: number;
  minEdgeMicros: bigint;
  maxSpreadMicros: bigint;
  depthMultiplier: bigint;
}

export const DEFAULT_RISK_POLICY: RiskPolicy = Object.freeze({
  capitalMicros: 100n * PUSD_SCALE,
  canaryMaxOrderMicros: 5n * PUSD_SCALE,
  pilotMaxOrderMicros: 10n * PUSD_SCALE,
  canaryMaxOpenExposureMicros: 20n * PUSD_SCALE,
  pilotMaxOpenExposureMicros: 50n * PUSD_SCALE,
  maxMarketOrCorrelationMicros: 25n * PUSD_SCALE,
  maxOpenMarkets: 5,
  dailyStopMicros: 10n * PUSD_SCALE,
  canaryTradeCount: 10,
  proposalTtlMs: 300_000,
  effectiveGtdMs: 15 * 60_000,
  maxSnapshotAgeMs: 5_000,
  minTimeToCloseMs: 24 * 60 * 60_000,
  minEdgeMicros: 50_000n,
  maxSpreadMicros: 30_000n,
  depthMultiplier: 5n
});

export interface RiskEvaluation {
  violations: RiskViolation[];
  maxCostMicros: bigint;
  estimatedFeeMicros: bigint;
  expectedEdgeMicros: bigint;
  postTradeMarketExposureMicros: bigint;
  postTradeTotalExposureMicros: bigint;
}

export function evaluateOrderRisk(
  intent: OrderIntent,
  context: RiskContext,
  policy: RiskPolicy = DEFAULT_RISK_POLICY
): RiskEvaluation {
  const violations: RiskViolation[] = [];
  const { market } = intent;
  const maxCostMicros = multiplyMicros(intent.limitPriceMicros, intent.sharesMicros);
  const estimatedFeeMicros = estimateMaximumTakerFeeMicros(
    intent.sharesMicros,
    intent.limitPriceMicros,
    intent.side,
    market.feeRateBps,
    market.feeExponent ?? 1
  );
  const orderRiskMicros = maxCostMicros + estimatedFeeMicros;
  const grossExpectedEdgeMicros =
    intent.side === "BUY"
      ? intent.estimatedProbabilityMicros - intent.limitPriceMicros
      : intent.limitPriceMicros - intent.estimatedProbabilityMicros;
  const feePerShareMicros =
    intent.sharesMicros > 0n
      ? (estimatedFeeMicros * PUSD_SCALE + intent.sharesMicros - 1n) /
        intent.sharesMicros
      : 0n;
  const expectedEdgeMicros = grossExpectedEdgeMicros - feePerShareMicros;
  const exposureDeltaMicros = intent.side === "BUY" ? orderRiskMicros : -maxCostMicros;
  const postTradeMarketExposureMicros = maxBigInt(
    0n,
    context.marketExposureMicros + exposureDeltaMicros
  );
  const postTradeCorrelationExposureMicros = maxBigInt(
    0n,
    context.correlatedExposureMicros + exposureDeltaMicros
  );
  const postTradeTotalExposureMicros = maxBigInt(
    0n,
    context.totalOpenExposureMicros + exposureDeltaMicros
  );
  const maxOrderMicros =
    context.liveTradeCount < policy.canaryTradeCount
      ? policy.canaryMaxOrderMicros
      : policy.pilotMaxOrderMicros;
  const maxOpenExposureMicros =
    context.liveTradeCount < policy.canaryTradeCount
      ? policy.canaryMaxOpenExposureMicros
      : policy.pilotMaxOpenExposureMicros;

  if (
    intent.executionMode === "live" &&
    (market.eventId === null ||
      intent.correlationKey !== canonicalCorrelationKey(market))
  ) {
    violations.push({
      code: "CORRELATION_ID_UNAVAILABLE",
      message:
        "Live trading requires a canonical event identifier for correlated exposure."
    });
  }

  if (context.emergencyStopped) {
    violations.push({
      code: "EMERGENCY_STOPPED",
      message: "The emergency stop is active."
    });
  }

  if (!["politics", "economics", "technology"].includes(market.category)) {
    violations.push({
      code: "CATEGORY_NOT_ALLOWED",
      message: `Category ${market.category} is outside the allowlist.`
    });
  }

  if (!market.active || market.closed || !market.acceptingOrders) {
    violations.push({
      code: "MARKET_NOT_TRADEABLE",
      message: "The market is not active and accepting orders."
    });
  }

  if (market.rules.trim().length < 20 || market.resolutionSource.trim().length < 3) {
    violations.push({
      code: "RULES_INCOMPLETE",
      message: "Resolution rules and source must be present."
    });
  }

  if (context.nowMs - market.capturedAtMs > policy.maxSnapshotAgeMs) {
    violations.push({
      code: "SNAPSHOT_STALE",
      message: "The market snapshot is older than five seconds."
    });
  }

  if (market.endTimeMs - context.nowMs <= policy.minTimeToCloseMs) {
    violations.push({
      code: "CLOSE_TOO_SOON",
      message: "The market closes in 24 hours or less."
    });
  }

  if (
    intent.limitPriceMicros <= 0n ||
    intent.limitPriceMicros >= PUSD_SCALE ||
    intent.sharesMicros <= 0n ||
    intent.estimatedProbabilityMicros < 0n ||
    intent.estimatedProbabilityMicros > PUSD_SCALE
  ) {
    violations.push({
      code: "INVALID_VALUE",
      message: "Price, probability, and size must be positive and within their ranges."
    });
  }

  if (
    market.tickSizeMicros <= 0n ||
    intent.limitPriceMicros % market.tickSizeMicros !== 0n
  ) {
    violations.push({
      code: "INVALID_TICK",
      message: "The limit price does not conform to the market tick size."
    });
  }

  if (
    market.minOrderSizeMicros <= 0n ||
    intent.sharesMicros < market.minOrderSizeMicros
  ) {
    violations.push({
      code: "ORDER_BELOW_MARKET_MINIMUM",
      message: "Share size is below the market's current minimum order size."
    });
  }

  if (orderRiskMicros > maxOrderMicros) {
    violations.push({
      code: "ORDER_TOO_LARGE",
      message: "The order exceeds the current canary or pilot per-order limit."
    });
  }

  if (
    postTradeMarketExposureMicros > policy.maxMarketOrCorrelationMicros ||
    postTradeCorrelationExposureMicros > policy.maxMarketOrCorrelationMicros
  ) {
    violations.push({
      code: "MARKET_EXPOSURE",
      message: "Market or correlated-event exposure would exceed 25 pUSD."
    });
  }

  if (postTradeTotalExposureMicros > maxOpenExposureMicros) {
    violations.push({
      code: "TOTAL_EXPOSURE",
      message: "Total open exposure would exceed the current canary or pilot limit."
    });
  }

  if (
    intent.side === "BUY" &&
    context.marketExposureMicros === 0n &&
    context.openMarketCount >= policy.maxOpenMarkets
  ) {
    violations.push({
      code: "TOO_MANY_MARKETS",
      message: "At most five markets may be open at once."
    });
  }

  if (context.dailyPnlMicros <= -policy.dailyStopMicros) {
    violations.push({
      code: "DAILY_STOP",
      message: "The 10 pUSD daily stop has been reached."
    });
  }

  if (intent.executionMode === "live" && context.dailyPnlKnown === false) {
    violations.push({
      code: "DAILY_PNL_UNAVAILABLE",
      message: "The local daily risk session has not been armed."
    });
  }

  if (
    context.coolingDownUntilMs !== undefined &&
    context.coolingDownUntilMs !== null &&
    context.coolingDownUntilMs > context.nowMs
  ) {
    violations.push({
      code: "COOLING_DOWN",
      message: "The 24-hour loss cooldown is still active."
    });
  }

  if (intent.sharesMicros % 10_000n !== 0n) {
    violations.push({
      code: "INVALID_VALUE",
      message: "Share size must use at most two decimal places for the CLOB SDK."
    });
  }

  if (expectedEdgeMicros < policy.minEdgeMicros) {
    violations.push({
      code: "EDGE_TOO_SMALL",
      message: "Expected edge is below five percentage points."
    });
  }

  if (market.spreadMicros > policy.maxSpreadMicros) {
    violations.push({
      code: "SPREAD_TOO_WIDE",
      message: "Spread is wider than 0.03 pUSD."
    });
  }

  if (market.depthPusdMicrosAtLimit < orderRiskMicros * policy.depthMultiplier) {
    violations.push({
      code: "INSUFFICIENT_DEPTH",
      message: "Depth at the approved limit is less than five times the order risk."
    });
  }

  if (intent.side === "SELL" && intent.sharesMicros > context.heldSharesMicros) {
    violations.push({
      code: "SELL_EXCEEDS_POSITION",
      message: "Sell size exceeds the settled position."
    });
  }

  return {
    violations,
    maxCostMicros,
    estimatedFeeMicros,
    expectedEdgeMicros,
    postTradeMarketExposureMicros,
    postTradeTotalExposureMicros
  };
}

export function estimateTakerFeeMicros(
  sharesMicros: bigint,
  priceMicros: bigint,
  feeRateBps: number,
  feeExponent: number
): bigint {
  const fraction = feeFraction(
    sharesMicros,
    priceMicros,
    feeRateBps,
    feeExponent
  );
  if (fraction === null) {
    return 0n;
  }
  // Polymarket documents five-decimal fee precision. Paper accounting uses
  // nearest 0.00001 pUSD; the live reservation below deliberately rounds up.
  const fiveDecimalUnitMicros = 10n;
  return (
    ((fraction.numerator * 2n +
      fraction.denominator * fiveDecimalUnitMicros) /
      (fraction.denominator * fiveDecimalUnitMicros * 2n)) *
    fiveDecimalUnitMicros
  );
}

/**
 * Reserves the largest taker fee that can occur anywhere in the order's
 * executable price interval. The fee curve peaks at 0.50, so using only the
 * limit price is unsafe for a BUY above 0.50 or a SELL below 0.50.
 */
export function estimateMaximumTakerFeeMicros(
  sharesMicros: bigint,
  limitPriceMicros: bigint,
  side: "BUY" | "SELL",
  feeRateBps: number,
  feeExponent: number
): bigint {
  const halfPriceMicros = PUSD_SCALE / 2n;
  const worstExecutablePriceMicros =
    side === "BUY"
      ? limitPriceMicros < halfPriceMicros
        ? limitPriceMicros
        : halfPriceMicros
      : limitPriceMicros > halfPriceMicros
        ? limitPriceMicros
        : halfPriceMicros;
  const fraction = feeFraction(
    sharesMicros,
    worstExecutablePriceMicros,
    feeRateBps,
    feeExponent
  );
  if (fraction === null) {
    return 0n;
  }
  const fiveDecimalUnitMicros = 10n;
  const roundingDenominator =
    fraction.denominator * fiveDecimalUnitMicros;
  return (
    ((fraction.numerator + roundingDenominator - 1n) /
      roundingDenominator) *
    fiveDecimalUnitMicros
  );
}

function feeFraction(
  sharesMicros: bigint,
  priceMicros: bigint,
  feeRateBps: number,
  feeExponent: number
): { numerator: bigint; denominator: bigint } | null {
  if (
    sharesMicros <= 0n ||
    priceMicros <= 0n ||
    priceMicros >= PUSD_SCALE ||
    !Number.isSafeInteger(feeRateBps) ||
    feeRateBps <= 0
  ) {
    return null;
  }
  if (
    !Number.isSafeInteger(feeExponent) ||
    feeExponent < 0 ||
    feeExponent > 8
  ) {
    throw new Error("Unsupported market fee exponent.");
  }
  const curveNumerator =
    priceMicros * (PUSD_SCALE - priceMicros);
  let curvePower = 1n;
  let scalePower = 1n;
  for (let index = 0; index < feeExponent; index += 1) {
    curvePower *= curveNumerator;
    scalePower *= PUSD_SCALE * PUSD_SCALE;
  }
  return {
    numerator: sharesMicros * BigInt(feeRateBps) * curvePower,
    denominator: 10_000n * scalePower
  };
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
