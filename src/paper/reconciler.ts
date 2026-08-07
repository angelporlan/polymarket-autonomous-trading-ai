import {
  DEFAULT_RISK_POLICY,
  estimateTakerFeeMicros
} from "../domain/risk-policy.js";
import {
  hashCanonical,
  verifyProposalHash
} from "../domain/proposals.js";
import {
  PUSD_SCALE,
  multiplyMicros,
  type MarketSnapshot,
  type OrderProposal,
  type PaperTrade,
  type PaperExecutionEvidence,
  type PriceLevel
} from "../domain/types.js";
import type { TradingDatabase } from "../storage/database.js";
import {
  evaluatePaperGate,
  simulatePaperFill,
  type PaperGateMetrics,
  type PaperGateResult,
  type PaperFillModel
} from "./simulator.js";

export const PAPER_RECONCILIATION_VERSION = "paper-reconciliation-v1";

export interface PaperSnapshotSource {
  getMarketSnapshot(reference: {
    conditionId: string;
    tokenId: string;
    outcome: string;
  }): Promise<MarketSnapshot>;
}

export interface PaperPositionCheckpoint {
  tokenId: string;
  conditionId: string;
  outcome: string;
  sharesMicros: bigint;
  costBasisMicros: bigint;
  liquidationValueMicros: bigint;
  estimatedExitFeeMicros: bigint;
  unrealizedPnlMicros: bigint;
  snapshotHash: string;
  snapshotCapturedAtMs: number;
}

export interface PaperReconciliationCheckpoint {
  version: typeof PAPER_RECONCILIATION_VERSION;
  recordedAtMs: number;
  oldestSnapshotAtMs: number | null;
  firstFilledOperationAtMs: number | null;
  simulatedOrderCount: number;
  filledOperationCount: number;
  matchedSellOperationCount: number;
  expiredUnfilledOrderCount: number;
  realizedPnlMicros: bigint;
  unrealizedPnlMicros: bigint;
  netPnlMicros: bigint;
  totalFeesMicros: bigint;
  positions: PaperPositionCheckpoint[];
  tradeSetHash: string;
}

export type PaperReconciliationErrorCode =
  | "DUPLICATE_PROPOSAL_TRADE"
  | "INVALID_PROPOSAL"
  | "INVALID_RECORDED_FILL"
  | "UNMATCHED_SELL"
  | "SNAPSHOT_IDENTITY_MISMATCH"
  | "SNAPSHOT_MARKET_CHANGED"
  | "SNAPSHOT_INVALID";

export class PaperReconciliationError extends Error {
  readonly code: PaperReconciliationErrorCode;
  readonly subjectId: string | null;

  constructor(
    code: PaperReconciliationErrorCode,
    message: string,
    subjectId: string | null = null
  ) {
    super(message);
    this.name = "PaperReconciliationError";
    this.code = code;
    this.subjectId = subjectId;
  }
}

export interface VerifiedPaperFill {
  trade: PaperTrade;
  proposal: OrderProposal;
  notionalMicros: bigint;
}

type ValidatedFill = VerifiedPaperFill;

interface OpenLot {
  proposal: OrderProposal;
  remainingSharesMicros: bigint;
  remainingBasisMicros: bigint;
}

interface TokenLedger {
  conditionId: string;
  outcome: string;
  lots: OpenLot[];
}

/**
 * Rebuilds the paper portfolio from immutable proposals and deterministic
 * opening fills. It never accepts PnL, close prices, or settlement values from
 * a caller. Current valuations come exclusively from the configured market
 * data source.
 */
export class PaperReconciler {
  private readonly now: () => number;

  constructor(
    private readonly database: TradingDatabase,
    private readonly snapshots: PaperSnapshotSource,
    now: () => number = Date.now
  ) {
    this.now = now;
  }

