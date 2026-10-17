import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ProposalRejectedError,
  createOrderProposal,
  hashCanonical,
  hashMarketSnapshot,
  verifyProposalHash
} from "../domain/proposals.js";
import {
  DEFAULT_RISK_POLICY,
  INITIAL_CANARY_MAX_ORDER_PUSD,
  INITIAL_CANARY_TRADE_COUNT,
  RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD,
  RISK_HARD_DAILY_STOP_PUSD,
  evaluateOrderRisk
} from "../domain/risk-policy.js";
import {
  canonicalCorrelationKey,
  formatMicros,
  multiplyMicros,
  parseDecimalToMicros,
  PUSD_SCALE,
  type ExitReason,
  type ExitState,
  type LegacyImportReport,
  type MarketSnapshot,
  type OrderIntent,
  type OrderProposal,
  type OrderSide,
  type PositionRecord,
  type PortfolioSnapshot,
  type RiskContext,
  type ResearchBundle,
  type UserTradeActivity
} from "../domain/types.js";
import {
  CRISIS_SOURCE_AGE_MS,
  extractRegistrableDomain,
  isRecognizedEvidenceDomain,
  MAX_SOURCE_AGE_MS,
  validateEvidenceSources
} from "../domain/source-validator.js";
import {
  createPendingTradingSession,
  hashSessionChallenge,
  isSessionValid,
  minBigInt,
  type PendingTradingSession,
  type TradingSession
} from "../domain/session.js";
import {
  evaluatePositionExitPolicy,
  type EvaluationAction
} from "../domain/position-supervisor.js";
import {
  evaluateOpportunity,
  OPPORTUNITY_MODEL_VERSION,
  snapshotHistoryPoint,
  type OpportunityDecision
} from "../domain/opportunity-scanner.js";
import {
  computeLegacyImport,
  type LegacyImportResult,
  type LegacyLocalEvidence,
  type LegacyLocalFill
} from "../domain/legacy-import.js";
import { PaperSimulator } from "../paper/simulator.js";
import { zonedDayKey, zonedDayStartMs } from "./risk-context.js";
import {
  normalizeClobOrderStatus,
  normalizeClobTradeStatus,
  parseClobFixed6,
  parseClobPrice,
  parseClobTimestampMs
} from "../polymarket/reconciliation.js";
import {
  isSubmissionUnknown,
  SafeExternalServiceError
} from "../polymarket/safe-error.js";
import type { TradingDatabase } from "../storage/database.js";
import {
  parseWithBigInts,
  stringifyWithBigInts
} from "../storage/codec.js";
import type {
  AccountBindingPort,
  AccountStatus,
  LiveTradingPort,
  MarketDataPort,
  MarketReference,
  OnchainSettlementPort,
  PaperGatePort,
  RiskContextPort,
  StageOrderInput,
  StageOrderResult
} from "./ports.js";

const TERMINAL_MONITORED_STATUSES = new Set([
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
  "CONFIRMED",
  "REJECTED"
]);

export interface TradingServiceOptions {
  profileAddress: string;
  liveEnvironmentEnabled: boolean;
  database: TradingDatabase;
  marketData: MarketDataPort;
  /** Public WebSocket-backed snapshot path reserved for agent-supervised live orders. */
  getAgentMarketSnapshot?: (
    reference: MarketReference
  ) => Promise<MarketSnapshot>;
  accountBinding: AccountBindingPort;
  riskContexts: RiskContextPort;
  paperGate: PaperGatePort;
  /** Explicit non-secret override; never replaces the other live barriers. */
  paperGateSkip?: boolean;
  paperGateSkipSource?: "dotenv" | "environment" | "default";
  liveTrading: LiveTradingPort | null;
  onchainSettlement: OnchainSettlementPort;
  paperSimulator?: PaperSimulator;
  now?: () => number;
}

export class TradingService {
  private readonly now: () => number;
  private readonly paperSimulator: PaperSimulator;

  constructor(private readonly options: TradingServiceOptions) {
    this.now = options.now ?? Date.now;
    this.paperSimulator =
      options.paperSimulator ?? new PaperSimulator(this.now);
  }

  async getAccountStatus(): Promise<AccountStatus> {
    const [
      profileExists,
      signerConfigured,
      signerAddress,
      signatureType,
      funderAddress,
      liveConfigured,
      paperGate
    ] = await Promise.all([
      this.options.marketData.profileExists(this.options.profileAddress),
      this.options.accountBinding.signerConfigured(),
      this.options.accountBinding.signerAddress(),
      this.options.accountBinding.signatureType(),
      this.options.accountBinding.funderAddress(),
      this.options.liveTrading?.configured() ?? Promise.resolve(false),
      this.options.paperGate.result(
        this.options.paperGateSkip === true && this.options.paperGateSkipSource === "dotenv"
      )
    ]);
    const emergencyStopped = this.options.database.getEmergencyStop().active;
    const localLiveActivation = this.options.database.getLiveActivation().active;
    const liveReady =
      this.options.liveEnvironmentEnabled &&
      profileExists &&
      localLiveActivation &&
      paperGate.passed &&
      (this.options.paperGateSkip !== true || this.options.paperGateSkipSource === "dotenv") &&
      signerConfigured &&
      liveConfigured &&
      !emergencyStopped;
    const mode: AccountStatus["mode"] = liveReady
      ? "live_ready"
      : signerConfigured || localLiveActivation
        ? "live_locked"
        : profileExists
          ? "paper"
          : "read_only";

    return {
      configuredProfileAddress: this.options.profileAddress,
      profileExists,
      signerConfigured,
      signerAddress,
      signatureType,
      funderAddress,
      mode,
      emergencyStopped,
      liveEnvironmentEnabled: this.options.liveEnvironmentEnabled,
      localLiveActivation,
      paperGatePassed: paperGate.passed
    };
  }

  getPortfolio() {
    return this.options.marketData.getPortfolio(this.options.profileAddress);
  }

  async importLegacyPosition(tokenId: string): Promise<LegacyImportResult> {
    const portfolio = await this.getPortfolio();
    const position = portfolio.positions.find(
      (candidate) => candidate.tokenId === tokenId
    );
    if (position === undefined || position.sizeMicros <= 0n) {
      throw new Error("LEGACY_POSITION_NOT_FOUND");
    }

    const existing = this.options.database.getPositionRecord(tokenId);
    if (existing?.evidenceQuality === "VERIFIED") {
      const stored = this.options.database.getLatestLegacyImportReport(tokenId);
      return {
        imported: false,
        report: stored ?? existingPositionReport(existing, this.now())
      };
    }

    let activity: UserTradeActivity[] = [];
    let activityAvailable = true;
    try {
      activity = await this.options.marketData.getUserActivity(
        this.options.profileAddress,
        0
      );
    } catch {
      activityAvailable = false;
    }

    const local = this.collectLegacyLocalEvidence(tokenId);
    let ordersChecked = false;
    let remoteOpenOrderCount = 0;
    if (
      this.options.liveEnvironmentEnabled &&
      this.options.liveTrading !== null
    ) {
      try {
        const openOrders = await this.options.liveTrading.getOpenOrders();
        ordersChecked = true;
        remoteOpenOrderCount = openOrders.filter(
          (order) => readStringValue(order.assetId, order.asset_id) === tokenId
        ).length;
      } catch {
        // Missing authenticated order evidence lowers the quality instead of
        // being converted into a permissive import.
      }
    }

    const computation = computeLegacyImport({
      position,
      activity,
      activityAvailable,
      local,
      remoteOpenOrderCount,
      ordersChecked
    });
    if (
      existing !== null &&
      higherEvidenceQuality(existing.evidenceQuality, computation.quality) ===
        existing.evidenceQuality
    ) {
      const stored = this.options.database.getLatestLegacyImportReport(tokenId);
      return {
        imported: false,
        report: stored ?? existingPositionReport(existing, this.now())
      };
    }
    const importedAtMs = this.now();
    const quality = higherEvidenceQuality(existing?.evidenceQuality, computation.quality);
    const report: LegacyImportReport = {
      id: randomUUID(),
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      importedAtMs,
      ...computation,
      quality,
      automaticExitPolicy: automaticExitPolicyForQuality(quality)
    };
    const positionRecord: PositionRecord = {
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      question: position.question,
      outcome: position.outcome,
      side: "BUY",
      sharesMicros: position.sizeMicros,
      averagePriceMicros: position.averagePriceMicros,
      evidenceQuality: quality,
      entryFeesMicros: computation.feesMicros,
      entryTransactionHashesJson: JSON.stringify(computation.transactionHashes),
      entryProbabilityMicros: existing?.entryProbabilityMicros ?? null,
      entryEdgeMicros: existing?.entryEdgeMicros ?? null,
      openedAtMs: computation.openedAtMs ?? existing?.openedAtMs ?? null,
      lastEvaluatedAtMs: importedAtMs,
      lastMarketPriceMicros: position.currentPriceMicros,
      lastEstimatedProbabilityMicros: existing?.lastEstimatedProbabilityMicros ?? null,
      lastResearchBundleId: existing?.lastResearchBundleId ?? null,
      sourcesJson: "[]",
      researchRequiredSinceMs: existing?.researchRequiredSinceMs ?? null,
      researchRequiredAtPriceMicros: existing?.researchRequiredAtPriceMicros ?? null,
      minimumResearchCreatedAtMs: existing?.minimumResearchCreatedAtMs ?? null,
      exitState:
        existing?.exitState === "CLOSING" || existing?.exitState === "CLOSED"
          ? existing.exitState
          : quality === "LEGACY_UNVERIFIED"
            ? "LEGACY_UNVERIFIED"
            : "HOLDING",
      activeExitProposalId: existing?.activeExitProposalId ?? null,
      activeExitOrderId: existing?.activeExitOrderId ?? null
    };
    this.options.database.saveLegacyImportReport(report);
    this.options.database.savePositionRecord(positionRecord, importedAtMs);
    return { imported: true, report };
  }

  scanCandidates() {
    return this.options.marketData.scanCandidates([
      "politics",
      "economics",
      "technology"
    ]);
  }

