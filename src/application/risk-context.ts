import { DEFAULT_RISK_POLICY } from "../domain/risk-policy.js";
import type {
  ExecutionMode,
  MarketSnapshot,
  OrderProposal,
  OrderSide,
  PortfolioSnapshot,
  RiskContext
} from "../domain/types.js";
import { canonicalCorrelationKey } from "../domain/types.js";
import { verifyProposalHash } from "../domain/proposals.js";
import {
  PAPER_RECONCILIATION_VERSION,
  verifyPaperTradeAgainstProposal,
  type PaperReconciliationCheckpoint
} from "../paper/reconciler.js";
import type { TradingDatabase } from "../storage/database.js";
import type { MarketDataPort, RiskContextPort } from "./ports.js";

const COOLDOWN_MS = 24 * 60 * 60_000;
const TERMINAL_ORDER_STATUSES = new Set([
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
  "CONFIRMED",
  "REJECTED"
]);

export interface DatabaseRiskContextOptions {
  database: TradingDatabase;
  marketData: MarketDataPort;
  profileAddress: string;
  now?: () => number;
  timeZone?: string;
}

/**
 * Builds risk state from public positions plus the local execution ledger.
 * Submitted BUY orders are intentionally counted until REST reconciliation
 * proves they are terminal; this may over-count exposure but cannot under-count
 * it after a restart or network failure.
 */
export class DatabaseRiskContext implements RiskContextPort {
  private readonly now: () => number;
  private readonly timeZone: string;

  constructor(private readonly options: DatabaseRiskContextOptions) {
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? "Europe/Madrid";
  }

  async forOrder(
    snapshot: MarketSnapshot,
    _side: OrderSide,
    correlationKey: string,
    executionMode: ExecutionMode,
    excludeProposalId?: string
  ): Promise<RiskContext> {
    const nowMs = this.now();
    if (executionMode === "paper") {
      const paper = derivePaperRiskState(
        this.options.database,
        nowMs,
        excludeProposalId
      );
      const dailyPaperPnlMicros = derivePaperDailyPnlMicros(
        this.options.database,
        nowMs,
        this.timeZone
      );
      const marketExposureMicros = paper.lots
        .filter((lot) => lot.conditionId === snapshot.conditionId)
        .reduce((total, lot) => total + lot.basisMicros, 0n);
      const pendingMarketExposureMicros = paper.pendingBuys
        .filter((order) => order.conditionId === snapshot.conditionId)
        .reduce((total, order) => total + order.riskMicros, 0n);
      const correlatedExposureMicros =
        paper.lots
          .filter((lot) => lot.correlationKey === correlationKey)
          .reduce((total, lot) => total + lot.basisMicros, 0n) +
        paper.pendingBuys
          .filter((order) => order.correlationKey === correlationKey)
          .reduce((total, order) => total + order.riskMicros, 0n);
      const settledPaperSharesMicros = paper.lots
        .filter((lot) => lot.tokenId === snapshot.tokenId)
        .reduce((total, lot) => total + lot.sharesMicros, 0n);
      const reservedSellSharesMicros =
        paper.reservedSellSharesByToken.get(snapshot.tokenId) ?? 0n;

      return {
        nowMs,
        liveTradeCount:
          this.options.database.countCanaryEligibleExecutions(),
        dailyPnlMicros: dailyPaperPnlMicros,
        dailyPnlKnown: true,
        totalOpenExposureMicros:
          paper.lots.reduce(
            (total, lot) => total + lot.basisMicros,
            0n
          ) +
          paper.pendingBuys.reduce(
            (total, order) => total + order.riskMicros,
            0n
          ),
        agentManagedOpenExposureMicros:
          paper.lots.reduce(
            (total, lot) => total + lot.basisMicros,
            0n
          ) +
          paper.pendingBuys.reduce(
            (total, order) => total + order.riskMicros,
            0n
          ),
        marketExposureMicros:
          marketExposureMicros + pendingMarketExposureMicros,
        correlatedExposureMicros,
        openMarketCount: paper.openConditionIds.size,
        heldSharesMicros:
          settledPaperSharesMicros - reservedSellSharesMicros,
        emergencyStopped: this.options.database.getEmergencyStop().active,
        coolingDownUntilMs: null
      };
    }

    const portfolio = await this.options.marketData.getPortfolio(
      this.options.profileAddress
    );
    const derived = this.derive(portfolio, nowMs, excludeProposalId);
    const marketPositionExposure = portfolio.positions
      .filter((position) => position.conditionId === snapshot.conditionId)
      .reduce((total, position) => total + positionRiskMicros(position), 0n);
    const marketOrderExposure = derived.activeProposals
      .filter(
        (proposal) =>
          proposal.market.conditionId === snapshot.conditionId &&
          proposal.side === "BUY"
      )
      .reduce((total, proposal) => total + proposal.maxLossMicros, 0n);
    const correlatedOrderExposure = derived.activeProposals
      .filter(
        (proposal) =>
          canonicalCorrelationKey(proposal.market) === correlationKey &&
          proposal.side === "BUY"
      )
      .reduce((total, proposal) => total + proposal.maxLossMicros, 0n);
    const correlatedPositionExposure = portfolio.positions
      .filter(
        (position) =>
          derived.positionCorrelationKeys.get(positionIdentity(position)) ===
          correlationKey
      )
      .reduce((total, position) => total + positionRiskMicros(position), 0n);
    const settledSharesMicros = portfolio.positions
      .filter((position) => position.tokenId === snapshot.tokenId)
      .reduce((total, position) => total + position.sizeMicros, 0n);
    const reservedSellSharesMicros = derived.activeProposals
      .filter(
        (proposal) =>
          proposal.market.tokenId === snapshot.tokenId &&
          proposal.side === "SELL"
      )
      .reduce((total, proposal) => total + proposal.sharesMicros, 0n);
    const heldSharesMicros =
      settledSharesMicros > reservedSellSharesMicros
        ? settledSharesMicros - reservedSellSharesMicros
        : 0n;

    return {
      nowMs,
      liveTradeCount:
        this.options.database.countCanaryEligibleExecutions(),
      dailyPnlMicros: derived.dailyPnlMicros,
      dailyPnlKnown: derived.dailyPnlKnown,
      totalOpenExposureMicros: derived.totalOpenExposureMicros,
      agentManagedOpenExposureMicros:
        derived.agentManagedOpenExposureMicros,
      marketExposureMicros: marketPositionExposure + marketOrderExposure,
      correlatedExposureMicros:
        correlatedPositionExposure + correlatedOrderExposure,
      openMarketCount: derived.openMarketCount,
      heldSharesMicros,
      emergencyStopped: this.options.database.getEmergencyStop().active,
      coolingDownUntilMs: derived.coolingDownUntilMs
    };
  }