  async reconcile(): Promise<PaperReconciliationCheckpoint> {
    const nowMs = this.now();
    try {
      const trades = this.database.listPaperTrades();
      const validated = this.validateTrades(trades);
      const expiredUnfilledOrderCount = this.expireUnfilledOrders(
        validated,
        nowMs
      );
      const derived = await this.deriveLedger(validated);
      const recordedAtMs = this.now();
      const checkpoint: PaperReconciliationCheckpoint = {
        version: PAPER_RECONCILIATION_VERSION,
        recordedAtMs,
        oldestSnapshotAtMs:
          derived.positions.length === 0
            ? null
            : Math.min(
                ...derived.positions.map((position) => position.snapshotCapturedAtMs)
              ),
        firstFilledOperationAtMs:
          validated.length === 0
            ? null
            : Math.min(...validated.map((entry) => entry.trade.openedAtMs)),
        simulatedOrderCount: trades.length,
        filledOperationCount: validated.length,
        matchedSellOperationCount: derived.matchedSellOperationCount,
        expiredUnfilledOrderCount,
        realizedPnlMicros: derived.realizedPnlMicros,
        unrealizedPnlMicros: derived.unrealizedPnlMicros,
        netPnlMicros:
          derived.realizedPnlMicros + derived.unrealizedPnlMicros,
        totalFeesMicros: validated.reduce(
          (total, entry) => total + entry.trade.feesMicros,
          0n
        ),
        positions: derived.positions,
        tradeSetHash: hashCanonical(
          validated.map((entry) => ({
            tradeId: entry.trade.id,
            proposalId: entry.proposal.id,
            proposalHash: entry.proposal.hash,
            filledSharesMicros: entry.trade.filledSharesMicros,
            averageFillPriceMicros: entry.trade.averageFillPriceMicros,
            feesMicros: entry.trade.feesMicros
          }))
        )
      };

      this.database.appendAudit(
        "PAPER_RECONCILIATION_CHECKPOINT",
        null,
        checkpoint
      );
      return checkpoint;
    } catch (error) {
      if (error instanceof PaperReconciliationError) {
        this.database.appendAudit(
          "PAPER_RECONCILIATION_ERROR",
          error.subjectId,
          { code: error.code }
        );
      } else {
        // A network/API failure must not create a usable checkpoint, but it is
        // kept separate from ledger corruption so a transient outage cannot be
        // mistaken for a successfully reconciled paper history.
        this.database.appendAudit("PAPER_RECONCILIATION_BLOCKED", null, {
          code: "MARKET_DATA_UNAVAILABLE"
        });
      }
      throw error;
    }
  }

  private validateTrades(trades: PaperTrade[]): ValidatedFill[] {
    const proposalIds = new Set<string>();
    const validated: ValidatedFill[] = [];

    for (const trade of trades) {
      if (proposalIds.has(trade.proposalId)) {
        throw new PaperReconciliationError(
          "DUPLICATE_PROPOSAL_TRADE",
          "A paper proposal has more than one trade record.",
          trade.proposalId
        );
      }
      proposalIds.add(trade.proposalId);

      const proposal = this.database.getProposal(trade.proposalId);
      if (proposal === null) {
        throw new PaperReconciliationError(
          "INVALID_PROPOSAL",
          "The paper trade is not backed by an intact simulated proposal.",
          trade.proposalId
        );
      }
      const verified = verifyPaperTradeAgainstProposal(trade, proposal);
      if (verified.trade.filledSharesMicros > 0n) {
        validated.push(verified);
      }
    }
    return validated;
  }

  private expireUnfilledOrders(
    validatedFills: ValidatedFill[],
    nowMs: number
  ): number {
    const filledIds = new Set(validatedFills.map((entry) => entry.trade.id));
    let expired = 0;
    for (const trade of this.database.listPaperTrades()) {
      if (filledIds.has(trade.id) || trade.status !== "OPEN") {
        continue;
      }
      const expiresAtMs =
        trade.openedAtMs + DEFAULT_RISK_POLICY.effectiveGtdMs;
      if (nowMs < expiresAtMs) {
        continue;
      }
      const cancelled: PaperTrade = {
        ...trade,
        status: "CANCELLED",
        closedAtMs: nowMs
      };
      this.database.savePaperTrade(cancelled);
      this.database.appendAudit("PAPER_ORDER_EXPIRED_UNFILLED", trade.id, {
        proposalId: trade.proposalId,
        expiredAtMs: nowMs
      });
      expired += 1;
    }
    return expired;
  }