  /**
   * One deterministic entry pass. It is intentionally called by the local
   * supervisor, never by the MCP request path. A missing session, evidence
   * bundle, warm history or risk capacity is a normal no-op; no order is
   * synthesized from momentum alone.
   */
  async runAutonomousEntryCycle(executionMode: "paper" | "live"): Promise<{
    evaluatedCandidatesCount: number;
    stagedCount: number;
    executedCount: number;
    skippedCount: number;
    decisions: Array<{
      conditionId: string;
      tokenId: string;
      accepted: boolean;
      reason: string | null;
      modelVersion: string;
    }>;
  }> {
    const nowMs = this.now();
    if (String(executionMode) === "live") {
      // Live entries are conversation-owned. The detached daemon only
      // reconciles and supervises positions; it never invents entries.
      return {
        evaluatedCandidatesCount: 0,
        stagedCount: 0,
        executedCount: 0,
        skippedCount: 1,
        decisions: []
      };
    }
    const session = this.options.database.getActiveTradingSession(executionMode, nowMs);
    if (session === null) {
      return {
        evaluatedCandidatesCount: 0,
        stagedCount: 0,
        executedCount: 0,
        skippedCount: 1,
        decisions: []
      };
    }

    const risk = await this.options.riskContexts.summary();
    if (risk.emergencyStopped || risk.dailyPnlMicros <= -RISK_HARD_DAILY_STOP_PUSD) {
      return {
        evaluatedCandidatesCount: 0,
        stagedCount: 0,
        executedCount: 0,
        skippedCount: 1,
        decisions: []
      };
    }
    const candidates = (await this.scanCandidates()).slice(0, 50);
    const decisions: Array<{
      conditionId: string;
      tokenId: string;
      accepted: boolean;
      reason: string | null;
      modelVersion: string;
    }> = [];
    let stagedCount = 0;
    let executedCount = 0;
    let skippedCount = 0;
    let initialCanaryPositionTaken = false;
    if (executionMode === "live" && risk.liveTradeCount < INITIAL_CANARY_TRADE_COUNT) {
      try {
        const portfolio = await this.getPortfolio();
        initialCanaryPositionTaken = portfolio.positions.some(
          (position) => position.sizeMicros > 0n
        );
      } catch {
        // A live entry cannot be sized safely without portfolio evidence.
        return {
          evaluatedCandidatesCount: 0,
          stagedCount: 0,
          executedCount: 0,
          skippedCount: 1,
          decisions: []
        };
      }
    }

    for (const candidate of candidates) {
      if (
        executionMode === "live" &&
        risk.liveTradeCount < INITIAL_CANARY_TRADE_COUNT &&
        initialCanaryPositionTaken
      ) {
        break;
      }
      for (const tokenId of candidate.tokenIds.slice(0, 2)) {
        let decision: OpportunityDecision | null = null;
        try {
          const firstSnapshot = await this.getMarketSnapshot({
            conditionId: candidate.conditionId,
            tokenId
          });
          this.options.database.saveMarketSnapshot(firstSnapshot);
          const history = this.options.database.listMarketSnapshots(
            tokenId,
            nowMs - 20 * 60_000,
            500
          );
          const bundle = this.options.database.getLatestResearchBundle(
            candidate.conditionId,
            tokenId,
            nowMs
          );
          const orderBudgetMicros =
            executionMode === "live" &&
            risk.liveTradeCount < INITIAL_CANARY_TRADE_COUNT
              ? 1n * PUSD_SCALE
              : risk.liveTradeCount < DEFAULT_RISK_POLICY.canaryTradeCount
                ? DEFAULT_RISK_POLICY.canaryMaxOrderMicros
                : DEFAULT_RISK_POLICY.pilotMaxOrderMicros;
          if (firstSnapshot.bestAskMicros <= 0n) {
            decision = evaluateOpportunity({
              candidate,
              snapshot: firstSnapshot,
              history: history.map(snapshotHistoryPoint),
              researchBundle: bundle,
              nowMs,
              riskMicros: orderBudgetMicros
            });
          } else {
            const executableSnapshot = await this.getMarketSnapshot({
              conditionId: candidate.conditionId,
              tokenId,
              outcome: firstSnapshot.outcome,
              side: "BUY",
              limitPriceMicros: firstSnapshot.bestAskMicros
            });
            this.options.database.saveMarketSnapshot(executableSnapshot);
            const currentHistory = this.options.database.listMarketSnapshots(
              tokenId,
              nowMs - 20 * 60_000,
              500
            );
            decision = evaluateOpportunity({
              candidate,
              snapshot: executableSnapshot,
              history: currentHistory.map(snapshotHistoryPoint),
              researchBundle: bundle,
              nowMs: this.now(),
              riskMicros: orderBudgetMicros
            });
            if (decision.accepted && bundle !== null && isResearchBundleUsable(
              bundle,
              executableSnapshot.conditionId,
              executableSnapshot.tokenId,
              decision.estimatedProbabilityMicros ?? -1n,
              this.now(),
              executableSnapshot
            )) {
              const duplicateEntry = this.options.database.listProposals().some(
                (proposal) =>
                  proposal.executionMode === executionMode &&
                  proposal.intent === "ENTRY" &&
                  ["STAGED", "EXECUTING", "SUBMITTED", "SIMULATED"].includes(proposal.status) &&
                  proposal.createdAtMs >= this.now() - 15 * 60_000 &&
                  (proposal.market.tokenId === executableSnapshot.tokenId ||
                    proposal.correlationKey === canonicalCorrelationKey(executableSnapshot))
              );
              if (duplicateEntry) {
                decision = { ...decision, accepted: false, reason: "INVALID_MARKET_DATA" };
                decisions.push({
                  conditionId: candidate.conditionId,
                  tokenId,
                  accepted: false,
                  reason: "ACTIVE_ENTRY_PROPOSAL_EXISTS",
                  modelVersion: OPPORTUNITY_MODEL_VERSION
                });
                skippedCount += 1;
                continue;
              }
              const sharesMicros = sizeSharesForBudget(
                orderBudgetMicros,
                executableSnapshot.bestAskMicros
              );
              if (sharesMicros > 0n) {
                const staged = await this.stageOrder({
                  executionMode,
                  intent: "ENTRY",
                  tokenId,
                  conditionId: candidate.conditionId,
                  outcome: executableSnapshot.outcome,
                  side: "BUY",
                  shares: formatMicros(sharesMicros),
                  limitPrice: formatMicros(executableSnapshot.bestAskMicros),
                  estimatedProbability: formatMicros(bundle.estimatedProbabilityMicros),
                  researchBundleId: bundle.id,
                  thesis: autonomousThesis(bundle.rationale, decision.features),
                  counterThesis: autonomousCounterThesis(bundle.counterRationale, decision.features),
                  sources: evidenceSourcesFromResearchBundle(bundle)
                });
                stagedCount += 1;
                this.options.database.appendAudit("AUTONOMOUS_ENTRY_STAGED", staged.proposal.id, {
                  modelVersion: OPPORTUNITY_MODEL_VERSION,
                  conditionId: candidate.conditionId,
                  tokenId,
                  decision: decision.features
                });
                if (executionMode === "live") {
                  const execution = await this.executeStagedProposal(
                    staged.proposal.id,
                    staged.proposal.hash
                  );
                  if (execution.accepted) {
                    executedCount += 1;
                    initialCanaryPositionTaken = true;
                  }
                } else {
                  executedCount += 1;
                }
              } else {
                decision = { ...decision, accepted: false, reason: "INVALID_MARKET_DATA" };
              }
            } else if (decision.accepted) {
              decision = { ...decision, accepted: false, reason: "RESEARCH_INCONSISTENT" };
            }
          }
        } catch (error) {
          decision = {
            accepted: false,
            reason: "INVALID_MARKET_DATA",
            features: null,
            researchBundleId: null,
            estimatedProbabilityMicros: null
          };
        }
        if (decision === null) {
          continue;
        }
        if (!decision.accepted) skippedCount += 1;
        decisions.push({
          conditionId: candidate.conditionId,
          tokenId,
          accepted: decision.accepted,
          reason: decision.reason,
          modelVersion: OPPORTUNITY_MODEL_VERSION
        });
      }
    }
    return {
      evaluatedCandidatesCount: candidates.length,
      stagedCount,
      executedCount,
      skippedCount,
      decisions
    };
  }

  getMarketSnapshot(reference: MarketReference) {
    return this.options.marketData.getMarketSnapshot(reference);
  }

  async getRiskStatus() {
    const [summary, paperMetrics, paperResult] = await Promise.all([
      this.options.riskContexts.summary(),
      this.options.paperGate.metrics(),
      this.options.paperGate.result(
        this.options.paperGateSkip === true && this.options.paperGateSkipSource === "dotenv"
      )
    ]);
    return {
      ...summary,
      emergencyStop: this.options.database.getEmergencyStop(),
      liveActivation: this.options.database.getLiveActivation(),
      paperMetrics,
      paperGate: paperResult
    };
  }

  async getOrderStatus(proposalId: string) {
    const proposal = this.options.database.getProposal(proposalId);
    const execution = this.options.database.getExecution(proposalId);
    let remote: Record<string, unknown> | null = null;
    if (execution?.clobOrderId && this.options.liveTrading) {
      remote = await this.options.liveTrading.getOrderStatus(execution.clobOrderId);
    }
    return { proposal, execution, remote };
  }

  async prepareTradingSession(input: {
    executionMode: "paper" | "live";
    ttlMs?: number;
  }): Promise<{ pending: PendingTradingSession }> {
    const nowMs = this.now();
    if (this.options.database.getActiveTradingSession(input.executionMode, nowMs)) {
      throw new Error("An active trading session already exists.");
    }
    if (this.options.database.getPendingTradingSessionForMode(input.executionMode, nowMs)) {
      throw new Error("A pending trading session authorization already exists.");
    }

    const capacity = await this.getTradingSessionCapacity(input.executionMode);
    if (input.executionMode === "live" && this.options.paperGateSkip === true) {
      if (this.options.paperGateSkipSource !== "dotenv") {
        throw new Error("PAPER_GATE_SKIP_MUST_BE_CONFIGURED_IN_DOTENV");
      }
      this.options.database.appendAudit("PAPER_GATE_OVERRIDE_ACTIVE", null, {
        source: this.options.paperGateSkipSource,
        sessionMode: input.executionMode,
        recordedAtMs: nowMs
      });
    }
    const challenge = randomBytes(18).toString("hex").toUpperCase();
    const pending = createPendingTradingSession({
      ...capacity,
      executionMode: input.executionMode,
      challengeHash: hashSessionChallenge(challenge),
      ...(input.ttlMs === undefined ? {} : { sessionTtlMs: input.ttlMs }),
      nowMs
    });
    this.options.database.savePendingTradingSession(pending);
    return { pending };
  }

  async activateTradingSession(pendingSessionId: string): Promise<TradingSession> {
    const nowMs = this.now();
    const pending = this.options.database.getPendingTradingSession(
      pendingSessionId,
      nowMs
    );
    const authorization = this.options.database.getSessionAuthorization(
      pendingSessionId
    );
    if (
      !pending ||
      !authorization ||
      authorization.attestationSource !== "macos-native-user-presence" ||
      authorization.consumedAtMs !== null
    ) {
      throw new Error("Pending trading session is missing, expired, or not locally authorized.");
    }

    const capacity = await this.getTradingSessionCapacity(pending.executionMode);
    if (authorization.amountMicros > capacity.maximumAuthorizableMicros) {
      throw new Error(
        "The authorized amount exceeds the current safe session capacity; prepare a new session."
      );
    }

    const session = this.options.database.activateTradingSession(
      pendingSessionId,
      nowMs
    );
    if (!session) {
      throw new Error(
        "Trading session activation failed because the authorization was consumed or another session is active."
      );
    }
    return session;
  }

  async closeTradingSession(sessionId: string, reason = "User closed session"): Promise<{ id: string; status: "CLOSED"; closedAtMs: number }> {
    const nowMs = this.now();
    this.options.database.closeTradingSession(sessionId, reason, nowMs);
    return { id: sessionId, status: "CLOSED", closedAtMs: nowMs };
  }

  getActiveTradingSession(executionMode: "live" | "paper"): TradingSession | null {
    return this.options.database.getActiveTradingSession(executionMode, this.now());
  }

  private async getTradingSessionCapacity(
    executionMode: "paper" | "live"
  ): Promise<{
    cashAvailableMicros: bigint | null;
    openExposureMicros: bigint;
    hardCeilingRemainingMicros: bigint;
    dailyStopRemainingMicros: bigint;
    maximumAuthorizableMicros: bigint;
  }> {
    const summary = await this.options.riskContexts.summary();
    if (summary.emergencyStopped) {
      throw new Error("Cannot prepare a trading session while the emergency stop is active.");
    }
    if (!summary.dailyPnlKnown) {
      throw new Error("Cannot prepare a trading session while daily PnL is unknown.");
    }
    if (
      summary.coolingDownUntilMs !== null &&
      summary.coolingDownUntilMs > this.now()
    ) {
      throw new Error("Cannot prepare a trading session during the loss cooldown.");
    }

    let cashAvailableMicros: bigint | null = null;
    try {
      const portfolio = await this.getPortfolio();
      cashAvailableMicros = portfolio.pUsdBalanceMicros;
    } catch {
      if (executionMode === "live") {
        throw new Error("LIVE_SESSION_CASH_UNAVAILABLE: real cash could not be verified.");
      }
    }
    if (executionMode === "live" && cashAvailableMicros === null) {
      const readVerifiedBalance = this.options.liveTrading?.getVerifiedCollateralBalance;
      if (readVerifiedBalance === undefined || this.options.liveTrading === undefined) {
        throw new Error("LIVE_SESSION_CASH_UNAVAILABLE: real cash could not be verified.");
      }
      try {
        cashAvailableMicros = await readVerifiedBalance.call(this.options.liveTrading);
      } catch {
        throw new Error("LIVE_SESSION_CASH_UNAVAILABLE: real cash could not be verified.");
      }
    }

    const hardCeilingRemainingMicros = maxRemaining(
      RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD,
      summary.totalOpenExposureMicros
    );
    const dailyLossMicros = summary.dailyPnlMicros < 0n ? -summary.dailyPnlMicros : 0n;
    const dailyStopRemainingMicros = maxRemaining(
      RISK_HARD_DAILY_STOP_PUSD,
      dailyLossMicros
    );
    const policy = executionMode === "live"
      ? this.options.database.getAgentPolicy().risk
      : DEFAULT_RISK_POLICY;
    const exposureLimitMicros =
      summary.liveTradeCount < policy.canaryTradeCount
        ? policy.canaryMaxOpenExposureMicros
        : policy.pilotMaxOpenExposureMicros;
    const exposureCapacityMicros = maxRemaining(
      exposureLimitMicros,
      summary.totalOpenExposureMicros
    );
    const capacityInputs = [
      hardCeilingRemainingMicros,
      dailyStopRemainingMicros,
      exposureCapacityMicros
    ];
    if (cashAvailableMicros !== null) {
      capacityInputs.push(cashAvailableMicros);
    }
    const maximumAuthorizableMicros = minBigInt(...capacityInputs);
    if (maximumAuthorizableMicros <= 0n) {
      throw new Error("No safe trading session capacity remains.");
    }
    return {
      cashAvailableMicros,
      openExposureMicros: summary.totalOpenExposureMicros,
      hardCeilingRemainingMicros,
      dailyStopRemainingMicros,
      maximumAuthorizableMicros
    };
  }