  async summary(): Promise<{
    dailyPnlMicros: bigint;
    dailyPnlKnown: boolean;
    totalOpenExposureMicros: bigint;
    agentManagedOpenExposureMicros: bigint;
    openMarketCount: number;
    liveTradeCount: number;
    drawdownMicros: bigint;
    emergencyStopped: boolean;
    coolingDownUntilMs: number | null;
  }> {
    const portfolio = await this.options.marketData.getPortfolio(
      this.options.profileAddress
    );
    const nowMs = this.now();
    const derived = this.derive(portfolio, nowMs);
    return {
      dailyPnlMicros: derived.dailyPnlMicros,
      dailyPnlKnown: derived.dailyPnlKnown,
      totalOpenExposureMicros: derived.totalOpenExposureMicros,
      agentManagedOpenExposureMicros:
        derived.agentManagedOpenExposureMicros,
      openMarketCount: derived.openMarketCount,
      liveTradeCount:
        this.options.database.countCanaryEligibleExecutions(),
      drawdownMicros: derived.drawdownMicros,
      emergencyStopped: this.options.database.getEmergencyStop().active,
      coolingDownUntilMs: derived.coolingDownUntilMs
    };
  }

  private derive(
    portfolio: PortfolioSnapshot,
    nowMs: number,
    excludeProposalId?: string
  ): {
    activeProposals: OrderProposal[];
    totalOpenExposureMicros: bigint;
    agentManagedOpenExposureMicros: bigint;
    openMarketCount: number;
    dailyPnlMicros: bigint;
    dailyPnlKnown: boolean;
    drawdownMicros: bigint;
    coolingDownUntilMs: number | null;
    positionCorrelationKeys: Map<string, string>;
  } {
    const executionsByProposal = new Map(
      this.options.database
        .listExecutions()
        .map((execution) => [execution.proposalId, execution] as const)
    );
    const allProposals = this.options.database.listProposals();
    for (const proposal of allProposals) {
      if (
        proposal.executionMode === "live" &&
        (!verifyProposalHash(proposal) ||
          proposal.market.eventId === null ||
          proposal.correlationKey !==
            canonicalCorrelationKey(proposal.market))
      ) {
        throw new Error("LIVE_PROPOSAL_LEDGER_INVALID");
      }
    }
    const activeProposals = allProposals.filter((proposal) => {
      if (proposal.id === excludeProposalId) {
        return false;
      }
      if (proposal.executionMode !== "live") {
        return false;
      }
      if (
        proposal.status !== "STAGED" &&
        proposal.status !== "SUBMITTED" &&
        proposal.status !== "EXECUTING"
      ) {
        return false;
      }
      if (
        proposal.status !== "SUBMITTED" &&
        proposal.status !== "EXECUTING" &&
        proposal.expiresAtMs < nowMs
      ) {
        return false;
      }
      const status = executionsByProposal.get(proposal.id)?.status.toUpperCase();
      return status === undefined || !TERMINAL_ORDER_STATUSES.has(status);
    });
    const positionCorrelationKeys = new Map<string, string>();
    for (const position of portfolio.positions) {
      const correlationKeys = new Set(
        allProposals
          .filter((proposal) => {
            const execution = executionsByProposal.get(proposal.id);
            return (
              proposal.executionMode === "live" &&
              proposal.status === "SUBMITTED" &&
              proposal.market.tokenId === position.tokenId &&
              proposal.market.conditionId === position.conditionId &&
              execution?.clobOrderId !== null &&
              execution?.clobOrderId !== undefined
            );
          })
          .map((proposal) => canonicalCorrelationKey(proposal.market))
      );
      if (correlationKeys.size === 1) {
        positionCorrelationKeys.set(
          positionIdentity(position),
          [...correlationKeys][0]!
        );
      } else {
        positionCorrelationKeys.set(
          positionIdentity(position),
          canonicalCorrelationKey({ conditionId: position.conditionId, eventId: position.conditionId })
        );
      }
    }

    const dayKey = zonedDayKey(nowMs, this.timeZone);
    const grandfatheredKeys = this.options.database.getGrandfatheredPositionKeys(
      dayKey
    );
    const positionExposureMicros = portfolio.positions.reduce(
      (total, position) => total + positionRiskMicros(position),
      0n
    );
    const agentManagedPositionExposureMicros = portfolio.positions
      .filter((position) => !grandfatheredKeys.has(positionIdentity(position)))
      .reduce(
        (total, position) => total + positionRiskMicros(position),
        0n
      );
    const pendingBuyExposureMicros = activeProposals
      .filter((proposal) => proposal.side === "BUY")
      .reduce((total, proposal) => total + proposal.maxLossMicros, 0n);
    const openConditionIds = new Set<string>();
    for (const position of portfolio.positions) {
      if (position.sizeMicros > 0n) {
        openConditionIds.add(position.conditionId);
      }
    }
    for (const proposal of activeProposals) {
      openConditionIds.add(proposal.market.conditionId);
    }

    const dailyRisk = this.options.database.getDailyRiskPnl(
      dayKey,
      portfolio.totalPnlMicros
    );
    const dailyPnlMicros = dailyRisk.pnlMicros;
    const drawdownMicros = this.options.database.getDailyDrawdownMicros(
      dayKey,
      dailyPnlMicros,
      nowMs
    );
    let cooldown = this.options.database.getCooldown();
    if (
      dailyPnlMicros <= -DEFAULT_RISK_POLICY.dailyStopMicros &&
      (cooldown.updatedAtMs === 0 ||
        zonedDayKey(cooldown.updatedAtMs, this.timeZone) !== dayKey)
    ) {
      this.options.database.setCooldownUntil(
        nowMs + COOLDOWN_MS,
        "DAILY_STOP",
        nowMs
      );
      this.options.database.setLiveActivation(false, nowMs);
      cooldown = this.options.database.getCooldown();
    }

    return {
      activeProposals,
      totalOpenExposureMicros:
        positionExposureMicros + pendingBuyExposureMicros,
      agentManagedOpenExposureMicros:
        agentManagedPositionExposureMicros + pendingBuyExposureMicros,
      openMarketCount: openConditionIds.size,
      dailyPnlMicros,
      dailyPnlKnown: dailyRisk.known,
      drawdownMicros,
      coolingDownUntilMs: cooldown.untilMs > nowMs ? cooldown.untilMs : null,
      positionCorrelationKeys
    };
  }
}

