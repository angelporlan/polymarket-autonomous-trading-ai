import {
  PUSD_SCALE,
  type CandidateMarket,
  type MarketSnapshot,
  type ResearchBundle
} from "./types.js";
import { estimateMaximumTakerFeeMicros } from "./risk-policy.js";

/**
 * This is deliberately a small, integer-only ranking model. It does not
 * manufacture a probability: the probability is taken from a current,
 * verified ResearchBundle and is revalidated again by TradingService before
 * any proposal can execute.
 */
export const OPPORTUNITY_MODEL_VERSION = "deterministic-edge-v1";
export const OPPORTUNITY_MIN_HISTORY_MS = 15 * 60_000;
export const OPPORTUNITY_HISTORY_WINDOWS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

export interface SnapshotHistoryPoint {
  tokenId: string;
  conditionId: string;
  capturedAtMs: number;
  bestBidMicros: bigint;
  bestAskMicros: bigint;
  spreadMicros: bigint;
  bidDepthMicros: bigint;
  askDepthMicros: bigint;
}

export interface OpportunityFeatures {
  modelVersion: typeof OPPORTUNITY_MODEL_VERSION;
  midPriceMicros: bigint;
  movement1mMicros: bigint | null;
  movement5mMicros: bigint | null;
  movement15mMicros: bigint | null;
  orderImbalanceMicros: bigint;
  spreadMicros: bigint;
  depthPusdMicros: bigint;
  volume24hMicros: bigint;
  liquidityMicros: bigint;
  netEdgeMicros: bigint;
  scoreMicros: bigint;
}

export type OpportunitySkipReason =
  | "SNAPSHOT_STALE"
  | "MARKET_UNSAFE"
  | "CLOSE_TOO_SOON"
  | "SPREAD_TOO_WIDE"
  | "INSUFFICIENT_DEPTH"
  | "RESEARCH_MISSING"
  | "RESEARCH_EXPIRED"
  | "RESEARCH_INCONSISTENT"
  | "HISTORY_WARMUP"
  | "EDGE_TOO_SMALL"
  | "NO_ASK"
  | "INVALID_MARKET_DATA";

export interface OpportunityDecision {
  accepted: boolean;
  reason: OpportunitySkipReason | null;
  features: OpportunityFeatures | null;
  researchBundleId: string | null;
  estimatedProbabilityMicros: bigint | null;
}

export interface OpportunityInput {
  candidate: CandidateMarket;
  snapshot: MarketSnapshot;
  history: SnapshotHistoryPoint[];
  researchBundle: ResearchBundle | null;
  nowMs: number;
  /** The proposed notional risk, including a conservative fee reserve. */
  riskMicros: bigint;
  minEdgeMicros?: bigint;
  maxSpreadMicros?: bigint;
  minTimeToCloseMs?: number;
  maxSnapshotAgeMs?: number;
  depthMultiplier?: bigint;
}

export function snapshotHistoryPoint(snapshot: MarketSnapshot): SnapshotHistoryPoint {
  return {
    tokenId: snapshot.tokenId,
    conditionId: snapshot.conditionId,
    capturedAtMs: snapshot.capturedAtMs,
    bestBidMicros: snapshot.bestBidMicros,
    bestAskMicros: snapshot.bestAskMicros,
    spreadMicros: snapshot.spreadMicros,
    bidDepthMicros: sumDepth(snapshot.bids),
    askDepthMicros: sumDepth(snapshot.asks)
  };
}