  async stageOrder(input: StageOrderInput): Promise<StageOrderResult> {
    requireResearchFields(input, this.now());

    const nowMs = this.now();
    const activeAgentRun = this.options.database.getAgentRun(nowMs);
    if (input.executionMode === "live" && (input.intent === "ENTRY" || input.decisionOwner === "agent")) {
      if (activeAgentRun?.status === "ACTIVE") {
        if (
          input.decisionOwner !== "agent" ||
          input.agentRunId !== activeAgentRun.agentRunId ||
          !this.options.database.isAgentRunActive(input.agentRunId, nowMs)
        ) {
          throw new ProposalRejectedError([
            {
              code: "SESSION_INACTIVE",
              message: "An active agent lease owns agent-supervised live orders; the proposal must identify that lease."
            }
          ]);
        }
      } else if (input.decisionOwner === "agent" || input.agentRunId !== undefined) {
        throw new ProposalRejectedError([
          {
            code: "SESSION_INACTIVE",
            message: "The agent lease is missing or expired; agent-supervised live orders are blocked."
          }
        ]);
      }
    }
    if (
      input.executionMode === "live" &&
      input.intent === "ENTRY" &&
      input.decisionOwner === "agent" &&
      this.options.database.isGrandfatheredPosition(
        input.conditionId,
        input.tokenId,
        zonedDayKey(nowMs, "Europe/Madrid")
      )
    ) {
      throw new ProposalRejectedError([
        {
          code: "INVALID_ORDER_INTENT",
          message:
            "An adopted position is grandfathered reduce-only and cannot be increased."
        }
      ]);
    }

    const activeSession = this.options.database.getActiveTradingSession(input.executionMode, this.now());
    if (!activeSession && (input.executionMode === "paper" || input.intent === "ENTRY")) {
      throw new ProposalRejectedError([
        {
          code: "SESSION_INACTIVE",
          message: `No active authorized trading session for mode '${input.executionMode}'. An authorized trading session with a pUSD budget must be configured before staging orders.`
        }
      ]);
    }

    const sharesMicros = parseDecimalToMicros(input.shares);
    const limitPriceMicros = parseDecimalToMicros(input.limitPrice);
    const estimatedProbabilityMicros = parseDecimalToMicros(
      input.estimatedProbability
    );

    if (input.executionMode === "live" && input.intent === "ENTRY") {
      const status = await this.getAccountStatus();
      if (status.mode !== "live_ready") {
        throw new Error(
          "LIVE_AUTONOMY_NOT_READY: Live ENTRY mode is currently locked or unconfigured. Verify live environment flag, paper gate, signer, and active session budget."
        );
      }
    }

    if (input.executionMode === "paper") {
      await this.options.paperGate.metrics();
    }

    const snapshotProvider =
      input.executionMode === "live" && input.decisionOwner === "agent"
        ? this.options.getAgentMarketSnapshot
        : undefined;
    if (
      input.executionMode === "live" &&
      input.decisionOwner === "agent" &&
      snapshotProvider === undefined
    ) {
      throw new Error("MARKET_CHANNEL_UNAVAILABLE");
    }
    const snapshot = await (snapshotProvider ??
      this.options.marketData.getMarketSnapshot.bind(this.options.marketData))({
      conditionId: input.conditionId,
      tokenId: input.tokenId,
      outcome: input.outcome,
      side: input.side,
      limitPriceMicros
    });
    const researchBundle = input.researchBundleId
      ? this.options.database.getResearchBundle(input.researchBundleId)
      : null;
    if (
      input.executionMode === "live" &&
      input.intent === "ENTRY" &&
      !isResearchBundleUsable(
        researchBundle,
        snapshot.conditionId,
        snapshot.tokenId,
        estimatedProbabilityMicros,
        this.now(),
        snapshot
      )
    ) {
      throw new ProposalRejectedError([
        {
          code: "SOURCE_VALIDATION_FAILED",
          message:
            "Live ENTRY orders require a current verified research bundle matching the market and probability."
        }
      ]);
    }
    if (input.executionMode === "live" && input.intent === "ENTRY" && input.decisionOwner === "agent") {
      if (
        (researchBundle?.evidenceKind !== "MARKET_DATA" && researchBundle?.evidenceKind !== "HYBRID") ||
        researchBundle.analysisHash === undefined ||
        researchBundle.modelVersion === undefined ||
        input.analysisHash !== researchBundle.analysisHash ||
        input.modelVersion !== researchBundle.modelVersion ||
        researchBundle.agentRunId !== input.agentRunId ||
        researchBundle.agentCycleId === undefined ||
        researchBundle.candidateSnapshotId === undefined
      ) {
        throw new ProposalRejectedError([
          {
            code: "SOURCE_VALIDATION_FAILED",
            message: "Agent entries must bind the exact market evidence analysis hash and model version."
          }
        ]);
      }
    }
    const correlationKey = canonicalCorrelationKey(snapshot);
    const context = await this.options.riskContexts.forOrder(
      snapshot,
      input.side,
      correlationKey,
      input.executionMode
    );
    const intent: OrderIntent = {
      intent: input.intent,
      sessionId: activeSession?.id ?? null,
      researchBundleId: researchBundle?.id ?? null,
      executionMode: input.executionMode,
      market: snapshot,
      side: input.side,
      sharesMicros,
      limitPriceMicros,
      estimatedProbabilityMicros,
      thesis: input.thesis,
      counterThesis: input.counterThesis,
      sources: researchBundle
        ? evidenceSourcesFromResearchBundle(researchBundle)
        : input.sources,
      correlationKey,
      decisionOwner: input.decisionOwner ?? "daemon",
      ...(input.agentRunId === undefined ? {} : { agentRunId: input.agentRunId }),
      ...(input.modelVersion === undefined ? {} : { modelVersion: input.modelVersion }),
      ...(input.analysisHash === undefined ? {} : { analysisHash: input.analysisHash }),
      ...(input.exitReason === undefined
        ? {}
        : { exitReason: input.exitReason })
    };
    let proposal: OrderProposal;
    try {
      proposal = createOrderProposal(
        intent,
        context,
        input.executionMode === "live" && input.decisionOwner === "agent"
          ? this.options.database.getAgentPolicy().risk
          : DEFAULT_RISK_POLICY
      );
    } catch (error) {
      if (error instanceof ProposalRejectedError) {
        this.options.database.appendAudit(
          input.executionMode === "paper"
            ? "PAPER_RISK_VIOLATION"
            : "LIVE_RISK_VIOLATION",
          null,
          {
            conditionId: snapshot.conditionId,
            tokenId: snapshot.tokenId,
            codes: error.violations.map((violation) => violation.code)
          }
        );
      }
      throw error;
    }

    if (proposal.executionMode === "live" && proposal.intent === "ENTRY") {
      enforceInitialCanaryEntry(proposal, context, this.options.database.countCanaryEligibleExecutions());
    }

    if (proposal.intent !== "EXIT") {
      if (!activeSession) {
        throw new ProposalRejectedError([
          {
            code: "SESSION_INACTIVE",
            message: "The entry proposal requires an active trading session."
          }
        ]);
      }
      const sessionCheck = isSessionValid(activeSession, proposal.maxLossMicros, this.now());
      if (!sessionCheck.valid) {
        throw new ProposalRejectedError([
          {
            code: "SESSION_BUDGET_EXCEEDED",
            message: sessionCheck.reason ?? "Insufficient session budget including fee reservation."
          }
        ]);
      }
    }
    let settledExitSharesMicros: bigint | undefined;
    if (proposal.executionMode === "live" && proposal.intent === "EXIT") {
      const portfolio = await this.getPortfolio();
      settledExitSharesMicros = portfolio.positions
        .filter((position) => position.tokenId === proposal.market.tokenId)
        .reduce((total, position) => total + position.sizeMicros, 0n);
    }
    this.options.database.stageProposal(proposal, settledExitSharesMicros);

    if (input.executionMode === "paper") {
      const paperTrade = this.paperSimulator.tryImmediateFill(proposal, snapshot);
      this.options.database.savePaperTrade(paperTrade);
      const simulated = this.options.database.transitionProposal(
        proposal.id,
        "STAGED",
        "SIMULATED",
        this.now()
      );
      return {
        proposal: simulated ?? { ...proposal, status: "SIMULATED" },
        paperTrade
      };
    }

    return { proposal, paperTrade: null };
  }

  async executeStagedProposal(
    proposalId: string,
    proposalHash: string
  ): Promise<{ accepted: boolean; message: string }> {
    const proposal = this.options.database.getProposal(proposalId);
    const nowMs = this.now();
    if (
      !proposal ||
      proposal.executionMode !== "live" ||
      proposal.hash !== proposalHash ||
      proposal.expiresAtMs < nowMs
    ) {
      throw new Error("The exact live proposal is missing, changed, or expired.");
    }

    const activeSession = this.options.database.getActiveTradingSession("live", nowMs);
    if (proposal.intent === "ENTRY" && !activeSession) {
      throw new Error("LIVE_AUTONOMY_NOT_READY: No active authorized live trading session found.");
    }
    if (proposal.decisionOwner === "agent") {
      const activeAgentRun = this.options.database.getAgentRun(nowMs);
      if (
        proposal.agentRunId === undefined ||
        activeAgentRun?.status !== "ACTIVE" ||
        activeAgentRun.agentRunId !== proposal.agentRunId ||
        !this.options.database.isAgentRunActive(proposal.agentRunId, nowMs)
      ) {
        throw new Error("AGENT_RUN_NOT_ACTIVE: Agent lease expired or no longer owns this proposal.");
      }
    } else if (proposal.intent === "ENTRY") {
      const activeAgentRun = this.options.database.getAgentRun(nowMs);
      if (activeAgentRun?.status === "ACTIVE") {
        throw new Error("AGENT_RUN_OWNS_ENTRIES: Deterministic daemon entry is paused while an agent lease is active.");
      }
    }

    try {
      await this.assertLiveGates(proposal.intent);
      await this.revalidateProposal(proposal);

      const claimed = this.options.database.claimAutonomousExecution(
        proposal.id,
        proposal.hash,
        proposal.intent === "ENTRY" ? activeSession?.id ?? null : null,
        nowMs,
        proposal.agentRunId ?? null
      );

      if (!claimed) {
        return { accepted: false, message: "Execution claim failed or session budget exceeded." };
      }

      const liveTrading = this.options.liveTrading;
      if (!liveTrading) {
        throw new Error("Live trading adapter is not configured.");
      }

      const result = await liveTrading.submitGtd(proposal, async () => {
        await this.assertLiveGates(proposal.intent);
        await this.revalidateProposal(proposal);
      });

      if (
        result.orderId === null ||
        result.orderId.trim().length === 0 ||
        result.orderId.length > 512
      ) {
        throw new SafeExternalServiceError(
          "The CLOB submission result is unknown; reconciliation is required.",
          {
            code: "CLOB_ORDER_SUBMISSION_UNKNOWN",
            service: "clob",
            retryable: false,
            submissionMayHaveReachedCLOB: true
          }
        );
      }

      this.options.database.markExecutionSubmitted({
        proposalId: proposal.id,
        proposalHash: proposal.hash,
        clobOrderId: result.orderId,
        status: "SUBMITTED_UNRECONCILED",
        submittedAtMs: this.now(),
        responseJson: stringifyWithBigInts(result.response)
      });

      await liveTrading.startHeartbeat();
      return {
        accepted: true,
        message: result.orderId
          ? `Polymarket order ${result.orderId} was submitted with status ${result.status}.`
          : `Polymarket accepted the request with status ${result.status}.`
      };
    } catch (error) {
      if (isSubmissionUnknown(error)) {
        const safe =
          error instanceof SafeExternalServiceError
            ? error
            : new SafeExternalServiceError(
                "The CLOB submission result is unknown; reconciliation is required.",
                {
                  code: "CLOB_ORDER_SUBMISSION_UNKNOWN",
                  service: "clob",
                  retryable: false,
                  submissionMayHaveReachedCLOB: true
                }
              );
        this.options.database.markExecutionSubmissionUnknown(
          proposal.id,
          proposal.hash,
          stringifyWithBigInts({
            submissionUnknown: true,
            code: safe.code,
            message: safe.message,
            recordedAtMs: this.now()
          }),
          this.now()
        );
      } else {
        this.options.database.markExecutionFailed(proposal.id, proposal.hash);
      }
      this.options.database.setEmergencyStop(
        true,
        safeErrorCode(error),
        this.now()
      );
      if (this.options.liveTrading) {
        try {
          await withTimeout(
            this.options.liveTrading.cancelAll(),
            10_000,
            "CANCEL_ALL_TIMEOUT"
          );
        } catch {}
        try {
          await this.options.liveTrading.stopHeartbeat();
        } catch {}
      }
      return {
        accepted: false,
        message: "Execution failed safely; the emergency lock is active."
      };
    }
  }