  private async deriveLedger(
    entries: ValidatedFill[]
  ): Promise<{
    realizedPnlMicros: bigint;
    unrealizedPnlMicros: bigint;
    matchedSellOperationCount: number;
    positions: PaperPositionCheckpoint[];
  }> {
    const ledgers = new Map<string, TokenLedger>();
    let realizedPnlMicros = 0n;
    let matchedSellOperationCount = 0;

    for (const entry of [...entries].sort(compareEntries)) {
      const tokenId = entry.proposal.market.tokenId;
      const ledger = ledgers.get(tokenId) ?? {
        conditionId: entry.proposal.market.conditionId,
        outcome: entry.proposal.market.outcome,
        lots: []
      };
      if (
        ledger.conditionId !== entry.proposal.market.conditionId ||
        ledger.outcome !== entry.proposal.market.outcome
      ) {
        throw new PaperReconciliationError(
          "INVALID_PROPOSAL",
          "A token is associated with inconsistent market identity.",
          entry.proposal.id
        );
      }

      if (entry.proposal.side === "BUY") {
        ledger.lots.push({
          proposal: entry.proposal,
          remainingSharesMicros: entry.trade.filledSharesMicros,
          remainingBasisMicros:
            entry.notionalMicros + entry.trade.feesMicros
        });
      } else {
        let remainingToSell = entry.trade.filledSharesMicros;
        let matchedBasisMicros = 0n;
        for (const lot of ledger.lots) {
          if (remainingToSell === 0n) {
            break;
          }
          const consumedShares =
            lot.remainingSharesMicros < remainingToSell
              ? lot.remainingSharesMicros
              : remainingToSell;
          const consumedBasis =
            consumedShares === lot.remainingSharesMicros
              ? lot.remainingBasisMicros
              : ceilDivide(
                  lot.remainingBasisMicros * consumedShares,
                  lot.remainingSharesMicros
                );
          lot.remainingSharesMicros -= consumedShares;
          lot.remainingBasisMicros -= consumedBasis;
          remainingToSell -= consumedShares;
          matchedBasisMicros += consumedBasis;
        }
        if (remainingToSell !== 0n) {
          throw new PaperReconciliationError(
            "UNMATCHED_SELL",
            "A simulated sell exceeds the verified paper position.",
            entry.proposal.id
          );
        }
        realizedPnlMicros +=
          entry.notionalMicros -
          entry.trade.feesMicros -
          matchedBasisMicros;
        matchedSellOperationCount += 1;
      }
      ledgers.set(tokenId, ledger);
    }

    const openLedgers = [...ledgers.entries()].filter(([, ledger]) =>
      ledger.lots.some((lot) => lot.remainingSharesMicros > 0n)
    );
    const positions = await Promise.all(
      openLedgers.map(async ([tokenId, ledger]) => {
        const referenceLot = ledger.lots.find(
          (lot) => lot.remainingSharesMicros > 0n
        );
        if (referenceLot === undefined) {
          throw new PaperReconciliationError(
            "INVALID_RECORDED_FILL",
            "An open paper position has no verified source lot.",
            tokenId
          );
        }
        const snapshot = await this.snapshots.getMarketSnapshot({
          conditionId: ledger.conditionId,
          tokenId,
          outcome: ledger.outcome
        });
        validateValuationSnapshot(
          snapshot,
          referenceLot.proposal,
          this.now()
        );

        const sharesMicros = ledger.lots.reduce(
          (total, lot) => total + lot.remainingSharesMicros,
          0n
        );
        const costBasisMicros = ledger.lots.reduce(
          (total, lot) => total + lot.remainingBasisMicros,
          0n
        );
        const liquidation = consumeBook(
          [...snapshot.bids].sort((left, right) =>
            compareBigInt(right.priceMicros, left.priceMicros)
          ),
          sharesMicros
        );
        const liquidationAveragePriceMicros =
          liquidation.filledSharesMicros === 0n
            ? 0n
            : (liquidation.notionalMicros * PUSD_SCALE) /
              liquidation.filledSharesMicros;
        const estimatedExitFeeMicros = estimateTakerFeeMicros(
          liquidation.filledSharesMicros,
          liquidationAveragePriceMicros,
          snapshot.feeRateBps,
          snapshot.feeExponent ?? 1
        );
        const liquidationValueMicros =
          liquidation.notionalMicros - estimatedExitFeeMicros;

        return {
          tokenId,
          conditionId: ledger.conditionId,
          outcome: ledger.outcome,
          sharesMicros,
          costBasisMicros,
          liquidationValueMicros,
          estimatedExitFeeMicros,
          unrealizedPnlMicros: liquidationValueMicros - costBasisMicros,
          snapshotHash: hashCanonical(snapshot),
          snapshotCapturedAtMs: snapshot.capturedAtMs
        };
      })
    );

    return {
      realizedPnlMicros,
      unrealizedPnlMicros: positions.reduce(
        (total, position) => total + position.unrealizedPnlMicros,
        0n
      ),
      matchedSellOperationCount,
      positions
    };
  }
}

