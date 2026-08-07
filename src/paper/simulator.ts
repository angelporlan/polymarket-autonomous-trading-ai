import { randomUUID } from "node:crypto";
import type {
  MarketSnapshot,
  OrderProposal,
  PaperExecutionEvidence,
  PaperTrade,
  PriceLevel
} from "../domain/types.js";
import { multiplyMicros, PUSD_SCALE } from "../domain/types.js";
import { estimateTakerFeeMicros } from "../domain/risk-policy.js";
import { hashCanonical } from "../domain/proposals.js";

export const PAPER_FILL_MODEL_VERSION = "paper-fill-v1" as const;

export interface PaperFillModel {
  fillProbabilityBps: number;
  slippageBps: number;
  seed: string;
}

export const DEFAULT_PAPER_FILL_MODEL: PaperFillModel = Object.freeze({
  fillProbabilityBps: 10_000,
  slippageBps: 0,
  seed: "stage-order-default"
});

export interface PaperFillCalculation {
  filledSharesMicros: bigint;
  notionalMicros: bigint;
  averageFillPriceMicros: bigint | null;
  feesMicros: bigint;
  evidence: PaperExecutionEvidence;
}

export interface PaperGateMetrics {
  firstTradeAtMs: number | null;
  totalTrades: number;
  closedTrades: number;
  netPnlMicros: bigint;
  maxDrawdownMicros: bigint;
  riskViolations: number;
  reconciliationErrors: number;
}

export interface PaperGateResult {
  passed: boolean;
  reasons: string[];
  /** True only when the explicit PAPER_GATE_SKIP override was applied. */
  skipped?: boolean;
}

export class PaperSimulator {
  constructor(private readonly now: () => number = Date.now) {}

  tryImmediateFill(proposal: OrderProposal, snapshot: MarketSnapshot): PaperTrade {
    return this.simulate(
      proposal,
      snapshot,
      DEFAULT_PAPER_FILL_MODEL
    );
  }

  simulate(
    proposal: OrderProposal,
    snapshot: MarketSnapshot,
    model: PaperFillModel = DEFAULT_PAPER_FILL_MODEL,
    tradeId: string = randomUUID(),
    openedAtMs = this.now()
  ): PaperTrade {
    const calculation = simulatePaperFill(
      proposal,
      snapshot,
      model
    );

    return {
      id: tradeId,
      proposalId: proposal.id,
      status: calculation.filledSharesMicros > 0n ? "FILLED" : "OPEN",
      filledSharesMicros: calculation.filledSharesMicros,
      averageFillPriceMicros: calculation.averageFillPriceMicros,
      feesMicros: calculation.feesMicros,
      realizedPnlMicros: 0n,
      openedAtMs,
      closedAtMs: null,
      simulation: calculation.evidence
    };
  }

  markToMarket(trade: PaperTrade, currentPriceMicros: bigint, side: "BUY" | "SELL"): bigint {
    if (trade.averageFillPriceMicros === null) {
      return 0n;
    }
    const priceDelta =
      side === "BUY"
        ? currentPriceMicros - trade.averageFillPriceMicros
        : trade.averageFillPriceMicros - currentPriceMicros;
    return multiplyMicros(priceDelta, trade.filledSharesMicros) - trade.feesMicros;
  }
}

export function simulatePaperFill(
  proposal: OrderProposal,
  snapshot: MarketSnapshot,
  model: PaperFillModel = DEFAULT_PAPER_FILL_MODEL
): PaperFillCalculation {
  validatePaperFillModel(model);
  assertSnapshotMatchesProposal(proposal, snapshot);

  const snapshotHash = hashCanonical(snapshot);
  const drawBps = deterministicDrawBps({
    proposalId: proposal.id,
    snapshotHash,
    seed: model.seed
  });
  const levels =
    proposal.side === "BUY"
      ? snapshot.asks.filter(
          (level) => level.priceMicros <= proposal.limitPriceMicros
        )
      : snapshot.bids.filter(
          (level) => level.priceMicros >= proposal.limitPriceMicros
        );
  const sorted = [...levels].sort((left, right) =>
    proposal.side === "BUY"
      ? compareBigInt(left.priceMicros, right.priceMicros)
      : compareBigInt(right.priceMicros, left.priceMicros)
  );
  const fill = consumeLevels(sorted, proposal.sharesMicros);
  const baseAverageFillPriceMicros =
    fill.filledSharesMicros > 0n
      ? (fill.notionalMicros * PUSD_SCALE) / fill.filledSharesMicros
      : null;

  let filledSharesMicros = 0n;
  let notionalMicros = 0n;
  let averageFillPriceMicros: bigint | null = null;
  let feesMicros = 0n;
  let slippageMicros = 0n;
  if (
    drawBps < model.fillProbabilityBps &&
    baseAverageFillPriceMicros !== null
  ) {
    slippageMicros = ceilDivide(
      baseAverageFillPriceMicros * BigInt(model.slippageBps),
      10_000n
    );
    const adjustedPriceMicros =
      proposal.side === "BUY"
        ? baseAverageFillPriceMicros + slippageMicros
        : baseAverageFillPriceMicros - slippageMicros;
    const withinLimit =
      adjustedPriceMicros > 0n &&
      adjustedPriceMicros <= PUSD_SCALE &&
      (proposal.side === "BUY"
        ? adjustedPriceMicros <= proposal.limitPriceMicros
        : adjustedPriceMicros >= proposal.limitPriceMicros);
    if (withinLimit) {
      filledSharesMicros = fill.filledSharesMicros;
      averageFillPriceMicros = adjustedPriceMicros;
      notionalMicros = multiplyMicros(
        averageFillPriceMicros,
        filledSharesMicros
      );
      feesMicros = estimateTakerFeeMicros(
        filledSharesMicros,
        averageFillPriceMicros,
        snapshot.feeRateBps,
        snapshot.feeExponent ?? 1
      );
    } else {
      slippageMicros = 0n;
    }
  }

  return {
    filledSharesMicros,
    notionalMicros,
    averageFillPriceMicros,
    feesMicros,
    evidence: {
      modelVersion: PAPER_FILL_MODEL_VERSION,
      snapshotHash,
      snapshotCapturedAtMs: snapshot.capturedAtMs,
      fillProbabilityBps: model.fillProbabilityBps,
      drawBps,
      slippageBps: model.slippageBps,
      slippageMicros,
      seed: model.seed
    }
  };
}