  async supervisePositions(): Promise<{
    actions: Array<{ tokenId: string; conditionId: string; question: string; shouldExit: boolean; triggerReason: ExitState; explanation: string; recommendedOrderSide: OrderSide }>;
  }> {
    const portfolio = await this.getPortfolio();
    const actions: Array<{ tokenId: string; conditionId: string; question: string; shouldExit: boolean; triggerReason: ExitState; explanation: string; recommendedOrderSide: OrderSide }> = [];
    const nowMs = this.now();

    const shadowMode = !this.options.liveEnvironmentEnabled;
    for (const p of portfolio.positions) {
      let rec = this.options.database.getPositionRecord(p.tokenId);
      if (!rec) {
        rec = {
          tokenId: p.tokenId,
          conditionId: p.conditionId,
          question: p.question,
          outcome: p.outcome,
          side: "BUY",
          sharesMicros: p.sizeMicros,
          averagePriceMicros: p.averagePriceMicros,
          evidenceQuality: "LEGACY_UNVERIFIED",
          entryFeesMicros: null,
          entryTransactionHashesJson: "[]",
          entryProbabilityMicros: null,
          entryEdgeMicros: null,
          openedAtMs: nowMs,
          lastEvaluatedAtMs: nowMs,
          lastMarketPriceMicros: p.currentPriceMicros,
          lastEstimatedProbabilityMicros: null,
          lastResearchBundleId: null,
          sourcesJson: "[]",
          researchRequiredSinceMs: null,
          researchRequiredAtPriceMicros: null,
          minimumResearchCreatedAtMs: null,
          exitState: "LEGACY_UNVERIFIED",
          activeExitProposalId: null,
          activeExitOrderId: null
        };
      }

      const activeExecution = rec.activeExitProposalId
        ? this.options.database.getExecution(rec.activeExitProposalId)
        : null;
      if (
        activeExecution &&
        ["CANCELLED", "CANCELED", "EXPIRED", "CONFIRMED", "REJECTED"].includes(
          activeExecution.status.toUpperCase()
        )
      ) {
        rec = {
          ...rec,
          activeExitProposalId: null,
          activeExitOrderId: null,
          exitState: p.sizeMicros === 0n ? "CLOSED" : "HOLDING"
        };
      }

      const researchBundle = this.options.database.getLatestResearchBundle(
        p.conditionId,
        p.tokenId,
        nowMs
      );
      const action = evaluatePositionExitPolicy(
        rec,
        p.currentPriceMicros,
        researchBundle?.estimatedProbabilityMicros ?? null,
        researchBundle?.id ?? null,
        p.endTimeMs,
        nowMs,
        researchBundle?.createdAtMs ?? null
      );

      const shadowRecommendation =
        shadowMode && action.shouldExit;
      if (action.triggerReason === "RESEARCH_REQUIRED") {
        rec = {
          ...rec,
          researchRequiredSinceMs: rec.researchRequiredSinceMs ?? nowMs,
          researchRequiredAtPriceMicros:
            rec.researchRequiredAtPriceMicros ?? p.currentPriceMicros,
          minimumResearchCreatedAtMs:
            rec.minimumResearchCreatedAtMs ?? nowMs
        };
      } else if (
        rec.minimumResearchCreatedAtMs !== null &&
        researchBundle !== null &&
        researchBundle.createdAtMs >= rec.minimumResearchCreatedAtMs
      ) {
        rec = {
          ...rec,
          researchRequiredSinceMs: null,
          researchRequiredAtPriceMicros: null,
          minimumResearchCreatedAtMs: null
        };
      }

      rec = {
        ...rec,
        sharesMicros: p.sizeMicros,
        averagePriceMicros: p.averagePriceMicros,
        lastEvaluatedAtMs: nowMs,
        lastMarketPriceMicros: p.currentPriceMicros,
        lastEstimatedProbabilityMicros:
          researchBundle?.estimatedProbabilityMicros ??
          rec.lastEstimatedProbabilityMicros,
        lastResearchBundleId:
          researchBundle?.id ?? rec.lastResearchBundleId,
        exitState:
          rec.exitState === "CLOSING" || rec.exitState === "CLOSED"
            ? rec.exitState
            : action.triggerReason
      };

      if (
        action.shouldExit &&
        !shadowRecommendation &&
        rec.activeExitProposalId === null &&
        rec.exitState !== "CLOSING" &&
        rec.exitState !== "CLOSED"
      ) {
        try {
          const snapshot = await this.getMarketSnapshot({ conditionId: p.conditionId, tokenId: p.tokenId, outcome: p.outcome });
          if (snapshot.bestBidMicros <= 0n) {
            throw new Error("EXIT_BID_UNAVAILABLE");
          }
          const limitPricePusd = formatMicros(snapshot.bestBidMicros);
          const sharesPusd = formatMicros(p.sizeMicros);
          const exitReason = toExitReason(action.triggerReason);

          const staged = await this.stageOrder({
            executionMode: this.options.liveEnvironmentEnabled ? "live" : "paper",
            intent: "EXIT",
            tokenId: p.tokenId,
            conditionId: p.conditionId,
            outcome: p.outcome,
            side: "SELL",
            shares: sharesPusd,
            limitPrice: limitPricePusd,
            estimatedProbability:
              rec.lastEstimatedProbabilityMicros === null
                ? "0"
                : formatMicros(rec.lastEstimatedProbabilityMicros),
            exitReason,
            thesis: `Position exit supervisor auto-execution triggered: ${action.triggerReason}. ${action.explanation}`,
            counterThesis: "Position supervisor exit policy execution mandated to control downside risk.",
            sources: []
          });

          let exitAccepted =
            staged.proposal.executionMode === "paper" &&
            staged.paperTrade !== null &&
            staged.paperTrade.filledSharesMicros > 0n;
          let exitOrderId: string | null = null;
          if (staged.proposal.executionMode === "live") {
            const result = await this.executeStagedProposal(
              staged.proposal.id,
              staged.proposal.hash
            );
            exitAccepted =
              result.accepted &&
              this.options.database.getExecution(staged.proposal.id) !== null;
            exitOrderId =
              this.options.database.getExecution(staged.proposal.id)?.clobOrderId ??
              null;
          }
          if (exitAccepted) {
            rec = {
              ...rec,
              exitState: "CLOSING",
              activeExitProposalId: staged.proposal.id,
              activeExitOrderId: exitOrderId
            };
          } else {
            rec = {
              ...rec,
              activeExitProposalId: null,
              activeExitOrderId: null
            };
          }
        } catch {
          // Retain state if execution fails safely
        }
      }

      if (shadowMode) {
        if (action.shouldExit) {
          this.options.database.appendAudit("SHADOW_EXIT_RECOMMENDED", p.tokenId, {
            conditionId: p.conditionId,
            sharesMicros: p.sizeMicros,
            currentPriceMicros: p.currentPriceMicros,
            triggerReason: action.triggerReason,
            explanation: action.explanation,
            evaluatedAtMs: nowMs
          });
        }
      } else {
        this.options.database.savePositionRecord(rec, nowMs);
      }
      actions.push({
        tokenId: p.tokenId,
        conditionId: p.conditionId,
        question: p.question,
        shouldExit: action.shouldExit,
        triggerReason: action.triggerReason,
        explanation: action.explanation,
        recommendedOrderSide: action.recommendedOrderSide
      });
    }

    return { actions };
  }

  async cancelOrder(orderId: string) {
    if (!this.options.liveTrading) {
      throw new Error("Live trading adapter is not configured.");
    }
    return this.options.liveTrading.cancelOrder(orderId);
  }

  async emergencyStop(reason: string) {
    this.options.database.setEmergencyStop(true, reason, this.now());
    if (!this.options.liveTrading) {
      return { locked: true, canceled: false, reason: "No live adapter configured." };
    }
    try {
      const response = await withTimeout(
        this.options.liveTrading.cancelAll(),
        10_000,
        "CANCEL_ALL_TIMEOUT"
      );
      await this.options.liveTrading.stopHeartbeat();
      return { locked: true, canceled: true, response };
    } catch {
      return {
        locked: true,
        canceled: false,
        reason: "Cancellation could not be confirmed; the lock remains active."
      };
    }
  }

  async monitorLiveSafety(): Promise<boolean> {
    if (!this.options.database.verifyAuditChain()) {
      throw new Error("AUDIT_CHAIN_INVALID");
    }
    const initialExecutions = this.options.database.listExecutions();
    const reconciliationOnly = initialExecutions.some(
      (execution) =>
        execution.status.toUpperCase() === "CLAIMED" ||
        execution.status.toUpperCase() === "SUBMISSION_UNKNOWN" ||
        (execution.clobOrderId !== null &&
          !TERMINAL_MONITORED_STATUSES.has(execution.status.toUpperCase()))
    );
    if (!this.options.liveEnvironmentEnabled && !reconciliationOnly) {
      return false;
    }
    if (!this.options.database.getLiveActivation().active && !reconciliationOnly) {
      return false;
    }
    if (this.options.database.getEmergencyStop().active && !reconciliationOnly) {
      return false;
    }
    const liveTrading = this.options.liveTrading;
    if (liveTrading === null) {
      throw new Error("LIVE_ADAPTER_NOT_CONFIGURED");
    }

    const activitySinceMs = zonedDayStartMs(
      this.now(),
      "Europe/Madrid"
    );
    const [risk, openOrders, userActivity, portfolio] = await Promise.all([
      this.options.riskContexts.summary(),
      liveTrading.getOpenOrders(),
      this.options.marketData.getUserActivity(
        this.options.profileAddress,
        activitySinceMs
      ),
      this.options.marketData.getPortfolio(this.options.profileAddress)
    ]);
    const policy = this.options.database.getAgentPolicy().risk;
    if (!reconciliationOnly && !risk.dailyPnlKnown) {
      throw new Error("DAILY_PNL_UNAVAILABLE");
    }
    if (!reconciliationOnly && risk.dailyPnlMicros <= -DEFAULT_RISK_POLICY.dailyStopMicros) {
      throw new Error("DAILY_STOP");
    }
    if (
      !reconciliationOnly &&
      risk.coolingDownUntilMs !== null &&
      risk.coolingDownUntilMs > this.now()
    ) {
      throw new Error("COOLING_DOWN");
    }
    const maxExposure =
      risk.liveTradeCount < policy.canaryTradeCount
        ? policy.canaryMaxOpenExposureMicros
        : policy.pilotMaxOpenExposureMicros;
    if (!reconciliationOnly && risk.totalOpenExposureMicros > maxExposure) {
      throw new Error("TOTAL_EXPOSURE");
    }
    if (!reconciliationOnly && risk.openMarketCount > policy.maxOpenMarkets) {
      throw new Error("TOO_MANY_MARKETS");
    }
    for (const execution of initialExecutions.filter(
      (candidate) => candidate.status.toUpperCase() === "SUBMISSION_UNKNOWN"
    )) {
      const proposal = this.options.database.getProposal(execution.proposalId);
      if (proposal === null) {
        throw new Error("UNKNOWN_EXECUTION_PROPOSAL_MISSING");
      }
      const matchingOrders = openOrders.filter(
        (order) =>
          readStringValue(order.metadata)?.toLowerCase() ===
          `0x${proposal.hash}`.toLowerCase()
      );
      if (matchingOrders.length > 1) {
        throw new Error("MULTIPLE_ORDERS_MATCH_UNKNOWN_PROPOSAL");
      }
      const orderId = matchingOrders[0]?.id;
      if (typeof orderId === "string") {
        this.options.database.bindUncertainExecutionOrder(
          proposal.id,
          proposal.hash,
          orderId,
          this.now()
        );
      }
    }
    const executions = this.options.database.listExecutions();
    assertUserActivityBijection(
      this.options.database,
      executions.filter(
        (execution) => execution.status.toUpperCase() !== "SUBMISSION_UNKNOWN"
      ),
      userActivity,
      activitySinceMs,
      this.now()
    );

    const executionsByOrderId = new Map(
      executions
        .filter(
          (
            execution
          ): execution is typeof execution & { clobOrderId: string } =>
            execution.clobOrderId !== null
        )
        .map((execution) => [execution.clobOrderId, execution] as const)
    );
    if (
      executionsByOrderId.size !==
      executions.filter((execution) => execution.clobOrderId !== null).length
    ) {
      throw new Error("DUPLICATE_LOCAL_ORDER_ID");
    }
    const openOrdersById = new Map<string, Record<string, unknown>>();
    for (const order of openOrders) {
      const orderId = readRequiredRemoteString(order.id, "OPEN_ORDER_ID");
      if (openOrdersById.has(orderId)) {
        throw new Error("DUPLICATE_REMOTE_OPEN_ORDER");
      }
      openOrdersById.set(orderId, order);
      const execution = executionsByOrderId.get(orderId);
      if (execution === undefined) {
        throw new Error("UNTRACKED_OPEN_ORDERS");
      }
      if (TERMINAL_MONITORED_STATUSES.has(execution.status.toUpperCase())) {
        throw new Error("TERMINAL_LEDGER_ORDER_STILL_OPEN");
      }
    }

    const monitored = executions.filter(
      (execution) =>
        !TERMINAL_MONITORED_STATUSES.has(execution.status.toUpperCase()) ||
        (execution.clobOrderId !== null &&
          openOrdersById.has(execution.clobOrderId))
    );
    for (const execution of monitored) {
      if (execution.clobOrderId === null) {
        throw new Error(
          execution.status.toUpperCase() === "SUBMISSION_UNKNOWN"
            ? "SUBMISSION_UNKNOWN_REQUIRES_RECONCILIATION"
            : "CLAIMED_EXECUTION_UNRESOLVED"
        );
      }
      const proposal = this.options.database.getProposal(execution.proposalId);
      if (
        proposal === null ||
        proposal.executionMode !== "live" ||
        !verifyProposalHash(proposal) ||
        proposal.correlationKey !== canonicalCorrelationKey(proposal.market)
      ) {
        throw new Error("LIVE_PROPOSAL_LEDGER_INVALID");
      }
      const [remote, refreshed] = await Promise.all([
        liveTrading.getOrderStatus(execution.clobOrderId),
        this.options.marketData.getMarketSnapshot({
          conditionId: proposal.market.conditionId,
          tokenId: proposal.market.tokenId,
          outcome: proposal.market.outcome
        })
      ]);
      if (remote === null) {
        throw new Error("REMOTE_ORDER_MISSING");
      }
      assertSameMarketContract(proposal.market, refreshed);
      if (
        !refreshed.active ||
        refreshed.closed ||
        !refreshed.acceptingOrders ||
        this.now() - refreshed.capturedAtMs >
          DEFAULT_RISK_POLICY.maxSnapshotAgeMs
      ) {
        throw new Error("MONITORED_MARKET_UNSAFE");
      }
      await this.reconcileRemoteExecution(
        proposal,
        execution.clobOrderId,
        remote,
        liveTrading,
        openOrdersById.has(execution.clobOrderId),
        userActivity,
        portfolio
      );
    }
    // The first pass permits a bounded propagation window for a Data API
    // activity that reached us just before its CLOB trade attribution. Repeat
    // after REST reconciliation so a fill visible in this same cycle must now
    // be bijectively attributable to the local ledger.
    assertUserActivityBijection(
      this.options.database,
      this.options.database.listExecutions(),
      userActivity,
      activitySinceMs,
      this.now(),
      false
    );
    // Capture geoblock last. A slow sibling reconciliation request must not
    // age an otherwise valid geoblock result past the five-second safety
    // window before this cycle returns.
    if (!reconciliationOnly) {
      await this.assertFreshGeoblock();
    }
    return monitored.length > 0 || openOrdersById.size > 0;
  }