export function verifyPaperTradeAgainstProposal(
  trade: PaperTrade,
  proposal: OrderProposal
): VerifiedPaperFill {
  if (
    proposal.executionMode !== "paper" ||
    proposal.status !== "SIMULATED" ||
    trade.proposalId !== proposal.id ||
    !verifyProposalHash(proposal)
  ) {
    throw new PaperReconciliationError(
      "INVALID_PROPOSAL",
      "The paper trade is not backed by an intact simulated proposal.",
      trade.proposalId
    );
  }

  let expected: {
    filledSharesMicros: bigint;
    notionalMicros: bigint;
    averageFillPriceMicros: bigint | null;
    feesMicros: bigint;
  };
  let simulationValid = true;
  if (trade.simulation === undefined) {
    expected = deterministicOpeningFill(proposal);
  } else {
    try {
      const model = modelFromEvidence(trade.simulation);
      const calculation = simulatePaperFill(
        proposal,
        proposal.market,
        model
      );
      expected = calculation;
      simulationValid = sameSimulationEvidence(
        trade.simulation,
        calculation.evidence
      );
    } catch {
      throw new PaperReconciliationError(
        "INVALID_RECORDED_FILL",
        "The stored paper simulation evidence is malformed.",
        trade.id
      );
    }
  }
  const statusValid =
    expected.filledSharesMicros === 0n
      ? trade.status === "OPEN" || trade.status === "CANCELLED"
      : trade.status === "FILLED";
  const timingValid =
    Number.isSafeInteger(trade.openedAtMs) &&
    trade.openedAtMs >= proposal.createdAtMs &&
    trade.openedAtMs <=
      proposal.createdAtMs + DEFAULT_RISK_POLICY.proposalTtlMs;
  const closedAtValid =
    trade.status === "CANCELLED"
      ? trade.closedAtMs !== null &&
        trade.closedAtMs >=
          trade.openedAtMs + DEFAULT_RISK_POLICY.effectiveGtdMs
      : trade.closedAtMs === null;

  if (
    !simulationValid ||
    !statusValid ||
    !timingValid ||
    !closedAtValid ||
    trade.filledSharesMicros !== expected.filledSharesMicros ||
    trade.averageFillPriceMicros !== expected.averageFillPriceMicros ||
    trade.feesMicros !== expected.feesMicros ||
    trade.realizedPnlMicros !== 0n
  ) {
    throw new PaperReconciliationError(
      "INVALID_RECORDED_FILL",
      "The stored paper fill differs from the deterministic opening book.",
      trade.id
    );
  }

  return {
    trade,
    proposal,
    notionalMicros: expected.notionalMicros
  };
}

function modelFromEvidence(evidence: PaperExecutionEvidence): PaperFillModel {
  if (evidence.modelVersion !== "paper-fill-v1") {
    throw new Error("Unsupported paper fill model.");
  }
  return {
    fillProbabilityBps: evidence.fillProbabilityBps,
    slippageBps: evidence.slippageBps,
    seed: evidence.seed
  };
}

function sameSimulationEvidence(
  actual: PaperExecutionEvidence,
  expected: PaperExecutionEvidence
): boolean {
  return (
    actual.modelVersion === expected.modelVersion &&
    actual.snapshotHash === expected.snapshotHash &&
    actual.snapshotCapturedAtMs === expected.snapshotCapturedAtMs &&
    actual.fillProbabilityBps === expected.fillProbabilityBps &&
    actual.drawBps === expected.drawBps &&
    actual.slippageBps === expected.slippageBps &&
    actual.slippageMicros === expected.slippageMicros &&
    actual.seed === expected.seed
  );
}

/**
 * Paper gate backed by fresh reconciliations rather than mutable fields on
 * `PaperTrade`. Concurrent callers share the same reconciliation and a
 * checkpoint is reused only while its market snapshots remain fresh.
 */
export class ReconciledPaperGate {
  private inFlight: Promise<PaperReconciliationCheckpoint> | null = null;
  private inFlightFingerprint: string | null = null;
  private lastCheckpoint: PaperReconciliationCheckpoint | null = null;
  private lastLedgerFingerprint: string | null = null;

