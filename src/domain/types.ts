export const PUSD_SCALE = 1_000_000n;

export type MarketCategory = "politics" | "economics" | "technology";
export type OrderSide = "BUY" | "SELL";
export type ExecutionMode = "paper" | "live";
export type ProposalStatus =
  | "STAGED"
  | "SIMULATED"
  | "AWAITING_LOCAL"
  | "LOCALLY_APPROVED"
  | "EXECUTING"
  | "SUBMITTED"
  | "CANCELLED"
  | "EXPIRED"
  | "REJECTED";

export interface PriceLevel {
  priceMicros: bigint;
  sharesMicros: bigint;
}

export interface MarketSnapshot {
  conditionId: string;
  tokenId: string;
  eventId: string | null;
  question: string;
  slug: string;
  outcome: string;
  category: MarketCategory;
  rules: string;
  resolutionSource: string;
  endTimeMs: number;
  active: boolean;
  closed: boolean;
    acceptingOrders: boolean;
    negRisk: boolean;
    tickSizeMicros: bigint;
    minOrderSizeMicros: bigint;
    feesEnabled: boolean;
    feeRateBps: number;
  feeExponent?: number;
  feesTakerOnly?: boolean;
  bestBidMicros: bigint;
  bestAskMicros: bigint;
  spreadMicros: bigint;
  depthPusdMicrosAtLimit: bigint;
  bids: PriceLevel[];
  asks: PriceLevel[];
  capturedAtMs: number;
}

export interface EvidenceSource {
  url: string;
  title: string;
  publishedAt: string | null;
  retrievedAt: string;
  primary: boolean;
}

export interface OrderIntent {
  executionMode: ExecutionMode;
  market: MarketSnapshot;
  side: OrderSide;
  sharesMicros: bigint;
  limitPriceMicros: bigint;
  estimatedProbabilityMicros: bigint;
  thesis: string;
  counterThesis: string;
  sources: EvidenceSource[];
  correlationKey: string;
  intent?: "ENTRY" | "EXIT";
}

export interface RiskContext {
  nowMs: number;
  liveTradeCount: number;
  dailyPnlMicros: bigint;
  dailyPnlKnown?: boolean;
  totalOpenExposureMicros: bigint;
  marketExposureMicros: bigint;
  correlatedExposureMicros: bigint;
  openMarketCount: number;
  heldSharesMicros: bigint;
  emergencyStopped: boolean;
  coolingDownUntilMs?: number | null;
}

export interface RiskViolation {
  code:
    | "EMERGENCY_STOPPED"
    | "CATEGORY_NOT_ALLOWED"
    | "MARKET_NOT_TRADEABLE"
    | "RULES_INCOMPLETE"
    | "SNAPSHOT_STALE"
    | "CLOSE_TOO_SOON"
    | "INVALID_TICK"
    | "ORDER_BELOW_MARKET_MINIMUM"
    | "ORDER_TOO_LARGE"
    | "MARKET_EXPOSURE"
    | "TOTAL_EXPOSURE"
    | "TOO_MANY_MARKETS"
    | "DAILY_STOP"
    | "DAILY_PNL_UNAVAILABLE"
    | "CORRELATION_ID_UNAVAILABLE"
    | "COOLING_DOWN"
    | "EDGE_TOO_SMALL"
    | "SPREAD_TOO_WIDE"
    | "INSUFFICIENT_DEPTH"
    | "SELL_EXCEEDS_POSITION"
    | "HARD_CEILING_EXCEEDED"
    | "DAILY_STOP_EXCEEDS_HARD_LIMIT"
    | "SOURCE_VALIDATION_FAILED"
    | "SESSION_BUDGET_EXCEEDED"
    | "SESSION_INACTIVE"
    | "INVALID_VALUE";
  message: string;
}

export interface OrderProposal {
  id: string;
  hash: string;
  status: ProposalStatus;
  createdAtMs: number;
  expiresAtMs: number;
  executionMode: ExecutionMode;
  market: MarketSnapshot;
  side: OrderSide;
  sharesMicros: bigint;
  limitPriceMicros: bigint;
  maxCostMicros: bigint;
  maxLossMicros: bigint;
  estimatedFeeMicros: bigint;
  estimatedProbabilityMicros: bigint;
  expectedEdgeMicros: bigint;
  postTradeMarketExposureMicros: bigint;
  postTradeTotalExposureMicros: bigint;
  thesis: string;
  counterThesis: string;
  sources: EvidenceSource[];
  correlationKey: string;
  policyVersion: string;
  intent?: "ENTRY" | "EXIT";
}