  private collectLegacyLocalEvidence(tokenId: string): LegacyLocalEvidence {
    const proposals = this.options.database
      .listProposals()
      .filter((proposal) => proposal.market.tokenId === tokenId);
    const fills: LegacyLocalFill[] = [];
    const transactionHashes: string[] = [];
    let reconciledOrderCount = 0;
    let feesMicros = 0n;
    let feesKnown = true;
    let feeEvidenceCount = 0;

    for (const proposal of proposals) {
      const execution = this.options.database.getExecution(proposal.id);
      if (execution === null || execution.status.toUpperCase() !== "CONFIRMED") {
        continue;
      }
      reconciledOrderCount += 1;
      const response = parseLegacyExecutionResponse(execution.responseJson);
      const onchain = readRecordValue(response.onchain);
      const fee = onchain?.feeMicros;
      if (typeof fee === "bigint" && fee >= 0n) {
        feesMicros += fee;
        feeEvidenceCount += 1;
      } else {
        feesKnown = false;
      }
      for (const rawFill of readRecordArrayValue(response.attributedTrades)) {
        if (rawFill.status !== "CONFIRMED") {
          continue;
        }
        const sharesMicros = rawFill.sharesMicros;
        const priceMicros = rawFill.priceMicros;
        const timestampMs = rawFill.matchTimeMs;
        if (
          typeof sharesMicros !== "bigint" ||
          sharesMicros <= 0n ||
          typeof priceMicros !== "bigint" ||
          priceMicros <= 0n ||
          priceMicros > PUSD_SCALE ||
          typeof timestampMs !== "number" ||
          !Number.isSafeInteger(timestampMs) ||
          timestampMs <= 0
        ) {
          continue;
        }
        const transactionHash =
          typeof rawFill.transactionHash === "string" &&
          /^0x[a-fA-F0-9]{64}$/u.test(rawFill.transactionHash)
            ? rawFill.transactionHash.toLowerCase()
            : null;
        if (transactionHash !== null) {
          transactionHashes.push(transactionHash);
        }
        fills.push({
          side: proposal.side,
          sharesMicros,
          priceMicros,
          timestampMs,
          transactionHash
        });
      }
    }

    return {
      orderCount: proposals.length,
      reconciledOrderCount,
      fills,
      feesMicros:
        feesKnown && feeEvidenceCount === reconciledOrderCount
          ? feesMicros
          : null,
      transactionHashes
    };
  }

  private async reconcileRemoteExecution(
    proposal: OrderProposal,
    orderId: string,
    remote: Record<string, unknown>,
    liveTrading: LiveTradingPort,
    remotelyOpen: boolean,
    userActivity: UserTradeActivity[],
    portfolio: PortfolioSnapshot
  ): Promise<void> {
    const binding = this.options.database.getAccountBinding();
    if (binding === null) {
      throw new Error("ACCOUNT_BINDING_MISSING");
    }
    const orderState = assertRemoteOrderMatchesProposal(
      proposal,
      orderId,
      binding.funderAddress,
      remote
    );
    const execution = this.options.database.getExecution(proposal.id);
    if (
      execution === null ||
      execution.clobOrderId?.toLowerCase() !== orderId.toLowerCase()
    ) {
      throw new Error("LIVE_EXECUTION_LEDGER_MISSING");
    }
    const response = parseExecutionResponse(execution.responseJson);
    const localOrder =
      response.submissionUnknown === true
        ? null
        : assertLocalOrderEvidence(
            proposal,
            orderId,
            response,
            orderState.expiration
          );
    const tradeIds = [
      ...readRemoteStringArray(response.tradeIDs),
      ...readRemoteStringArray(remote.associateTrades)
    ].filter((value, index, values) => values.indexOf(value) === index);
    const trades = await liveTrading.getTrades(tradeIds);
    if (
      trades.length !== tradeIds.length ||
      new Set(
        trades.map((trade) =>
          readRequiredRemoteString(trade.id, "TRADE_ID")
        )
      ).size !== trades.length
    ) {
      throw new Error("REMOTE_TRADE_SET_MISMATCH");
    }
    const attributedTrades: AttributedTrade[] = [];
    for (const tradeId of tradeIds) {
      const trade = trades.find((candidate) => candidate.id === tradeId);
      if (trade === undefined) {
        throw new Error("REMOTE_TRADE_MISSING");
      }
      attributedTrades.push(
        assertRemoteTradeMatchesProposal(
          proposal,
          orderId,
          tradeId,
          binding.funderAddress,
          trade
        )
      );
    }
    const tradeStatuses = attributedTrades.map((trade) => trade.status);
    if (tradeStatuses.some((status) => status === "FAILED")) {
      throw new Error("REMOTE_TRADE_FAILED");
    }
    const { status: orderStatus, originalSize, sizeMatched } = orderState;
    const attributedShares = attributedTrades.reduce(
      (total, trade) => total + trade.sharesMicros,
      0n
    );
    if (attributedShares !== sizeMatched) {
      throw new Error("REMOTE_TRADE_FILL_SIZE_MISMATCH");
    }
    const allTradesConfirmed =
      tradeStatuses.length > 0 &&
      tradeStatuses.every((candidate) => candidate === "CONFIRMED");
    const userChannel = assessUserChannelEvidence(
      this.options.database,
      proposal,
      orderId,
      attributedTrades,
      execution.submittedAtMs,
      this.now()
    );
    if (
      !userChannel.hasAny &&
      this.now() - execution.submittedAtMs > 15_000
    ) {
      throw new Error("USER_CHANNEL_EVIDENCE_MISSING");
    }
    const allConfirmedTradesInDataApi =
      allTradesConfirmed &&
      attributedTrades.every((trade) =>
        hasMatchingDataActivity(
          proposal,
          trade,
          userActivity,
          this.now()
        )
      );
    const onchain =
      sizeMatched > 0n &&
      allTradesConfirmed &&
      userChannel.allConfirmedTradesPresent &&
      allConfirmedTradesInDataApi
        ? await this.options.onchainSettlement.verifySettlement({
            proposal,
            orderId,
            makerAddress: binding.funderAddress,
            sizeMatchedMicros: sizeMatched,
            expirationEpochSeconds: localOrder?.expiration ?? orderState.expiration,
            transactions: attributedTrades.map((trade) => ({
              transactionHash: trade.transactionHash!,
              role: trade.role,
              sharesMicros: trade.sharesMicros,
              matchTimeMs: trade.matchTimeMs
            }))
          })
        : null;
    const portfolioConverged =
      onchain !== null &&
      onchain.finalized &&
      portfolioMatchesSettledLedger(
        this.options.database,
        portfolio,
        proposal,
        onchain.filledSharesMicros
      );
    if (
      onchain !== null &&
      onchain.finalized &&
      !portfolioConverged &&
      attributedTrades.every(
        (trade) => this.now() - trade.lastUpdateMs > 120_000
      )
    ) {
      throw new Error("PORTFOLIO_SETTLEMENT_DID_NOT_CONVERGE");
    }
    const fullyReconciled =
      userChannel.allConfirmedTradesPresent &&
      allConfirmedTradesInDataApi &&
      onchain !== null &&
      onchain.finalized &&
      onchain.filledSharesMicros === sizeMatched &&
      portfolioConverged;
    const hasExpectedTradeSet =
      sizeMatched === 0n ? tradeIds.length === 0 : tradeIds.length > 0;
    if (!hasExpectedTradeSet) {
      throw new Error("REMOTE_FILL_TRADE_SET_INCONSISTENT");
    }

    const remotelyLive = orderStatus === "LIVE";
    if (remotelyOpen !== remotelyLive) {
      throw new Error("REMOTE_OPEN_ORDER_STATE_INCONSISTENT");
    }

    let status: string;
    if (remotelyLive) {
      if (sizeMatched >= originalSize) {
        throw new Error("REMOTE_LIVE_ORDER_FULLY_MATCHED");
      }
      status = sizeMatched > 0n ? "PARTIALLY_FILLED" : "LIVE";
    } else if (orderStatus === "MATCHED" || orderStatus === "FILLED") {
      if (sizeMatched !== originalSize) {
        throw new Error("REMOTE_TERMINAL_FILL_SIZE_INCONSISTENT");
      }
      status = fullyReconciled ? "CONFIRMED" : "RECONCILING";
    } else if (
      orderStatus === "CANCELLED" ||
      orderStatus === "CANCELED" ||
      orderStatus === "EXPIRED" ||
      orderStatus === "REJECTED"
    ) {
      status =
        sizeMatched === 0n || fullyReconciled
          ? orderStatus
          : "RECONCILING";
    } else {
      throw new Error("REMOTE_ORDER_STATUS_UNSUPPORTED");
    }
    if (
      execution.status.toUpperCase() === "RECONCILING" &&
      (status === "LIVE" || status === "PARTIALLY_FILLED")
    ) {
      status = "RECONCILING";
    }

    this.options.database.updateExecutionStatus(
      proposal.id,
      status,
      stringifyWithBigInts({
        ...response,
        order: remote,
        trades,
        tradeIDs: tradeIds,
        attributedTrades,
        onchain
      }),
      this.now()
    );
    if (
      status === "CONFIRMED" &&
      proposal.intent === "ENTRY" &&
      onchain !== null &&
      onchain.finalized
    ) {
      this.saveVerifiedEntryPosition(
        proposal,
        portfolio,
        onchain,
        attributedTrades,
        this.now()
      );
    }
    if (
      status === "CONFIRMED" &&
      proposal.intent === "EXIT" &&
      onchain !== null &&
      onchain.finalized
    ) {
      this.recordConfirmedExitLoss(proposal, onchain, this.now());
    }
  }

  private recordConfirmedExitLoss(
    proposal: OrderProposal,
    onchain: NonNullable<
      Awaited<ReturnType<OnchainSettlementPort["verifySettlement"]>>
    >,
    nowMs: number
  ): void {
    const position = this.options.database.getPositionRecord(
      proposal.market.tokenId
    );
    if (
      position === null ||
      position.conditionId.toLowerCase() !==
        proposal.market.conditionId.toLowerCase()
    ) {
      return;
    }
    const costBasisMicros =
      (onchain.filledSharesMicros * position.averagePriceMicros + 999_999n) /
      1_000_000n;
    const netProceedsMicros =
      onchain.grossCostMicros > onchain.feeMicros
        ? onchain.grossCostMicros - onchain.feeMicros
        : 0n;
    if (netProceedsMicros < costBasisMicros) {
      const settledAtMs = Math.max(nowMs, ...onchain.blockTimestampsMs);
      this.options.database.recordAgentMarketLoss(
        proposal.market.conditionId,
        settledAtMs
      );
    }
  }

  private saveVerifiedEntryPosition(
    proposal: OrderProposal,
    portfolio: PortfolioSnapshot,
    onchain: NonNullable<Awaited<ReturnType<OnchainSettlementPort["verifySettlement"]>>>,
    attributedTrades: AttributedTrade[],
    nowMs: number
  ): void {
    const portfolioPosition = portfolio.positions.find(
      (candidate) =>
        candidate.tokenId === proposal.market.tokenId &&
        candidate.conditionId === proposal.market.conditionId &&
        candidate.sizeMicros > 0n
    );
    if (portfolioPosition === undefined) {
      throw new Error("CONFIRMED_ENTRY_PORTFOLIO_POSITION_MISSING");
    }
    const existing = this.options.database.getPositionRecord(proposal.market.tokenId);
    const transactionHashes = uniqueHashes([
      ...entryTransactionHashes(existing),
      ...onchain.transactionHashes,
      ...attributedTrades
        .map((trade) => trade.transactionHash)
        .filter((hash): hash is string => hash !== null)
    ]);
    const fillTimes = [
      ...attributedTrades.map((trade) => trade.matchTimeMs),
      ...onchain.blockTimestampsMs
    ].filter((value) => Number.isSafeInteger(value) && value > 0);
    const observedOpenedAtMs = fillTimes.length > 0 ? Math.min(...fillTimes) : null;
    const openedAtMs =
      existing?.openedAtMs === null || existing?.openedAtMs === undefined
        ? observedOpenedAtMs
        : observedOpenedAtMs === null
          ? existing.openedAtMs
          : Math.min(existing.openedAtMs, observedOpenedAtMs);
    const exitState =
      existing?.exitState === "CLOSING" || existing?.exitState === "CLOSED"
        ? existing.exitState
        : "HOLDING";
    const positionRecord: PositionRecord = {
      tokenId: portfolioPosition.tokenId,
      conditionId: portfolioPosition.conditionId,
      question: portfolioPosition.question,
      outcome: portfolioPosition.outcome,
      side: proposal.side,
      sharesMicros: portfolioPosition.sizeMicros,
      averagePriceMicros: portfolioPosition.averagePriceMicros,
      evidenceQuality: "VERIFIED",
      entryFeesMicros:
        (existing?.entryFeesMicros ?? 0n) + onchain.feeMicros,
      entryTransactionHashesJson: JSON.stringify(transactionHashes),
      entryProbabilityMicros: proposal.estimatedProbabilityMicros,
      entryEdgeMicros: proposal.expectedEdgeMicros,
      openedAtMs,
      lastEvaluatedAtMs: nowMs,
      lastMarketPriceMicros: portfolioPosition.currentPriceMicros,
      lastEstimatedProbabilityMicros: proposal.estimatedProbabilityMicros,
      lastResearchBundleId: proposal.researchBundleId ?? null,
      sourcesJson: stringifyWithBigInts(proposal.sources),
      researchRequiredSinceMs: existing?.researchRequiredSinceMs ?? null,
      researchRequiredAtPriceMicros: existing?.researchRequiredAtPriceMicros ?? null,
      minimumResearchCreatedAtMs: existing?.minimumResearchCreatedAtMs ?? null,
      exitState,
      activeExitProposalId: existing?.activeExitProposalId ?? null,
      activeExitOrderId: existing?.activeExitOrderId ?? null
    };
    this.options.database.savePositionRecord(positionRecord, nowMs);
    this.options.database.appendAudit("POSITION_ENTRY_VERIFIED", proposal.id, {
      tokenId: positionRecord.tokenId,
      conditionId: positionRecord.conditionId,
      openedAtMs,
      filledSharesMicros: onchain.filledSharesMicros,
      feeMicros: onchain.feeMicros,
      transactionHashes
    });
  }

