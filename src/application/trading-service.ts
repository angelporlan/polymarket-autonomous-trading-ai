import { createHash, randomUUID } from "node:crypto";
import {
  ProposalRejectedError,
  createOrderProposal,
  verifyProposalHash
} from "../domain/proposals.js";
import {
  DEFAULT_RISK_POLICY,
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
  type MarketSnapshot,
  type OrderIntent,
  type OrderProposal,
  type PositionRecord,
  type PortfolioSnapshot,
  type UserTradeActivity
} from "../domain/types.js";
import { validateEvidenceSources } from "../domain/source-validator.js";
import {
  createTradingSession,
  isSessionValid,
  minBigInt,
  type CreateSessionInput,
  type TradingSession
} from "../domain/session.js";
import {
  evaluatePositionExitPolicy,
  type EvaluationAction
} from "../domain/position-supervisor.js";
import { PaperSimulator } from "../paper/simulator.js";
import { zonedDayStartMs } from "./risk-context.js";
import {
  normalizeClobOrderStatus,
  normalizeClobTradeStatus,
  parseClobFixed6,
  parseClobPrice,
  parseClobTimestampMs
} from "../polymarket/reconciliation.js";
import type { TradingDatabase } from "../storage/database.js";
import {
  parseWithBigInts,
  stringifyWithBigInts
} from "../storage/codec.js";
import type {
  AccountBindingPort,
  AccountStatus,
  ApprovalUrlPort,
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
  accountBinding: AccountBindingPort;
  riskContexts: RiskContextPort;
  paperGate: PaperGatePort;
  /** Explicit non-secret override; never replaces the other live barriers. */
  paperGateSkip?: boolean;
  liveTrading: LiveTradingPort | null;
  onchainSettlement: OnchainSettlementPort;
  approvals: ApprovalUrlPort;
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
      this.options.paperGate.result(this.options.paperGateSkip ?? false)
    ]);
    const emergencyStopped = this.options.database.getEmergencyStop().active;
    const localLiveActivation = this.options.database.getLiveActivation().active;
    const liveReady =
      this.options.liveEnvironmentEnabled &&
      profileExists &&
      localLiveActivation &&
      paperGate.passed &&
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

  scanCandidates() {
    return this.options.marketData.scanCandidates([
      "politics",
      "economics",
      "technology"
    ]);
  }

  getMarketSnapshot(reference: MarketReference) {
    return this.options.marketData.getMarketSnapshot(reference);
  }

  async getRiskStatus() {
    const [summary, paperMetrics, paperResult] = await Promise.all([
      this.options.riskContexts.summary(),
      this.options.paperGate.metrics(),
      this.options.paperGate.result(this.options.paperGateSkip ?? false)
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

  async startTradingSession(input: CreateSessionInput): Promise<TradingSession> {
    const nowMs = this.now();
    const summary = await this.options.riskContexts.summary();
    const openExposure = summary.totalOpenExposureMicros;
    const dailyPnl = summary.dailyPnlMicros;

    const hardCapRemaining =
      RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD > openExposure
        ? RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD - openExposure
        : 0n;

    const dailyLoss = dailyPnl < 0n ? -dailyPnl : 0n;
    const dailyStopRemaining =
      RISK_HARD_DAILY_STOP_PUSD > dailyLoss
        ? RISK_HARD_DAILY_STOP_PUSD - dailyLoss
        : 0n;

    let availableCash = 100n * PUSD_SCALE;
    try {
      const portfolio = await this.getPortfolio();
      if (portfolio.pUsdBalanceMicros !== null && portfolio.pUsdBalanceMicros >= 0n) {
        availableCash = portfolio.pUsdBalanceMicros;
      }
    } catch {
      // Keep default cash fallback
    }

    const effectiveAuthorizedBudget = minBigInt(
      input.authorizedBudgetMicros,
      availableCash,
      hardCapRemaining,
      dailyStopRemaining
    );

    if (effectiveAuthorizedBudget <= 0n) {
      throw new Error(
        `Cannot authorize trading session: remaining capacity under exposure ceiling (${formatMicros(hardCapRemaining)} pUSD) or daily stop (${formatMicros(dailyStopRemaining)} pUSD) is zero.`
      );
    }

    const existingActive = this.options.database.getActiveTradingSession(input.executionMode, nowMs);
    if (existingActive) {
      this.options.database.closeTradingSession(
        existingActive.id,
        "Superseded by newly authorized trading session",
        nowMs
      );
    }

    const session = createTradingSession({
      ...input,
      authorizedBudgetMicros: effectiveAuthorizedBudget,
      nowMs
    });
    this.options.database.saveTradingSession(session, nowMs);
    return session;
  }

  async closeTradingSession(sessionId: string, reason = "User closed session"): Promise<TradingSession> {
    const nowMs = this.now();
    const session = this.options.database.closeTradingSession(sessionId, reason, nowMs);
    if (!session) {
      throw new Error(`Trading session ${sessionId} not found.`);
    }
    return session;
  }

  getActiveTradingSession(executionMode: "live" | "paper"): TradingSession | null {
    return this.options.database.getActiveTradingSession(executionMode, this.now());
  }

  async stageOrder(input: StageOrderInput): Promise<StageOrderResult> {
    requireResearchFields(input, this.now());

    const activeSession = this.options.database.getActiveTradingSession(input.executionMode, this.now());
    if (!activeSession) {
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

    if (input.executionMode === "live") {
      const status = await this.getAccountStatus();
      if (status.mode !== "live_ready") {
        throw new Error(
          "LIVE_AUTONOMY_NOT_READY: Live mode is currently locked or unconfigured. Verify live environment flag, paper gate, signer, and active session budget."
        );
      }
    }

    if (input.executionMode === "paper") {
      await this.options.paperGate.metrics();
    }

    const snapshot = await this.options.marketData.getMarketSnapshot({
      conditionId: input.conditionId,
      tokenId: input.tokenId,
      outcome: input.outcome,
      side: input.side,
      limitPriceMicros
    });
    const correlationKey = canonicalCorrelationKey(snapshot);
    const context = await this.options.riskContexts.forOrder(
      snapshot,
      input.side,
      correlationKey,
      input.executionMode
    );
    const intent: OrderIntent = {
      executionMode: input.executionMode,
      market: snapshot,
      side: input.side,
      sharesMicros,
      limitPriceMicros,
      estimatedProbabilityMicros,
      thesis: input.thesis,
      counterThesis: input.counterThesis,
      sources: input.sources,
      correlationKey
    };
    let proposal: OrderProposal;
    try {
      proposal = createOrderProposal(intent, context);
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

    if (proposal.intent !== "EXIT") {
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
    this.options.database.stageProposal(proposal);

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

  beginExecution(proposalId: string, proposalHash: string) {
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
    if (proposal.status === "AWAITING_LOCAL") {
      return {
        proposalId,
        proposalHash,
        expiresAtMs: proposal.expiresAtMs,
        approvalUrl: this.options.approvals.approvalUrl(proposalId)
      };
    }
    const awaiting = this.options.database.transitionProposal(
      proposalId,
      "STAGED",
      "AWAITING_LOCAL",
      nowMs
    );
    if (!awaiting) {
      throw new Error("The proposal is not available for local approval.");
    }
    return {
      proposalId,
      proposalHash,
      expiresAtMs: awaiting.expiresAtMs,
      approvalUrl: this.options.approvals.approvalUrl(proposalId)
    };
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
    if (!activeSession) {
      throw new Error("LIVE_AUTONOMY_NOT_READY: No active authorized live trading session found.");
    }

    try {
      await this.assertLiveGates();
      await this.revalidateProposal(proposal);

      const claimed = this.options.database.claimAutonomousExecution(
        proposal.id,
        proposal.hash,
        activeSession.id,
        nowMs
      );

      if (!claimed) {
        return { accepted: false, message: "Execution claim failed or session budget exceeded." };
      }

      const liveTrading = this.options.liveTrading;
      if (!liveTrading) {
        throw new Error("Live trading adapter is not configured.");
      }

      const result = await liveTrading.submitGtd(proposal, async () => {
        await this.assertLiveGates();
        await this.revalidateProposal(proposal);
      });

      if (
        result.orderId === null ||
        result.orderId.trim().length === 0 ||
        result.orderId.length > 512
      ) {
        throw new Error("CLOB_ORDER_ID_MISSING");
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
      this.options.database.markExecutionFailed(proposal.id, proposal.hash);
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

  async supervisePositions(): Promise<Array<{ position: PositionRecord; action: EvaluationAction }>> {
    const portfolio = await this.getPortfolio();
    const results: Array<{ position: PositionRecord; action: EvaluationAction }> = [];
    const nowMs = this.now();

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
          entryEdgeMicros: 50_000n,
          openedAtMs: nowMs,
          lastEvaluatedAtMs: nowMs,
          lastProbabilityMicros: p.currentPriceMicros,
          sourcesJson: "[]",
          exitState: "HOLDING"
        };
      }

      const action = evaluatePositionExitPolicy(
        rec,
        p.currentPriceMicros,
        p.currentPriceMicros,
        p.endTimeMs,
        nowMs
      );

      rec = {
        ...rec,
        sharesMicros: p.sizeMicros,
        averagePriceMicros: p.averagePriceMicros,
        lastEvaluatedAtMs: nowMs,
        lastProbabilityMicros: p.currentPriceMicros,
        exitState: action.triggerReason
      };

      this.options.database.savePositionRecord(rec, nowMs);
      results.push({ position: rec, action });
    }

    return results;
  }

  async executeLocallyApproved(
    proposal: OrderProposal
  ): Promise<{ accepted: boolean; message: string }> {
    try {
      await this.assertLiveGates();
      await this.revalidateProposal(proposal);
      const nowMs = this.now();
      if (!this.options.database.claimExecution(proposal.id, proposal.hash, nowMs)) {
        return { accepted: false, message: "Execution was already used or expired." };
      }
      const liveTrading = this.options.liveTrading;
      if (!liveTrading) {
        throw new Error("Live trading adapter is not configured.");
      }
      const result = await liveTrading.submitGtd(proposal, async () => {
        await this.assertLiveGates();
        await this.revalidateProposal(proposal);
      });
      if (
        result.orderId === null ||
        result.orderId.trim().length === 0 ||
        result.orderId.length > 512
      ) {
        throw new Error("CLOB_ORDER_ID_MISSING");
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
      this.options.database.markExecutionFailed(proposal.id, proposal.hash);
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
        } catch {
          // The persistent lock is already active. Manual reconciliation is
          // required when best-effort cancellation cannot be confirmed.
        }
        try {
          await this.options.liveTrading.stopHeartbeat();
        } catch {
          // Stopping local scheduling is best effort after the lock is set.
        }
      }
      return {
        accepted: false,
        message: "Execution failed safely; the emergency lock is active."
      };
    }
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
    if (!this.options.liveEnvironmentEnabled) {
      throw new Error("LIVE_ENVIRONMENT_DISABLED");
    }
    if (!this.options.database.getLiveActivation().active) {
      throw new Error("LOCAL_LIVE_ACTIVATION_MISSING");
    }
    if (this.options.database.getEmergencyStop().active) {
      throw new Error("EMERGENCY_STOPPED");
    }
    const liveTrading = this.options.liveTrading;
    if (liveTrading === null) {
      throw new Error("LIVE_ADAPTER_NOT_CONFIGURED");
    }

    const executions = this.options.database.listExecutions();
    const activitySinceMs = zonedDayStartMs(
      this.now(),
      "Europe/Madrid"
    );
    const [geo, risk, openOrders, userActivity, portfolio] = await Promise.all([
      this.options.marketData.checkGeoblock(),
      this.options.riskContexts.summary(),
      liveTrading.getOpenOrders(),
      this.options.marketData.getUserActivity(
        this.options.profileAddress,
        activitySinceMs
      ),
      this.options.marketData.getPortfolio(this.options.profileAddress)
    ]);
    if (geo.blocked || this.now() - geo.checkedAtMs > 5_000) {
      throw new Error("GEOBLOCK_BLOCKED_OR_STALE");
    }
    if (!risk.dailyPnlKnown) {
      throw new Error("DAILY_PNL_UNAVAILABLE");
    }
    if (risk.dailyPnlMicros <= -DEFAULT_RISK_POLICY.dailyStopMicros) {
      throw new Error("DAILY_STOP");
    }
    if (
      risk.coolingDownUntilMs !== null &&
      risk.coolingDownUntilMs > this.now()
    ) {
      throw new Error("COOLING_DOWN");
    }
    const maxExposure =
      risk.liveTradeCount < DEFAULT_RISK_POLICY.canaryTradeCount
        ? DEFAULT_RISK_POLICY.canaryMaxOpenExposureMicros
        : DEFAULT_RISK_POLICY.pilotMaxOpenExposureMicros;
    if (risk.totalOpenExposureMicros > maxExposure) {
      throw new Error("TOTAL_EXPOSURE");
    }
    if (risk.openMarketCount > DEFAULT_RISK_POLICY.maxOpenMarkets) {
      throw new Error("TOO_MANY_MARKETS");
    }
    assertUserActivityBijection(
      this.options.database,
      executions,
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
        throw new Error("CLAIMED_EXECUTION_UNRESOLVED");
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
    return monitored.length > 0 || openOrdersById.size > 0;
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
    const localOrder = assertLocalOrderEvidence(
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
            expirationEpochSeconds: localOrder.expiration,
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
  }

  private async assertLiveGates(): Promise<void> {
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
      signatureType,
      geo
    ] = await Promise.all([
      this.options.paperGate.result(this.options.paperGateSkip ?? false),
      this.options.liveTrading?.configured() ?? Promise.resolve(false),
      this.options.marketData.profileExists(this.options.profileAddress),
      this.options.accountBinding.signerAddress(),
      this.options.accountBinding.funderAddress(),
      this.options.accountBinding.signatureType(),
      this.options.marketData.checkGeoblock()
    ]);
    if (!paperGate.passed) {
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
    if (geo.blocked || this.now() - geo.checkedAtMs > 5_000) {
      throw new Error("GEOBLOCK_BLOCKED_OR_STALE");
    }
  }

  private async revalidateProposal(proposal: OrderProposal): Promise<void> {
    const refreshed = await this.options.marketData.getMarketSnapshot({
      conditionId: proposal.market.conditionId,
      tokenId: proposal.market.tokenId,
      outcome: proposal.market.outcome,
      side: proposal.side,
      limitPriceMicros: proposal.limitPriceMicros
    });
    assertSameMarketContract(proposal.market, refreshed);
    const context = await this.options.riskContexts.forOrder(
      refreshed,
      proposal.side,
      proposal.correlationKey,
      "live",
      proposal.id
    );
    const evaluation = evaluateOrderRisk(
      {
        executionMode: "live",
        market: refreshed,
        side: proposal.side,
        sharesMicros: proposal.sharesMicros,
        limitPriceMicros: proposal.limitPriceMicros,
        estimatedProbabilityMicros: proposal.estimatedProbabilityMicros,
        thesis: proposal.thesis,
        counterThesis: proposal.counterThesis,
        sources: proposal.sources,
        correlationKey: proposal.correlationKey
      },
      context
    );
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