function positionIdentity(
  position: Pick<
    PortfolioSnapshot["positions"][number],
    "conditionId" | "tokenId"
  >
): string {
  return `${position.conditionId.toLowerCase()}:${position.tokenId}`;
}

interface PaperRiskLot {
  tokenId: string;
  conditionId: string;
  correlationKey: string;
  sharesMicros: bigint;
  basisMicros: bigint;
}

interface PendingPaperBuy {
  tokenId: string;
  conditionId: string;
  correlationKey: string;
  riskMicros: bigint;
}

interface PaperRiskState {
  lots: PaperRiskLot[];
  pendingBuys: PendingPaperBuy[];
  reservedSellSharesByToken: Map<string, bigint>;
  openConditionIds: Set<string>;
}

function derivePaperRiskState(
  database: TradingDatabase,
  nowMs: number,
  excludeProposalId?: string
): PaperRiskState {
  const trades = database
    .listPaperTrades()
    .filter((trade) => trade.proposalId !== excludeProposalId);
  const seenProposalIds = new Set<string>();
  const verified = trades.map((trade) => {
    if (seenProposalIds.has(trade.proposalId)) {
      throw new Error("PAPER_LEDGER_DUPLICATE_PROPOSAL");
    }
    seenProposalIds.add(trade.proposalId);
    const proposal = database.getProposal(trade.proposalId);
    if (proposal === null) {
      throw new Error("PAPER_LEDGER_PROPOSAL_MISSING");
    }
    return verifyPaperTradeAgainstProposal(trade, proposal);
  });

  for (const proposal of database.listProposals()) {
    if (
      proposal.executionMode !== "paper" ||
      proposal.id === excludeProposalId
    ) {
      continue;
    }
    if (
      proposal.status === "SIMULATED" &&
      !seenProposalIds.has(proposal.id)
    ) {
      throw new Error("PAPER_LEDGER_TRADE_MISSING");
    }
    if (
      proposal.status === "STAGED" &&
      proposal.expiresAtMs >= nowMs &&
      !seenProposalIds.has(proposal.id)
    ) {
      throw new Error("PAPER_LEDGER_INCOMPLETE_STAGE");
    }
  }

  verified.sort(
    (left, right) =>
      left.trade.openedAtMs - right.trade.openedAtMs ||
      left.trade.id.localeCompare(right.trade.id)
  );
  const lots: PaperRiskLot[] = [];
  const pendingBuys: PendingPaperBuy[] = [];
  const reservedSellSharesByToken = new Map<string, bigint>();

  for (const entry of verified) {
    const { proposal, trade } = entry;
    if (trade.filledSharesMicros > 0n) {
      if (proposal.side === "BUY") {
        lots.push({
          tokenId: proposal.market.tokenId,
          conditionId: proposal.market.conditionId,
          correlationKey: proposal.correlationKey,
          sharesMicros: trade.filledSharesMicros,
          basisMicros: entry.notionalMicros + trade.feesMicros
        });
      } else {
        consumePaperLots(
          lots,
          proposal.market.tokenId,
          trade.filledSharesMicros
        );
      }
    }

    const residualSharesMicros =
      proposal.sharesMicros - trade.filledSharesMicros;
    const orderStillActive =
      residualSharesMicros > 0n &&
      trade.status !== "CANCELLED" &&
      nowMs <
        trade.openedAtMs + DEFAULT_RISK_POLICY.effectiveGtdMs;
    if (!orderStillActive) {
      continue;
    }
    if (proposal.side === "BUY") {
      pendingBuys.push({
        tokenId: proposal.market.tokenId,
        conditionId: proposal.market.conditionId,
        correlationKey: proposal.correlationKey,
        riskMicros: ceilDivide(
          proposal.maxLossMicros * residualSharesMicros,
          proposal.sharesMicros
        )
      });
    } else {
      reservedSellSharesByToken.set(
        proposal.market.tokenId,
        (reservedSellSharesByToken.get(proposal.market.tokenId) ?? 0n) +
          residualSharesMicros
      );
    }
  }

  for (const [tokenId, reservedSharesMicros] of reservedSellSharesByToken) {
    const availableSharesMicros = lots
      .filter((lot) => lot.tokenId === tokenId)
      .reduce((total, lot) => total + lot.sharesMicros, 0n);
    if (reservedSharesMicros > availableSharesMicros) {
      throw new Error("PAPER_LEDGER_SELL_RESERVATION_EXCEEDS_POSITION");
    }
  }

  const openConditionIds = new Set<string>();
  for (const lot of lots) {
    if (lot.sharesMicros > 0n) {
      openConditionIds.add(lot.conditionId);
    }
  }
  for (const pendingBuy of pendingBuys) {
    openConditionIds.add(pendingBuy.conditionId);
  }

  return {
    lots: lots.filter((lot) => lot.sharesMicros > 0n),
    pendingBuys,
    reservedSellSharesByToken,
    openConditionIds
  };
}