  private async assertLiveGates(intent: OrderIntent["intent"]): Promise<void> {
    if (!this.options.database.verifyAuditChain()) {
      throw new Error("AUDIT_CHAIN_INVALID");
    }
    if (!this.options.liveEnvironmentEnabled) {
      throw new Error("LIVE_ENVIRONMENT_DISABLED");
    }
    if (!this.options.database.getLiveActivation().active) {
      throw new Error("LOCAL_LIVE_ACTIVATION_MISSING");
    }
    if (this.options.database.getEmergencyStop().active) {
      throw new Error("EMERGENCY_STOPPED");
    }
    const [
      paperGate,
      liveConfigured,
      profileExists,
      signerAddress,
      funderAddress,
      signatureType
    ] = await Promise.all([
      this.options.paperGate.result(this.options.paperGateSkip ?? false),
      this.options.liveTrading?.configured() ?? Promise.resolve(false),
      this.options.marketData.profileExists(this.options.profileAddress),
      this.options.accountBinding.signerAddress(),
      this.options.accountBinding.funderAddress(),
      this.options.accountBinding.signatureType()
    ]);
    if (intent === "ENTRY" && !paperGate.passed) {
      throw new Error("PAPER_GATE_NOT_PASSED");
    }
    if (!this.options.liveTrading || !liveConfigured) {
      throw new Error("LIVE_ADAPTER_NOT_CONFIGURED");
    }
    if (
      !profileExists ||
      signerAddress === null ||
      !/^0x[a-fA-F0-9]{40}$/u.test(signerAddress) ||
      funderAddress?.toLowerCase() !==
        this.options.profileAddress.toLowerCase() ||
      (signatureType !== 1 && signatureType !== 3)
    ) {
      throw new Error("ACCOUNT_BINDING_REVALIDATION_FAILED");
    }
    await this.assertFreshGeoblock();
  }

  private async assertFreshGeoblock(): Promise<void> {
    const geo = await this.options.marketData.checkGeoblock();
    if (geo.blocked || this.now() - geo.checkedAtMs > 5_000) {
      throw new Error("GEOBLOCK_BLOCKED_OR_STALE");
    }
  }

  private async revalidateProposal(proposal: OrderProposal): Promise<void> {
    if (!verifyProposalHash(proposal)) {
      throw new Error("PROPOSAL_HASH_INVALID");
    }
    if (proposal.intent === "ENTRY") {
      const bundle = proposal.researchBundleId
        ? this.options.database.getResearchBundle(proposal.researchBundleId)
        : null;
      if (
        !isResearchBundleUsable(
          bundle,
          proposal.market.conditionId,
          proposal.market.tokenId,
          proposal.estimatedProbabilityMicros,
          this.now(),
          proposal.market
        )
      ) {
        throw new Error("RESEARCH_BUNDLE_INVALID");
      }
    }
    const snapshotProvider = proposal.decisionOwner === "agent"
      ? this.options.getAgentMarketSnapshot
      : undefined;
    if (proposal.decisionOwner === "agent" && snapshotProvider === undefined) {
      throw new Error("MARKET_CHANNEL_UNAVAILABLE");
    }
    const refreshed = await (snapshotProvider ??
      this.options.marketData.getMarketSnapshot.bind(this.options.marketData))({
      conditionId: proposal.market.conditionId,
      tokenId: proposal.market.tokenId,
      outcome: proposal.market.outcome,
      side: proposal.side,
      limitPriceMicros: proposal.limitPriceMicros
    });
    assertSameMarketContract(proposal.market, refreshed);
    if (proposal.decisionOwner === "agent") {
      assertAgentMarketSnapshotUnchanged(proposal.market, refreshed);
    }
    const context = await this.options.riskContexts.forOrder(
      refreshed,
      proposal.side,
      proposal.correlationKey,
      "live",
      proposal.id
    );
    const evaluation = evaluateOrderRisk(
      {
        intent: proposal.intent,
        sessionId: proposal.sessionId,
        researchBundleId: proposal.researchBundleId,
        executionMode: "live",
        market: refreshed,
        side: proposal.side,
        sharesMicros: proposal.sharesMicros,
        limitPriceMicros: proposal.limitPriceMicros,
        estimatedProbabilityMicros: proposal.estimatedProbabilityMicros,
        thesis: proposal.thesis,
        counterThesis: proposal.counterThesis,
        sources: proposal.sources,
        correlationKey: proposal.correlationKey,
        ...(proposal.exitReason === undefined
          ? {}
          : { exitReason: proposal.exitReason })
      },
      context,
      proposal.decisionOwner === "agent"
        ? this.options.database.getAgentPolicy().risk
        : DEFAULT_RISK_POLICY
    );
    if (proposal.intent === "ENTRY") {
      enforceInitialCanaryEntry(
        proposal,
        context,
        this.options.database.countCanaryEligibleExecutions()
      );
    }
    if (evaluation.violations.length > 0) {
      throw new ProposalRejectedError(evaluation.violations);
    }
    if (
      evaluation.maxCostMicros !== proposal.maxCostMicros ||
      evaluation.estimatedFeeMicros !== proposal.estimatedFeeMicros ||
      evaluation.expectedEdgeMicros !== proposal.expectedEdgeMicros ||
      evaluation.postTradeMarketExposureMicros !==
        proposal.postTradeMarketExposureMicros ||
      evaluation.postTradeTotalExposureMicros !==
        proposal.postTradeTotalExposureMicros
    ) {
      throw new Error("PROPOSAL_RISK_CONTEXT_CHANGED");
    }
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(code)), timeoutMs);
        timeout.unref();
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function requireResearchFields(input: StageOrderInput, nowMs = Date.now()): void {
  if (input.thesis.trim().length < 20 || input.counterThesis.trim().length < 20) {
    throw new Error("Thesis and counter-thesis must each contain at least 20 characters.");
  }
  if (input.intent === "EXIT") {
    return;
  }
  if (input.researchBundleId !== undefined) {
    return;
  }
  const validation = validateEvidenceSources(input.sources, nowMs);
  if (!validation.valid) {
    throw new ProposalRejectedError([
      {
        code: "SOURCE_VALIDATION_FAILED",
        message: `Source validation failed: ${validation.violations.join("; ")}`
      }
    ]);
  }
}

function isResearchBundleUsable(
  bundle: ResearchBundle | null,
  conditionId: string,
  tokenId: string,
  estimatedProbabilityMicros: bigint,
  nowMs: number,
  snapshot?: MarketSnapshot
): bundle is ResearchBundle {
  if (
    bundle === null ||
    bundle.marketConditionId !== conditionId ||
    bundle.tokenId !== tokenId ||
    bundle.expiresAtMs <= nowMs ||
    bundle.estimatedProbabilityMicros !== estimatedProbabilityMicros
  ) {
    return false;
  }
  if (bundle.evidenceKind === "MARKET_DATA" || bundle.evidenceKind === "HYBRID") {
    if (
      bundle.marketSources === undefined ||
      bundle.marketSources.length < 2 ||
      new Set(bundle.marketSources.map((source) => source.origin)).size < 2 ||
      bundle.marketSources.some(
        (source) =>
          !["CLOB", "GAMMA", "DATA"].includes(source.origin) ||
          !Number.isSafeInteger(source.capturedAtMs) ||
          source.capturedAtMs > nowMs + 60_000 ||
          nowMs - source.capturedAtMs > 5_000 ||
          !/^[a-f0-9]{64}$/u.test(source.snapshotHash) ||
          !/^[a-f0-9]{64}$/u.test(source.payloadHash)
      ) ||
      (snapshot !== undefined &&
        bundle.marketSources.some(
          (source) => source.snapshotHash !== hashMarketSnapshot(snapshot)
        )) ||
      (bundle.evidenceKind === "MARKET_DATA" && bundle.sources.length !== 0) ||
      bundle.modelVersion === undefined ||
      bundle.analysisHash === undefined ||
      !/^[a-f0-9]{64}$/u.test(bundle.analysisHash)
    ) {
      return false;
    }
    if (bundle.evidenceKind === "MARKET_DATA") {
      const { contentHash: _marketContentHash, ...marketContent } = bundle;
      return hashCanonical(marketContent) === bundle.contentHash;
    }
  }
  const maxAgeMs =
    bundle.eventVolatilityClass === "FAST"
      ? CRISIS_SOURCE_AGE_MS
      : MAX_SOURCE_AGE_MS;
  if (
    bundle.sources.length < 2 ||
    new Set(bundle.sources.map((source) => source.registrableDomain)).size < 2 ||
    bundle.sources.some((source) => {
      let parsed: URL;
      try {
        parsed = new URL(source.finalUrl);
      } catch {
        return true;
      }
      return (
        !isRecognizedEvidenceDomain(parsed.hostname) ||
        extractRegistrableDomain(parsed.hostname) !== source.registrableDomain ||
        source.publishedAtMs > nowMs + 60_000 ||
        source.retrievedAtMs > nowMs + 60_000 ||
        source.publishedAtMs > source.retrievedAtMs ||
        nowMs - source.publishedAtMs > maxAgeMs ||
        !/^https:\/\//u.test(source.finalUrl) ||
        !/^https:\/\//u.test(source.requestedUrl) ||
        !/^[a-f0-9]{64}$/u.test(source.excerptHash) ||
        !/^[a-f0-9]{64}$/u.test(source.responseBodyHash)
      );
    })
  ) {
    return false;
  }
  const { contentHash: _contentHash, ...content } = bundle;
  return hashCanonical(content) === bundle.contentHash;
}

function evidenceSourcesFromResearchBundle(
  bundle: ResearchBundle
): StageOrderInput["sources"] {
  if (bundle.evidenceKind === "MARKET_DATA" && bundle.marketSources !== undefined) {
    return bundle.marketSources.map((source) => ({
      url:
        source.origin === "CLOB"
          ? "https://clob.polymarket.com"
          : source.origin === "GAMMA"
            ? "https://gamma-api.polymarket.com"
            : "https://data-api.polymarket.com",
      title: `${source.origin} market snapshot`,
      publishedAt: null,
      retrievedAt: new Date(source.capturedAtMs).toISOString(),
      primary: source.origin === "CLOB"
    }));
  }
  return bundle.sources.map((source, index) => ({
    url: source.finalUrl,
    title: source.title,
    publishedAt: new Date(source.publishedAtMs).toISOString(),
    retrievedAt: new Date(source.retrievedAtMs).toISOString(),
    primary: index === 0
  }));
}

function toExitReason(reason: ExitState): ExitReason {
  switch (reason) {
    case "STOP_LOSS_TRIGGERED":
    case "TAKE_PROFIT_TRIGGERED":
    case "MAX_DURATION_EXPIRED":
    case "EDGE_DISAPPEARED":
      return reason;
    default:
      throw new Error("UNSUPPORTED_EXIT_REASON");
  }
}

function maxRemaining(limitMicros: bigint, usedMicros: bigint): bigint {
  return limitMicros > usedMicros ? limitMicros - usedMicros : 0n;
}

function sizeSharesForBudget(budgetMicros: bigint, priceMicros: bigint): bigint {
  if (budgetMicros <= 0n || priceMicros <= 0n) return 0n;
  // The CLOB SDK accepts two decimal places for share size. Always round down
  // so fee reservation and the hard exposure ceiling remain conservative.
  const raw = (budgetMicros * PUSD_SCALE) / priceMicros;
  return (raw / 10_000n) * 10_000n;
}

function enforceInitialCanaryEntry(
  proposal: OrderProposal,
  context: RiskContext,
  reconciledLiveTradeCount: number
): void {
  if (reconciledLiveTradeCount >= INITIAL_CANARY_TRADE_COUNT) return;
  const violations = [] as Array<{
    code: "ORDER_TOO_LARGE" | "TOO_MANY_MARKETS";
    message: string;
  }>;
  if (proposal.maxLossMicros > INITIAL_CANARY_MAX_ORDER_PUSD) {
    violations.push({
      code: "ORDER_TOO_LARGE",
      message: "The first five live trades are capped at 1 pUSD including fee reserve."
    });
  }
  if (
    (context.agentManagedOpenExposureMicros ??
      context.totalOpenExposureMicros) > 0n &&
    context.marketExposureMicros === 0n
  ) {
    violations.push({
      code: "TOO_MANY_MARKETS",
      message: "The first five live trades allow only one simultaneous position."
    });
  }
  if (violations.length > 0) {
    throw new ProposalRejectedError(violations);
  }
}

function autonomousThesis(
  rationale: string,
  features: OpportunityDecision["features"]
): string {
  const edge = features === null ? "unknown" : formatMicros(features.netEdgeMicros);
  const movement =
    features?.movement15mMicros === null || features?.movement15mMicros === undefined
      ? "unknown"
      : formatMicros(features.movement15mMicros);
  return `Deterministic ${OPPORTUNITY_MODEL_VERSION} accepted verified research with net edge ${edge} pUSD/share and 15-minute movement ${movement}. ${rationale}`;
}

function autonomousCounterThesis(
  counterRationale: string,
  features: OpportunityDecision["features"]
): string {
  const spread = features === null ? "unknown" : formatMicros(features.spreadMicros);
  return `The trade remains exposed to probability error, spread ${spread} pUSD, stale evidence and adverse movement; the exit supervisor enforces hard exits. ${counterRationale}`;
}

