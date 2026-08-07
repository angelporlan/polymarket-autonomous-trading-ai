import type {
  CandidateMarket,
  ExecutionMode,
  MarketCategory,
  MarketSnapshot,
  OrderProposal,
  OrderSide,
  PaperTrade,
  PortfolioSnapshot,
  RiskContext,
  UserTradeActivity
} from "../domain/types.js";
import type { PaperGateMetrics, PaperGateResult } from "../paper/simulator.js";

export interface AccountStatus {
  configuredProfileAddress: string;
  profileExists: boolean;
  signerConfigured: boolean;
  signerAddress: string | null;
  signatureType: 1 | 3 | null;
  funderAddress: string | null;
  mode: "read_only" | "paper" | "live_locked" | "live_ready";
  emergencyStopped: boolean;
  liveEnvironmentEnabled: boolean;
  localLiveActivation: boolean;
  paperGatePassed: boolean;
}

export interface MarketReference {
  conditionId: string;
  tokenId: string;
  outcome: string;
  side?: OrderSide;
  limitPriceMicros?: bigint;
}

export interface MarketDataPort {
  profileExists(profileAddress: string): Promise<boolean>;
  getPortfolio(profileAddress: string): Promise<PortfolioSnapshot>;
  getUserActivity(
    profileAddress: string,
    sinceMs: number
  ): Promise<UserTradeActivity[]>;
  scanCandidates(categories: MarketCategory[]): Promise<CandidateMarket[]>;
  getMarketSnapshot(reference: MarketReference): Promise<MarketSnapshot>;
  checkGeoblock(): Promise<{
    blocked: boolean;
    country: string;
    region: string;
    checkedAtMs: number;
  }>;
}

export interface AccountBindingPort {
  signerConfigured(): Promise<boolean>;
  signerAddress(): Promise<string | null>;
  signatureType(): Promise<1 | 3 | null>;
  funderAddress(): Promise<string | null>;
}

export interface RiskContextPort {
  forOrder(
    snapshot: MarketSnapshot,
    side: OrderSide,
    correlationKey: string,
    executionMode: ExecutionMode,
    excludeProposalId?: string
  ): Promise<RiskContext>;
  summary(): Promise<{
    dailyPnlMicros: bigint;
    dailyPnlKnown: boolean;
    totalOpenExposureMicros: bigint;
    openMarketCount: number;
    liveTradeCount: number;
    emergencyStopped: boolean;
    coolingDownUntilMs: number | null;
  }>;
}

export interface PaperGatePort {
  metrics(): Promise<PaperGateMetrics>;
  result(skipPaperGate?: boolean): Promise<PaperGateResult>;
}

export interface LiveOrderResult {
  orderId: string | null;
  status: string;
  response: Record<string, unknown>;
}

export interface LiveTradingPort {
  configured(): Promise<boolean>;
  submitGtd(
    proposal: OrderProposal,
    finalPreflight: () => Promise<void>
  ): Promise<LiveOrderResult>;
  cancelOrder(orderId: string): Promise<Record<string, unknown>>;
  cancelAll(): Promise<Record<string, unknown>>;
  getOrderStatus(orderId: string): Promise<Record<string, unknown> | null>;
  getOpenOrders(): Promise<Array<Record<string, unknown>>>;
  getTrades(tradeIds: string[]): Promise<Array<Record<string, unknown>>>;
  startHeartbeat(): Promise<void>;
  stopHeartbeat(): Promise<void>;
}

export interface OnchainSettlementResult {
  finalized: boolean;
  filledSharesMicros: bigint;
  grossCostMicros: bigint;
  feeMicros: bigint;
  transactionHashes: string[];
  blockNumbers: bigint[];
  blockHashes: string[];
  blockTimestampsMs: number[];
}

export interface OnchainSettlementPort {
  verifySettlement(input: {
    proposal: OrderProposal;
    orderId: string;
    makerAddress: string;
    sizeMatchedMicros: bigint;
    expirationEpochSeconds: number;
    transactions: Array<{
      transactionHash: string;
      role: "TAKER" | "MAKER";
      sharesMicros: bigint;
      matchTimeMs: number;
    }>;
  }): Promise<OnchainSettlementResult>;
}

export interface ApprovalUrlPort {
  approvalUrl(proposalId: string): string;
}

export interface StageOrderInput {
  executionMode: "paper" | "live";
  conditionId: string;
  tokenId: string;
  outcome: string;
  side: OrderSide;
  shares: string;
  limitPrice: string;
  estimatedProbability: string;
  thesis: string;
  counterThesis: string;
  sources: Array<{
    url: string;
    title: string;
    publishedAt: string | null;
    retrievedAt: string;
    primary: boolean;
  }>;
}

export interface StageOrderResult {
  proposal: OrderProposal;
  paperTrade: PaperTrade | null;
}