export type ExitState =
  | "HOLDING"
  | "STOP_LOSS_TRIGGERED"
  | "TAKE_PROFIT_TRIGGERED"
  | "MAX_DURATION_EXPIRED"
  | "EDGE_DISAPPEARED"
  | "REVALUATION_TRIGGERED"
  | "HOLD_UNTIL_RESOLUTION"
  | "LEGACY_UNVERIFIED"
  | "CLOSING"
  | "CLOSED";

export interface PositionRecord {
  tokenId: string;
  conditionId: string;
  question: string;
  outcome: string;
  side: OrderSide;
  sharesMicros: bigint;
  averagePriceMicros: bigint;
  entryEdgeMicros: bigint;
  openedAtMs: number;
  lastEvaluatedAtMs: number;
  lastProbabilityMicros: bigint;
  sourcesJson: string;
  exitState: ExitState;
}

export interface LocalApproval {
  proposalId: string;
  proposalHash: string;
  approvedAtMs: number;
  expiresAtMs: number;
  nonceHash: string;
  consumedAtMs: number | null;
}

export interface ExecutionRecord {
  proposalId: string;
  proposalHash: string;
  clobOrderId: string | null;
  status: string;
  submittedAtMs: number;
  responseJson: string;
}

export interface PortfolioPosition {
  tokenId: string;
  conditionId: string;
  question: string;
  outcome: string;
  sizeMicros: bigint;
  averagePriceMicros: bigint;
  currentPriceMicros: bigint;
  currentValueMicros: bigint;
  cashPnlMicros: bigint;
  realizedPnlMicros: bigint;
  endTimeMs: number;
}

export interface PortfolioSnapshot {
  profileAddress: string;
  pUsdBalanceMicros: bigint | null;
  totalPositionValueMicros: bigint;
  totalPnlMicros: bigint;
  positions: PortfolioPosition[];
  capturedAtMs: number;
  source: "public" | "authenticated";
}

export interface UserTradeActivity {
  profileAddress: string;
  transactionHash: string;
  conditionId: string;
  tokenId: string;
  side: OrderSide;
  timestampMs: number;
  sizeMicros: bigint;
  priceMicros: bigint;
  notionalMicros: bigint;
}

export interface CandidateMarket {
  conditionId: string;
  slug: string;
  question: string;
  category: MarketCategory;
  endTimeMs: number;
  volume24hMicros: bigint;
  liquidityMicros: bigint;
  spreadMicros: bigint | null;
  tokenIds: string[];
  active: boolean;
  acceptingOrders: boolean;
}

export interface PaperTrade {
  id: string;
  proposalId: string;
  status: "OPEN" | "FILLED" | "CANCELLED" | "CLOSED";
  filledSharesMicros: bigint;
  averageFillPriceMicros: bigint | null;
  feesMicros: bigint;
  realizedPnlMicros: bigint;
  openedAtMs: number;
  closedAtMs: number | null;
  simulation?: PaperExecutionEvidence;
}

export interface PaperExecutionEvidence {
  modelVersion: "paper-fill-v1";
  snapshotHash: string;
  snapshotCapturedAtMs: number;
  fillProbabilityBps: number;
  drawBps: number;
  slippageBps: number;
  slippageMicros: bigint;
  seed: string;
}

export function parseDecimalToMicros(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }

  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * PUSD_SCALE + BigInt(fraction.padEnd(6, "0"));
}

export function formatMicros(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / PUSD_SCALE;
  const fraction = (absolute % PUSD_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  const formatted = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${formatted}` : formatted;
}

export function multiplyMicros(left: bigint, right: bigint): bigint {
  return (left * right + PUSD_SCALE - 1n) / PUSD_SCALE;
}

export function canonicalCorrelationKey(
  market: Pick<MarketSnapshot, "eventId" | "conditionId">
): string {
  const eventId = market.eventId?.trim().toLowerCase();
  return eventId
    ? `event:${eventId}`
    : `market:${market.conditionId.trim().toLowerCase()}`;
}