export function assertAgentMarketSnapshotUnchanged(
  original: MarketSnapshot,
  refreshed: MarketSnapshot
): void {
  if (hashMarketSnapshot(original) !== hashMarketSnapshot(refreshed)) {
    throw new Error("AGENT_MARKET_SNAPSHOT_CHANGED");
  }
}

function assertSameMarketContract(
  original: MarketSnapshot,
  refreshed: MarketSnapshot
): void {
  if (
    original.conditionId !== refreshed.conditionId ||
    original.tokenId !== refreshed.tokenId ||
    original.eventId !== refreshed.eventId ||
    original.outcome !== refreshed.outcome ||
    original.rules !== refreshed.rules ||
    original.resolutionSource !== refreshed.resolutionSource ||
    original.tickSizeMicros !== refreshed.tickSizeMicros ||
    original.minOrderSizeMicros !== refreshed.minOrderSizeMicros ||
    original.negRisk !== refreshed.negRisk ||
    original.feesEnabled !== refreshed.feesEnabled ||
    original.feeRateBps !== refreshed.feeRateBps ||
    (original.feeExponent ?? 1) !== (refreshed.feeExponent ?? 1) ||
    (original.feesTakerOnly ?? true) !==
      (refreshed.feesTakerOnly ?? true) ||
    canonicalCorrelationKey(original) !==
      canonicalCorrelationKey(refreshed)
  ) {
    throw new Error("MARKET_CONTRACT_CHANGED");
  }
}

function assertRemoteOrderMatchesProposal(
  proposal: OrderProposal,
  orderId: string,
  expectedMakerAddress: string,
  remote: Record<string, unknown>
): {
  status: string;
  originalSize: bigint;
  sizeMatched: bigint;
  expiration: number;
} {
  const remoteStatus = normalizeClobOrderStatus(remote.status);
  const originalSize = parseClobFixed6(
    remote.originalSize,
    "ORDER_ORIGINAL_SIZE_INVALID"
  );
  const sizeMatched = parseClobFixed6(
    remote.sizeMatched,
    "ORDER_MATCHED_SIZE_INVALID"
  );
  const price = parseClobPrice(remote.price, "ORDER_PRICE_INVALID");
  const expiration = Number(
    readRequiredRemoteString(remote.expiration, "ORDER_EXPIRATION")
  );
  const minimumExpiration =
    Math.floor(proposal.createdAtMs / 1_000) +
    60 +
    Math.ceil(DEFAULT_RISK_POLICY.effectiveGtdMs / 1_000) -
    2;
  const maximumExpiration =
    Math.floor(proposal.expiresAtMs / 1_000) +
    60 +
    Math.ceil(DEFAULT_RISK_POLICY.effectiveGtdMs / 1_000) +
    2;
  if (
    readRequiredRemoteString(remote.id, "ORDER_ID") !== orderId ||
    readRequiredRemoteString(remote.market, "ORDER_MARKET").toLowerCase() !==
      proposal.market.conditionId.toLowerCase() ||
    readRequiredRemoteString(remote.assetId, "ORDER_ASSET") !==
      proposal.market.tokenId ||
    readRequiredRemoteString(remote.makerAddress, "ORDER_MAKER").toLowerCase() !==
      expectedMakerAddress.toLowerCase() ||
    readRequiredRemoteString(remote.side, "ORDER_SIDE").toUpperCase() !==
      proposal.side ||
    readRequiredRemoteString(remote.orderType, "ORDER_TYPE").toUpperCase() !==
      "GTD" ||
    originalSize !== proposal.sharesMicros ||
    sizeMatched < 0n ||
    sizeMatched > originalSize ||
    price !== proposal.limitPriceMicros ||
    !Number.isSafeInteger(expiration) ||
    expiration < minimumExpiration ||
    expiration > maximumExpiration
  ) {
    throw new Error("REMOTE_ORDER_MISMATCH");
  }
  return {
    status: remoteStatus,
    originalSize,
    sizeMatched,
    expiration
  };
}

function assertLocalOrderEvidence(
  proposal: OrderProposal,
  orderId: string,
  response: Record<string, unknown>,
  remoteExpiration: number
): { expiration: number } {
  const localOrder = readRequiredRemoteRecord(
    response.localOrder,
    "LOCAL_ORDER_EVIDENCE_INVALID"
  );
  const expiration = localOrder.expiration;
  const timestampMs = localOrder.timestampMs;
  const makerAmountMicros = localOrder.makerAmountMicros;
  const takerAmountMicros = localOrder.takerAmountMicros;
  const expectedMakerAmount =
    proposal.side === "BUY"
      ? proposal.maxCostMicros
      : proposal.sharesMicros;
  const expectedTakerAmount =
    proposal.side === "BUY"
      ? proposal.sharesMicros
      : proposal.maxCostMicros;
  if (
    response.success !== true ||
    readRequiredRemoteString(response.orderID, "LOCAL_ORDER_RESPONSE_ID")
      .toLowerCase() !== orderId.toLowerCase() ||
    readRequiredRemoteString(
      localOrder.orderHash,
      "LOCAL_ORDER_HASH"
    ).toLowerCase() !== orderId.toLowerCase() ||
    readRequiredRemoteString(
      localOrder.metadata,
      "LOCAL_ORDER_METADATA"
    ).toLowerCase() !== `0x${proposal.hash}`.toLowerCase() ||
    readRequiredRemoteString(
      localOrder.builder,
      "LOCAL_ORDER_BUILDER"
    ).toLowerCase() !== `0x${"00".repeat(32)}` ||
    !Number.isSafeInteger(expiration) ||
    expiration !== remoteExpiration ||
    typeof timestampMs !== "number" ||
    !Number.isSafeInteger(timestampMs) ||
    timestampMs < proposal.createdAtMs - 300_000 ||
    timestampMs > proposal.expiresAtMs + 60_000 ||
    typeof makerAmountMicros !== "bigint" ||
    makerAmountMicros !== expectedMakerAmount ||
    typeof takerAmountMicros !== "bigint" ||
    takerAmountMicros !== expectedTakerAmount
  ) {
    throw new Error("LOCAL_ORDER_EVIDENCE_MISMATCH");
  }
  return { expiration };
}

interface AttributedTrade {
  tradeId: string;
  status: string;
  role: "TAKER" | "MAKER";
  sharesMicros: bigint;
  priceMicros: bigint;
  transactionHash: string | null;
  matchTimeMs: number;
  lastUpdateMs: number;
}

function assertRemoteTradeMatchesProposal(
  proposal: OrderProposal,
  orderId: string,
  tradeId: string,
  expectedMakerAddress: string,
  trade: Record<string, unknown>
): AttributedTrade {
  const status = normalizeClobTradeStatus(trade.status);
  const role = readRequiredRemoteString(
    trade.traderSide,
    "TRADER_SIDE"
  ).toUpperCase();
  if (role !== "TAKER" && role !== "MAKER") {
    throw new Error("REMOTE_TRADE_ROLE_INVALID");
  }
  const transactionHash =
    trade.transactionHash === null || trade.transactionHash === ""
      ? null
      : readRequiredRemoteString(
          trade.transactionHash,
          "TRANSACTION_HASH"
        );
  const matchTimeMs = parseClobTimestampMs(trade.matchTime);
  const lastUpdateMs = parseClobTimestampMs(trade.lastUpdate);
  if (
    readRequiredRemoteString(trade.id, "TRADE_ID") !== tradeId ||
    readRequiredRemoteString(trade.market, "TRADE_MARKET").toLowerCase() !==
      proposal.market.conditionId.toLowerCase() ||
    matchTimeMs === null ||
    lastUpdateMs === null ||
    matchTimeMs > lastUpdateMs ||
    (transactionHash !== null &&
      !/^0x[a-fA-F0-9]{64}$/u.test(transactionHash)) ||
    (status === "CONFIRMED" && transactionHash === null)
  ) {
    throw new Error("REMOTE_TRADE_MISMATCH");
  }

  let sharesMicros: bigint;
  let priceMicros: bigint;
  if (role === "TAKER") {
    const feeRateBps = parseRemoteInteger(
      trade.feeRateBps,
      "TRADE_FEE_RATE_INVALID"
    );
    if (
      readRequiredRemoteString(trade.takerOrderId, "TAKER_ORDER_ID") !==
        orderId ||
      readRequiredRemoteString(trade.assetId, "TRADE_ASSET") !==
        proposal.market.tokenId ||
      readRequiredRemoteString(trade.side, "TRADE_SIDE").toUpperCase() !==
        proposal.side ||
      readRequiredRemoteString(
        trade.makerAddress,
        "TRADE_MAKER_ADDRESS"
      ).toLowerCase() !== expectedMakerAddress.toLowerCase() ||
      feeRateBps !== proposal.market.feeRateBps
    ) {
      throw new Error("REMOTE_TAKER_TRADE_MISMATCH");
    }
    sharesMicros = parseClobFixed6(trade.size, "TRADE_SIZE_INVALID");
    priceMicros = parseClobPrice(trade.price, "TRADE_PRICE_INVALID");
  } else {
    const makerOrders = readRemoteRecordArray(
      trade.makerOrders,
      "MAKER_ORDERS_INVALID"
    ).filter(
      (order) =>
        readRequiredRemoteString(
          order.orderId,
          "MAKER_ORDER_ID"
        ) === orderId
    );
    if (makerOrders.length !== 1) {
      throw new Error("REMOTE_MAKER_ORDER_RELATION_INVALID");
    }
    const makerOrder = makerOrders[0]!;
    if (
      readRequiredRemoteString(
        makerOrder.makerAddress,
        "MAKER_ORDER_ADDRESS"
      ).toLowerCase() !== expectedMakerAddress.toLowerCase() ||
      readRequiredRemoteString(
        makerOrder.assetId,
        "MAKER_ORDER_ASSET"
      ) !== proposal.market.tokenId ||
      readRequiredRemoteString(
        makerOrder.side,
        "MAKER_ORDER_SIDE"
      ).toUpperCase() !== proposal.side
    ) {
      throw new Error("REMOTE_MAKER_TRADE_MISMATCH");
    }
    sharesMicros = parseClobFixed6(
      makerOrder.matchedAmount,
      "MAKER_MATCHED_AMOUNT_INVALID"
    );
    priceMicros = parseClobPrice(
      makerOrder.price,
      "MAKER_ORDER_PRICE_INVALID"
    );
  }
  if (
    sharesMicros <= 0n ||
    (proposal.side === "BUY" &&
      priceMicros > proposal.limitPriceMicros) ||
    (proposal.side === "SELL" &&
      priceMicros < proposal.limitPriceMicros)
  ) {
    throw new Error("REMOTE_TRADE_PRICE_OR_SIZE_INVALID");
  }
  return {
    tradeId,
    status,
    role,
    sharesMicros,
    priceMicros,
    transactionHash:
      transactionHash === null ? null : transactionHash.toLowerCase(),
    matchTimeMs,
    lastUpdateMs
  };
}

function hasMatchingDataActivity(
  proposal: OrderProposal,
  trade: AttributedTrade,
  activity: UserTradeActivity[],
  nowMs: number
): boolean {
  if (trade.status !== "CONFIRMED" || trade.transactionHash === null) {
    return false;
  }
  const match = activity.find(
    (entry) =>
      entry.transactionHash === trade.transactionHash &&
      entry.conditionId === proposal.market.conditionId.toLowerCase() &&
      entry.tokenId === proposal.market.tokenId &&
      entry.side === proposal.side &&
      entry.sizeMicros === trade.sharesMicros &&
      entry.priceMicros === trade.priceMicros
  );
  if (match !== undefined) {
    return true;
  }
  if (trade.lastUpdateMs > nowMs) {
    throw new Error("REMOTE_TRADE_TIMESTAMP_INVALID");
  }
  if (nowMs - trade.lastUpdateMs > 120_000) {
    throw new Error("ONCHAIN_ACTIVITY_MISSING");
  }
  return false;
}

function assessUserChannelEvidence(
  database: TradingDatabase,
  proposal: OrderProposal,
  orderId: string,
  trades: AttributedTrade[],
  submittedAtMs: number,
  nowMs: number
): { hasAny: boolean; allConfirmedTradesPresent: boolean } {
  const evidence = database
    .listAuditEvents()
    .filter(
      (entry) =>
        entry.subjectId?.toLowerCase() === orderId.toLowerCase() &&
        (entry.eventType === "USER_CHANNEL_ORDER" ||
          entry.eventType === "USER_CHANNEL_TRADE")
    )
    .map((entry) => {
      const payload = readRequiredRemoteRecord(
        entry.payload,
        "USER_CHANNEL_AUDIT_INVALID"
      );
      if (
        payload.proposalId !== proposal.id ||
        payload.proposalHash !== proposal.hash
      ) {
        throw new Error("USER_CHANNEL_AUDIT_PROPOSAL_MISMATCH");
      }
      return {
        eventType: entry.eventType,
        role: payload.role,
        event: readRequiredRemoteRecord(
          payload.event,
          "USER_CHANNEL_AUDIT_EVENT_INVALID"
        )
      };
    });
  for (const entry of evidence) {
    const timestamp =
      entry.event.kind === "trade"
        ? entry.event.lastUpdateMs
        : entry.event.timestampMs;
    if (
      typeof timestamp !== "number" ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < submittedAtMs - 300_000 ||
      timestamp > nowMs + 5_000
    ) {
      throw new Error("USER_CHANNEL_AUDIT_TIMESTAMP_INVALID");
    }
  }

  const allConfirmedTradesPresent = trades.every((trade) =>
    evidence.some((entry) => {
      if (
        entry.eventType !== "USER_CHANNEL_TRADE" ||
        entry.event.kind !== "trade" ||
        entry.event.tradeId !== trade.tradeId ||
        entry.event.status !== "CONFIRMED" ||
        entry.role !== trade.role ||
        entry.event.conditionId !== proposal.market.conditionId.toLowerCase()
      ) {
        return false;
      }
      if (trade.role === "TAKER") {
        return (
          typeof entry.event.takerOrderId === "string" &&
          entry.event.takerOrderId.toLowerCase() ===
            orderId.toLowerCase() &&
          entry.event.tokenId === proposal.market.tokenId &&
          entry.event.side === proposal.side &&
          entry.event.sizeMicros === trade.sharesMicros &&
          entry.event.priceMicros === trade.priceMicros
        );
      }
      const makerMatches = Array.isArray(entry.event.makerOrders)
        ? entry.event.makerOrders.filter(
            (value): value is Record<string, unknown> =>
              value !== null &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              value.orderId === orderId
          )
        : [];
      return (
        makerMatches.length === 1 &&
        makerMatches[0]!.tokenId === proposal.market.tokenId &&
        makerMatches[0]!.matchedSizeMicros === trade.sharesMicros &&
        makerMatches[0]!.priceMicros === trade.priceMicros
      );
    })
  );
  return {
    hasAny: evidence.length > 0,
    allConfirmedTradesPresent
  };
}