  constructor(
    private readonly database: TradingDatabase,
    private readonly reconciler: PaperReconciler,
    private readonly now: () => number = Date.now
  ) {}

  async metrics(): Promise<PaperGateMetrics> {
    await this.ensureFreshCheckpoint();
    const checkpoints = this.database
      .listAuditEvents()
      .filter(
        (event) => event.eventType === "PAPER_RECONCILIATION_CHECKPOINT"
      )
      .map((event) => event.payload)
      .filter(isPaperReconciliationCheckpoint);
    const latest = checkpoints.at(-1);
    let peakEquityMicros = 0n;
    let maxDrawdownMicros = 0n;
    for (const checkpoint of checkpoints) {
      if (checkpoint.netPnlMicros > peakEquityMicros) {
        peakEquityMicros = checkpoint.netPnlMicros;
      }
      const drawdownMicros =
        peakEquityMicros - checkpoint.netPnlMicros;
      if (drawdownMicros > maxDrawdownMicros) {
        maxDrawdownMicros = drawdownMicros;
      }
    }

    return {
      firstTradeAtMs: latest?.firstFilledOperationAtMs ?? null,
      totalTrades: latest?.filledOperationCount ?? 0,
      closedTrades: latest?.matchedSellOperationCount ?? 0,
      netPnlMicros: latest?.netPnlMicros ?? 0n,
      maxDrawdownMicros,
      riskViolations: this.database.countAuditEvents(
        "PAPER_RISK_VIOLATION"
      ),
      reconciliationErrors:
        this.database.countAuditEvents("PAPER_RECONCILIATION_ERROR") +
        (this.database.verifyAuditChain() ? 0 : 1)
    };
  }

  async result(skipPaperGate: boolean = false): Promise<PaperGateResult> {
    return evaluatePaperGate(await this.metrics(), this.now(), skipPaperGate);
  }

  private async ensureFreshCheckpoint(): Promise<void> {
    for (;;) {
      const nowMs = this.now();
      const ledgerFingerprint = this.paperLedgerFingerprint();
      if (
        this.lastCheckpoint !== null &&
        this.lastLedgerFingerprint === ledgerFingerprint &&
        nowMs >= this.lastCheckpoint.recordedAtMs &&
        nowMs - this.lastCheckpoint.recordedAtMs <=
          DEFAULT_RISK_POLICY.maxSnapshotAgeMs
      ) {
        return;
      }
      if (this.inFlight === null) {
        this.inFlightFingerprint = ledgerFingerprint;
        this.inFlight = this.reconciler.reconcile();
      }
      const operation = this.inFlight;
      const operationFingerprint = this.inFlightFingerprint;
      try {
        this.lastCheckpoint = await operation;
        this.lastLedgerFingerprint = operationFingerprint;
      } finally {
        if (this.inFlight === operation) {
          this.inFlight = null;
          this.inFlightFingerprint = null;
        }
      }
      if (this.lastLedgerFingerprint === this.paperLedgerFingerprint()) {
        return;
      }
    }
  }

  private paperLedgerFingerprint(): string {
    return hashCanonical(
      this.database.listPaperTrades().map((trade) => ({
        trade,
        proposal: this.database.getProposal(trade.proposalId)
      }))
    );
  }
}

function deterministicOpeningFill(proposal: OrderProposal): {
  filledSharesMicros: bigint;
  notionalMicros: bigint;
  averageFillPriceMicros: bigint | null;
  feesMicros: bigint;
} {
  const levels =
    proposal.side === "BUY"
      ? proposal.market.asks.filter(
          (level) => level.priceMicros <= proposal.limitPriceMicros
        )
      : proposal.market.bids.filter(
          (level) => level.priceMicros >= proposal.limitPriceMicros
        );
  const sorted = [...levels].sort((left, right) =>
    proposal.side === "BUY"
      ? compareBigInt(left.priceMicros, right.priceMicros)
      : compareBigInt(right.priceMicros, left.priceMicros)
  );
  const fill = consumeBook(sorted, proposal.sharesMicros);
  return {
    ...fill,
    averageFillPriceMicros:
      fill.filledSharesMicros === 0n
        ? null
        : (fill.notionalMicros * PUSD_SCALE) / fill.filledSharesMicros,
    feesMicros:
      fill.filledSharesMicros === 0n
        ? 0n
        : estimateTakerFeeMicros(
            fill.filledSharesMicros,
            (fill.notionalMicros * PUSD_SCALE) /
              fill.filledSharesMicros,
            proposal.market.feeRateBps,
            proposal.market.feeExponent ?? 1
          )
  };
}