function derivePaperDailyPnlMicros(
  database: TradingDatabase,
  nowMs: number,
  timeZone: string
): bigint {
  const checkpoints = database
    .listAuditEvents()
    .filter(
      (event) => event.eventType === "PAPER_RECONCILIATION_CHECKPOINT"
    )
    .map((event) => event.payload)
    .filter(isPaperCheckpoint)
    .sort((left, right) => left.recordedAtMs - right.recordedAtMs);
  const latest = checkpoints.at(-1);
  if (latest === undefined) {
    return 0n;
  }
  const dayKey = zonedDayKey(nowMs, timeZone);
  const firstTodayIndex = checkpoints.findIndex(
    (checkpoint) =>
      zonedDayKey(checkpoint.recordedAtMs, timeZone) === dayKey
  );
  if (firstTodayIndex < 0) {
    return 0n;
  }
  const baseline =
    firstTodayIndex > 0
      ? checkpoints[firstTodayIndex - 1]!.netPnlMicros
      : checkpoints[firstTodayIndex]!.netPnlMicros;
  return latest.netPnlMicros - baseline;
}

function isPaperCheckpoint(
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
    typeof checkpoint.netPnlMicros === "bigint"
  );
}

function consumePaperLots(
  lots: PaperRiskLot[],
  tokenId: string,
  requestedSharesMicros: bigint
): void {
  let remainingSharesMicros = requestedSharesMicros;
  for (const lot of lots) {
    if (lot.tokenId !== tokenId || remainingSharesMicros === 0n) {
      continue;
    }
    const consumedSharesMicros =
      lot.sharesMicros < remainingSharesMicros
        ? lot.sharesMicros
        : remainingSharesMicros;
    const consumedBasisMicros =
      consumedSharesMicros === lot.sharesMicros
        ? lot.basisMicros
        : ceilDivide(
            lot.basisMicros * consumedSharesMicros,
            lot.sharesMicros
          );
    lot.sharesMicros -= consumedSharesMicros;
    lot.basisMicros -= consumedBasisMicros;
    remainingSharesMicros -= consumedSharesMicros;
  }
  if (remainingSharesMicros !== 0n) {
    throw new Error("PAPER_LEDGER_UNMATCHED_SELL");
  }
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("PAPER_LEDGER_INVALID_DENOMINATOR");
  }
  return (numerator + denominator - 1n) / denominator;
}