function assertUserActivityBijection(
  database: TradingDatabase,
  executions: ReturnType<TradingDatabase["listExecutions"]>,
  activity: UserTradeActivity[],
  sinceMs: number,
  nowMs: number,
  allowFreshUntrackedRemote = true
): void {
  const localByKey = new Map<
    string,
    Array<{ tradeId: string; lastUpdateMs: number }>
  >();
  const seenTradeIds = new Set<string>();
  for (const execution of executions) {
    const proposal = database.getProposal(execution.proposalId);
    if (
      proposal === null ||
      proposal.executionMode !== "live" ||
      !verifyProposalHash(proposal)
    ) {
      throw new Error("LIVE_ACTIVITY_LEDGER_INVALID");
    }
    const response = parseExecutionResponse(execution.responseJson);
    const rawTrades =
      response.attributedTrades === undefined
        ? []
        : readRemoteRecordArray(
            response.attributedTrades,
            "LIVE_ACTIVITY_TRADE_SET_INVALID"
          );
    for (const rawTrade of rawTrades) {
      if (rawTrade.status !== "CONFIRMED") {
        continue;
      }
      const tradeId = readRequiredRemoteString(
        rawTrade.tradeId,
        "LIVE_ACTIVITY_TRADE_ID_INVALID"
      );
      const transactionHash = readRequiredRemoteString(
        rawTrade.transactionHash,
        "LIVE_ACTIVITY_TRANSACTION_INVALID"
      ).toLowerCase();
      const role = rawTrade.role;
      const sharesMicros = rawTrade.sharesMicros;
      const priceMicros = rawTrade.priceMicros;
      const lastUpdateMs = rawTrade.lastUpdateMs;
      if (
        seenTradeIds.has(tradeId) ||
        !/^0x[a-f0-9]{64}$/u.test(transactionHash) ||
        (role !== "TAKER" && role !== "MAKER") ||
        typeof sharesMicros !== "bigint" ||
        sharesMicros <= 0n ||
        typeof priceMicros !== "bigint" ||
        priceMicros <= 0n ||
        priceMicros >= 1_000_000n ||
        typeof lastUpdateMs !== "number" ||
        !Number.isSafeInteger(lastUpdateMs) ||
        lastUpdateMs > nowMs + 5_000
      ) {
        throw new Error("LIVE_ACTIVITY_TRADE_INVALID");
      }
      seenTradeIds.add(tradeId);
      if (lastUpdateMs < sinceMs) {
        continue;
      }
      const key = activityIdentity({
        transactionHash,
        conditionId: proposal.market.conditionId.toLowerCase(),
        tokenId: proposal.market.tokenId,
        side: proposal.side,
        sizeMicros: sharesMicros,
        priceMicros
      });
      const values = localByKey.get(key) ?? [];
      values.push({ tradeId, lastUpdateMs });
      localByKey.set(key, values);
    }
  }

  for (const remote of activity) {
    if (
      remote.profileAddress.toLowerCase() !==
        database.getAccountBinding()?.profileAddress.toLowerCase() ||
      remote.timestampMs < sinceMs ||
      remote.timestampMs > nowMs + 5_000
    ) {
      throw new Error("USER_ACTIVITY_SCOPE_INVALID");
    }
    const key = activityIdentity(remote);
    const local = localByKey.get(key);
    if (local === undefined || local.length === 0) {
      if (
        !allowFreshUntrackedRemote ||
        nowMs - remote.timestampMs > 120_000
      ) {
        throw new Error("UNTRACKED_USER_ACTIVITY");
      }
      continue;
    }
    local.shift();
  }

  for (const remaining of localByKey.values()) {
    for (const local of remaining) {
      if (nowMs - local.lastUpdateMs > 120_000) {
        throw new Error("DATA_API_ACTIVITY_MISSING");
      }
    }
  }
}

function portfolioMatchesSettledLedger(
  database: TradingDatabase,
  portfolio: PortfolioSnapshot,
  currentProposal: OrderProposal,
  currentFilledSharesMicros: bigint
): boolean {
  const expected = new Map<
    string,
    { conditionId: string; sharesMicros: bigint }
  >();
  for (const execution of database.listExecutions()) {
    const proposal = database.getProposal(execution.proposalId);
    if (
      proposal === null ||
      proposal.executionMode !== "live" ||
      !verifyProposalHash(proposal)
    ) {
      throw new Error("POSITION_LEDGER_INVALID");
    }
    let filledSharesMicros: bigint;
    if (proposal.id === currentProposal.id) {
      filledSharesMicros = currentFilledSharesMicros;
    } else {
      const response = parseExecutionResponse(execution.responseJson);
      if (response.onchain === null || response.onchain === undefined) {
        continue;
      }
      const onchain = readRequiredRemoteRecord(
        response.onchain,
        "POSITION_ONCHAIN_EVIDENCE_INVALID"
      );
      if (onchain.finalized !== true) {
        continue;
      }
      if (
        typeof onchain.filledSharesMicros !== "bigint" ||
        onchain.filledSharesMicros <= 0n
      ) {
        throw new Error("POSITION_ONCHAIN_SIZE_INVALID");
      }
      filledSharesMicros = onchain.filledSharesMicros;
    }
    if (filledSharesMicros <= 0n) {
      continue;
    }
    const current = expected.get(proposal.market.tokenId) ?? {
      conditionId: proposal.market.conditionId,
      sharesMicros: 0n
    };
    if (current.conditionId !== proposal.market.conditionId) {
      throw new Error("POSITION_TOKEN_CONDITION_CONFLICT");
    }
    current.sharesMicros +=
      proposal.side === "BUY"
        ? filledSharesMicros
        : -filledSharesMicros;
    if (current.sharesMicros < 0n) {
      throw new Error("POSITION_LEDGER_NEGATIVE");
    }
    expected.set(proposal.market.tokenId, current);
  }

  const actual = new Map<
    string,
    { conditionId: string; sharesMicros: bigint }
  >();
  for (const position of portfolio.positions) {
    if (
      position.sizeMicros < 0n ||
      actual.has(position.tokenId)
    ) {
      throw new Error("PORTFOLIO_POSITION_SET_INVALID");
    }
    if (position.sizeMicros > 0n) {
      actual.set(position.tokenId, {
        conditionId: position.conditionId,
        sharesMicros: position.sizeMicros
      });
    }
  }
  for (const [tokenId, expectedPosition] of expected) {
    if (expectedPosition.sharesMicros === 0n) {
      expected.delete(tokenId);
    }
  }
  if (actual.size !== expected.size) {
    return false;
  }
  return [...expected].every(([tokenId, expectedPosition]) => {
    const actualPosition = actual.get(tokenId);
    return (
      actualPosition !== undefined &&
      actualPosition.conditionId === expectedPosition.conditionId &&
      actualPosition.sharesMicros === expectedPosition.sharesMicros
    );
  });
}

function activityIdentity(
  value: Pick<
    UserTradeActivity,
    | "transactionHash"
    | "conditionId"
    | "tokenId"
    | "side"
    | "sizeMicros"
    | "priceMicros"
  >
): string {
  return [
    value.transactionHash.toLowerCase(),
    value.conditionId.toLowerCase(),
    value.tokenId,
    value.side,
    value.sizeMicros.toString(),
    value.priceMicros.toString()
  ].join("|");
}

function parseExecutionResponse(
  responseJson: string | undefined
): Record<string, unknown> {
  if (responseJson === undefined || responseJson.length > 1_000_000) {
    return {};
  }
  try {
    const parsed = parseWithBigInts<unknown>(responseJson);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error("EXECUTION_RESPONSE_LEDGER_INVALID");
  }
}

function parseLegacyExecutionResponse(
  responseJson: string
): Record<string, unknown> {
  if (responseJson.length > 1_000_000) {
    return {};
  }
  try {
    const parsed = parseWithBigInts<unknown>(responseJson);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readRecordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readRecordArrayValue(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (candidate): candidate is Record<string, unknown> =>
      candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
  );
}

function readStringValue(...values: unknown[]): string | null {
  const value = values.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0
  );
  return value ?? null;
}

function existingPositionReport(
  position: PositionRecord,
  nowMs: number
): LegacyImportReport {
  const automaticExitPolicy =
    position.evidenceQuality === "VERIFIED"
      ? "FULL"
      : position.evidenceQuality === "PARTIALLY_VERIFIED"
        ? "PRICE_ONLY"
        : "BLOCKED";
  return {
    id: randomUUID(),
    tokenId: position.tokenId,
    conditionId: position.conditionId,
    quality: position.evidenceQuality,
    automaticExitPolicy,
    importedAtMs: nowMs,
    sharesMicros: position.sharesMicros,
    averagePriceMicros: position.averagePriceMicros,
    openedAtMs: position.openedAtMs,
    feesMicros: null,
    activityFillCount: 0,
    localEvidenceCount: 0,
    reconciledOrderCount: 0,
    reconciledFillCount: 0,
    remoteOpenOrderCount: 0,
    ordersChecked: false,
    transactionHashes: [],
    message: "Position already has a local record; no import was performed."
  };
}

function higherEvidenceQuality(
  existing: PositionRecord["evidenceQuality"] | undefined,
  incoming: PositionRecord["evidenceQuality"]
): PositionRecord["evidenceQuality"] {
  const rank = {
    LEGACY_UNVERIFIED: 0,
    PARTIALLY_VERIFIED: 1,
    VERIFIED: 2
  } as const;
  return existing !== undefined && rank[existing] > rank[incoming]
    ? existing
    : incoming;
}

function automaticExitPolicyForQuality(
  quality: LegacyImportReport["quality"]
): LegacyImportReport["automaticExitPolicy"] {
  return quality === "VERIFIED"
    ? "FULL"
    : quality === "PARTIALLY_VERIFIED"
      ? "PRICE_ONLY"
      : "BLOCKED";
}

function entryTransactionHashes(position: PositionRecord | null): string[] {
  if (position === null) return [];
  try {
    const parsed: unknown = JSON.parse(position.entryTransactionHashesJson);
    return Array.isArray(parsed)
      ? parsed.filter(
          (value): value is string =>
            typeof value === "string" && /^0x[a-fA-F0-9]{64}$/u.test(value)
        )
      : [];
  } catch {
    return [];
  }
}

function uniqueHashes(values: string[]): string[] {
  return [
    ...new Set(
      values
        .filter((value) => /^0x[a-fA-F0-9]{64}$/u.test(value))
        .map((value) => value.toLowerCase())
    )
  ];
}

function readRequiredRemoteString(
  value: unknown,
  code: string
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(code);
  }
  return value;
}

function readRequiredRemoteRecord(
  value: unknown,
  code: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
}

function readRemoteStringArray(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (candidate) =>
        typeof candidate !== "string" || candidate.trim().length === 0
    )
  ) {
    throw new Error("REMOTE_IDENTIFIER_LIST_INVALID");
  }
  return value as string[];
}

function readRemoteRecordArray(
  value: unknown,
  code: string
): Array<Record<string, unknown>> {
  if (
    !Array.isArray(value) ||
    value.some(
      (candidate) =>
        candidate === null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
    )
  ) {
    throw new Error(code);
  }
  return value as Array<Record<string, unknown>>;
}

function parseRemoteInteger(value: unknown, code: string): number {
  if (
    typeof value !== "string" ||
    !/^\d{1,9}$/u.test(value)
  ) {
    throw new Error(code);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100_000) {
    throw new Error(code);
  }
  return parsed;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof ProposalRejectedError) {
    return `RISK_${error.violations.map((violation) => violation.code).join("_")}`;
  }
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) {
    return error.message;
  }
  return `SAFE_FAILURE_${randomUUID()}`;
}

export function serializeForTool(value: unknown): unknown {
  return JSON.parse(
    stringifyWithBigInts(value),
    (_key, currentValue: unknown) => {
      if (
        currentValue !== null &&
        typeof currentValue === "object" &&
        "__codexPolymarketBigInt" in currentValue
      ) {
        return formatMicros(
          BigInt(
            String(
              (currentValue as { __codexPolymarketBigInt: unknown })
                .__codexPolymarketBigInt
            )
          )
        );
      }
      return currentValue;
    }
  );
}