function isPaperReconciliationCheckpoint(
  value: unknown
): value is PaperReconciliationCheckpoint {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const checkpoint = value as Partial<PaperReconciliationCheckpoint>;
  return (
    checkpoint.version === PAPER_RECONCILIATION_VERSION &&
    typeof checkpoint.recordedAtMs === "number" &&
    Number.isSafeInteger(checkpoint.recordedAtMs) &&
    (checkpoint.firstFilledOperationAtMs === null ||
      (typeof checkpoint.firstFilledOperationAtMs === "number" &&
        Number.isSafeInteger(checkpoint.firstFilledOperationAtMs))) &&
    typeof checkpoint.filledOperationCount === "number" &&
    Number.isSafeInteger(checkpoint.filledOperationCount) &&
    checkpoint.filledOperationCount >= 0 &&
    typeof checkpoint.matchedSellOperationCount === "number" &&
    Number.isSafeInteger(checkpoint.matchedSellOperationCount) &&
    checkpoint.matchedSellOperationCount >= 0 &&
    typeof checkpoint.netPnlMicros === "bigint"
  );
}

function validateValuationSnapshot(
  snapshot: MarketSnapshot,
  proposal: OrderProposal,
  nowMs: number
): void {
  if (
    snapshot.conditionId !== proposal.market.conditionId ||
    snapshot.tokenId !== proposal.market.tokenId ||
    snapshot.outcome !== proposal.market.outcome
  ) {
    throw new PaperReconciliationError(
      "SNAPSHOT_IDENTITY_MISMATCH",
      "The valuation snapshot does not match the immutable proposal identity.",
      proposal.id
    );
  }
  if (
    snapshot.rules !== proposal.market.rules ||
    snapshot.resolutionSource !== proposal.market.resolutionSource ||
    snapshot.tickSizeMicros !== proposal.market.tickSizeMicros ||
    snapshot.negRisk !== proposal.market.negRisk
  ) {
    throw new PaperReconciliationError(
      "SNAPSHOT_MARKET_CHANGED",
      "Rules, resolution source, tick size, or negRisk changed.",
      proposal.id
    );
  }
  if (
    !Number.isSafeInteger(snapshot.capturedAtMs) ||
    snapshot.capturedAtMs > nowMs + 1_000 ||
    nowMs - snapshot.capturedAtMs > DEFAULT_RISK_POLICY.maxSnapshotAgeMs ||
    snapshot.feeRateBps < 0 ||
    !Number.isSafeInteger(snapshot.feeRateBps) ||
    snapshot.tickSizeMicros <= 0n ||
    snapshot.bestBidMicros < 0n ||
    snapshot.bestAskMicros > PUSD_SCALE ||
    snapshot.bestBidMicros > snapshot.bestAskMicros ||
    snapshot.spreadMicros !==
      snapshot.bestAskMicros - snapshot.bestBidMicros ||
    !validBook(snapshot.bids) ||
    !validBook(snapshot.asks)
  ) {
    throw new PaperReconciliationError(
      "SNAPSHOT_INVALID",
      "The valuation snapshot is stale, malformed, or internally inconsistent.",
      proposal.id
    );
  }
}

function validBook(levels: PriceLevel[]): boolean {
  return levels.every(
    (level) =>
      level.priceMicros >= 0n &&
      level.priceMicros <= PUSD_SCALE &&
      level.sharesMicros > 0n
  );
}

function consumeBook(
  levels: PriceLevel[],
  requestedSharesMicros: bigint
): { filledSharesMicros: bigint; notionalMicros: bigint } {
  let remaining = requestedSharesMicros;
  let filledSharesMicros = 0n;
  let notionalMicros = 0n;
  for (const level of levels) {
    if (remaining === 0n) {
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

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("Invalid paper position denominator.");
  }
  return (numerator + denominator - 1n) / denominator;
}

function compareEntries(left: ValidatedFill, right: ValidatedFill): number {
  return (
    left.trade.openedAtMs - right.trade.openedAtMs ||
    left.trade.id.localeCompare(right.trade.id)
  );
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