function positionRiskMicros(
  position: PortfolioSnapshot["positions"][number]
): bigint {
  const costBasis =
    (position.sizeMicros * position.averagePriceMicros + 999_999n) /
    1_000_000n;
  return costBasis > position.currentValueMicros
    ? costBasis
    : position.currentValueMicros;
}

export function zonedDayKey(nowMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!values.year || !values.month || !values.day) {
    throw new Error("Unable to derive the local risk day.");
  }
  return `${values.year}-${values.month}-${values.day}`;
}

export function zonedDayStartMs(nowMs: number, timeZone: string): number {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("Unable to derive the local risk-day boundary.");
  }
  const targetDay = zonedDayKey(nowMs, timeZone);
  let lower = Math.max(0, nowMs - 30 * 60 * 60_000);
  let upper = nowMs;
  while (lower < upper) {
    const midpoint = lower + Math.floor((upper - lower) / 2);
    if (zonedDayKey(midpoint, timeZone) < targetDay) {
      lower = midpoint + 1;
    } else {
      upper = midpoint;
    }
  }
  if (
    zonedDayKey(lower, timeZone) !== targetDay ||
    (lower > 0 && zonedDayKey(lower - 1, timeZone) === targetDay)
  ) {
    throw new Error("Unable to derive the local risk-day boundary.");
  }
  return lower;
}