export function evaluatePaperGate(
  metrics: PaperGateMetrics,
  nowMs = Date.now(),
  skipPaperGate = false
): PaperGateResult {
  const reasons: string[] = [];
  let hardFailure = false;
  const thirtyDaysMs = 30 * 24 * 60 * 60_000;
  if (
    metrics.firstTradeAtMs === null ||
    nowMs - metrics.firstTradeAtMs < thirtyDaysMs
  ) {
    reasons.push("The paper phase has not run for 30 days.");
  }
  if (metrics.totalTrades < 50) {
    reasons.push("Fewer than 50 paper trades have been recorded.");
  }
  if (metrics.netPnlMicros <= 0n) {
    reasons.push("Net paper PnL is not positive.");
  }
  if (metrics.maxDrawdownMicros > 10n * PUSD_SCALE) {
    reasons.push("Paper drawdown exceeds 10 pUSD.");
  }
  if (metrics.riskViolations !== 0) {
    reasons.push("Risk violations were recorded during paper trading.");
    hardFailure = true;
  }
  if (metrics.reconciliationErrors !== 0) {
    reasons.push("Paper ledger reconciliation errors remain.");
    hardFailure = true;
  }
  if (skipPaperGate) {
    return {
      passed: true,
      skipped: true,
      reasons: ["PAPER_GATE_SKIPPED", ...reasons]
    };
  }
  return { passed: reasons.length === 0, reasons };
}

function consumeLevels(
  levels: PriceLevel[],
  requestedSharesMicros: bigint
): { filledSharesMicros: bigint; notionalMicros: bigint } {
  let remaining = requestedSharesMicros;
  let filledSharesMicros = 0n;
  let notionalMicros = 0n;
  for (const level of levels) {
    if (remaining <= 0n) {
      break;
    }
    const filledAtLevel =
      level.sharesMicros < remaining ? level.sharesMicros : remaining;
    filledSharesMicros += filledAtLevel;
    notionalMicros += multiplyMicros(level.priceMicros, filledAtLevel);
    remaining -= filledAtLevel;
  }
  return { filledSharesMicros, notionalMicros };
}

function validatePaperFillModel(model: PaperFillModel): void {
  if (
    !Number.isSafeInteger(model.fillProbabilityBps) ||
    model.fillProbabilityBps < 0 ||
    model.fillProbabilityBps > 10_000 ||
    !Number.isSafeInteger(model.slippageBps) ||
    model.slippageBps < 0 ||
    model.slippageBps > 10_000 ||
    typeof model.seed !== "string" ||
    model.seed.length === 0 ||
    model.seed.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(model.seed)
  ) {
    throw new Error("The paper fill model is invalid.");
  }
}

function assertSnapshotMatchesProposal(
  proposal: OrderProposal,
  snapshot: MarketSnapshot
): void {
  if (
    proposal.executionMode !== "paper" ||
    proposal.market.conditionId !== snapshot.conditionId ||
    proposal.market.tokenId !== snapshot.tokenId ||
    proposal.market.outcome !== snapshot.outcome ||
    proposal.market.rules !== snapshot.rules ||
    proposal.market.resolutionSource !== snapshot.resolutionSource ||
    proposal.market.tickSizeMicros !== snapshot.tickSizeMicros ||
    proposal.market.minOrderSizeMicros !== snapshot.minOrderSizeMicros ||
    proposal.market.negRisk !== snapshot.negRisk ||
    proposal.market.feeRateBps !== snapshot.feeRateBps ||
    (proposal.market.feeExponent ?? 1) !== (snapshot.feeExponent ?? 1) ||
    (proposal.market.feesTakerOnly ?? true) !==
      (snapshot.feesTakerOnly ?? true)
  ) {
    throw new Error("The paper snapshot does not match the proposal.");
  }
}

function deterministicDrawBps(input: {
  proposalId: string;
  snapshotHash: string;
  seed: string;
}): number {
  const digest = hashCanonical(input);
  return Number.parseInt(digest.slice(0, 8), 16) % 10_000;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n
    ? 0n
    : (numerator + denominator - 1n) / denominator;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