export function evaluateOpportunity(input: OpportunityInput): OpportunityDecision {
  const {
    candidate,
    snapshot,
    history,
    researchBundle,
    nowMs,
    riskMicros,
    minEdgeMicros = 50_000n,
    maxSpreadMicros = 30_000n,
    minTimeToCloseMs = 24 * 60 * 60_000,
    maxSnapshotAgeMs = 5_000,
    depthMultiplier = 5n
  } = input;

  if (
    !["politics", "economics", "technology"].includes(snapshot.category) ||
    snapshot.tokenId !== candidate.tokenIds.find((tokenId) => tokenId === snapshot.tokenId) ||
    snapshot.conditionId !== candidate.conditionId ||
    snapshot.category !== candidate.category ||
    !snapshot.active ||
    snapshot.closed ||
    !snapshot.acceptingOrders ||
    !candidate.active ||
    !candidate.acceptingOrders ||
    snapshot.rules.trim().length < 20 ||
    snapshot.resolutionSource.trim().length < 3
  ) {
    return rejected("MARKET_UNSAFE", researchBundle);
  }
  if (
    !Number.isSafeInteger(snapshot.capturedAtMs) ||
    snapshot.capturedAtMs > nowMs + 1_000 ||
    nowMs - snapshot.capturedAtMs > maxSnapshotAgeMs
  ) {
    return rejected("SNAPSHOT_STALE", researchBundle);
  }
  if (snapshot.endTimeMs - nowMs <= minTimeToCloseMs) {
    return rejected("CLOSE_TOO_SOON", researchBundle);
  }
  if (snapshot.bestAskMicros <= 0n || snapshot.bestAskMicros >= PUSD_SCALE) {
    return rejected("NO_ASK", researchBundle);
  }
  if (snapshot.spreadMicros > maxSpreadMicros) {
    return rejected("SPREAD_TOO_WIDE", researchBundle);
  }
  if (riskMicros <= 0n || snapshot.depthPusdMicrosAtLimit < riskMicros * depthMultiplier) {
    return rejected("INSUFFICIENT_DEPTH", researchBundle);
  }
  if (researchBundle === null) {
    return rejected("RESEARCH_MISSING", null);
  }
  if (
    researchBundle.marketConditionId !== snapshot.conditionId ||
    researchBundle.tokenId !== snapshot.tokenId
  ) {
    return rejected("RESEARCH_INCONSISTENT", researchBundle);
  }
  if (researchBundle.expiresAtMs <= nowMs) {
    return rejected("RESEARCH_EXPIRED", researchBundle);
  }
  if (
    researchBundle.sources.length < 2 ||
    new Set(researchBundle.sources.map((source) => source.registrableDomain)).size < 2 ||
    researchBundle.estimatedProbabilityMicros < 0n ||
    researchBundle.estimatedProbabilityMicros > PUSD_SCALE
  ) {
    return rejected("RESEARCH_INCONSISTENT", researchBundle);
  }

  const relevantHistory = history
    .filter(
      (point) =>
        point.tokenId === snapshot.tokenId &&
        point.conditionId === snapshot.conditionId &&
        point.capturedAtMs < snapshot.capturedAtMs
    )
    .sort((left, right) => right.capturedAtMs - left.capturedAtMs);
  const oldest = relevantHistory.at(-1);
  if (
    oldest === undefined ||
    snapshot.capturedAtMs - oldest.capturedAtMs < OPPORTUNITY_MIN_HISTORY_MS
  ) {
    return rejected("HISTORY_WARMUP", researchBundle);
  }

  const currentPoint = snapshotHistoryPoint(snapshot);
  const midPriceMicros = midpoint(snapshot.bestBidMicros, snapshot.bestAskMicros);
  const movement1mMicros = movementForWindow(currentPoint, relevantHistory, 60_000);
  const movement5mMicros = movementForWindow(currentPoint, relevantHistory, 5 * 60_000);
  const movement15mMicros = movementForWindow(currentPoint, relevantHistory, 15 * 60_000);
  if (movement15mMicros === null) {
    return rejected("HISTORY_WARMUP", researchBundle);
  }

  const orderImbalanceMicros = imbalance(currentPoint.bidDepthMicros, currentPoint.askDepthMicros);
  const sharesForRisk = (riskMicros * PUSD_SCALE) / snapshot.bestAskMicros;
  const feeMicros = estimateMaximumTakerFeeMicros(
    sharesForRisk > 0n ? sharesForRisk : 1n,
    snapshot.bestAskMicros,
    "BUY",
    snapshot.feeRateBps,
    snapshot.feeExponent ?? 1
  );
  const feePerShareMicros = sharesForRisk > 0n ? (feeMicros * PUSD_SCALE + sharesForRisk - 1n) / sharesForRisk : 0n;
  const netEdgeMicros = researchBundle.estimatedProbabilityMicros - snapshot.bestAskMicros - feePerShareMicros;
  const scoreMicros =
    netEdgeMicros +
    positive(movement1mMicros ?? 0n) / 20n +
    positive(movement5mMicros ?? 0n) / 15n +
    positive(orderImbalanceMicros) / 10n +
    positive(movement15mMicros) / 10n +
    minBigInt(candidate.volume24hMicros, PUSD_SCALE) / 1_000n +
    minBigInt(candidate.liquidityMicros, PUSD_SCALE) / 1_000n;
  const features: OpportunityFeatures = {
    modelVersion: OPPORTUNITY_MODEL_VERSION,
    midPriceMicros,
    movement1mMicros,
    movement5mMicros,
    movement15mMicros,
    orderImbalanceMicros,
    spreadMicros: snapshot.spreadMicros,
    depthPusdMicros: snapshot.depthPusdMicrosAtLimit,
    volume24hMicros: candidate.volume24hMicros,
    liquidityMicros: candidate.liquidityMicros,
    netEdgeMicros,
    scoreMicros
  };
  if (netEdgeMicros < minEdgeMicros) {
    return { accepted: false, reason: "EDGE_TOO_SMALL", features, researchBundleId: researchBundle.id, estimatedProbabilityMicros: researchBundle.estimatedProbabilityMicros };
  }
  return { accepted: true, reason: null, features, researchBundleId: researchBundle.id, estimatedProbabilityMicros: researchBundle.estimatedProbabilityMicros };
}

function movementForWindow(
  current: SnapshotHistoryPoint,
  history: SnapshotHistoryPoint[],
  windowMs: number
): bigint | null {
  const targetMs = current.capturedAtMs - windowMs;
  const baseline = history.find((point) => point.capturedAtMs <= targetMs);
  if (baseline === undefined) {
    return null;
  }
  const baselineMid = midpoint(baseline.bestBidMicros, baseline.bestAskMicros);
  if (baselineMid <= 0n) {
    return null;
  }
  return ((midpoint(current.bestBidMicros, current.bestAskMicros) - baselineMid) * PUSD_SCALE) / baselineMid;
}

function midpoint(bidMicros: bigint, askMicros: bigint): bigint {
  return (bidMicros + askMicros) / 2n;
}

function sumDepth(levels: Array<{ sharesMicros: bigint }>): bigint {
  return levels.slice(0, 5).reduce((total, level) => total + level.sharesMicros, 0n);
}

function imbalance(bidDepthMicros: bigint, askDepthMicros: bigint): bigint {
  const total = bidDepthMicros + askDepthMicros;
  return total <= 0n ? 0n : ((bidDepthMicros - askDepthMicros) * PUSD_SCALE) / total;
}

function positive(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function rejected(
  reason: OpportunitySkipReason,
  bundle: ResearchBundle | null
): OpportunityDecision {
  return {
    accepted: false,
    reason,
    features: null,
    researchBundleId: bundle?.id ?? null,
    estimatedProbabilityMicros: bundle?.estimatedProbabilityMicros ?? null
  };
}
