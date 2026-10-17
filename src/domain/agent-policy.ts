import {
  DEFAULT_RISK_POLICY,
  RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD,
  RISK_HARD_DAILY_STOP_PUSD,
  validatePolicyAdjustments,
  type RiskPolicy
} from "./risk-policy.js";

export const AGENT_POLICY_VERSION = "2026-08-agent-v1";
export const AGENT_POLICY_STATE_KEY = "agent_policy_state";
export const AGENT_POLICY_MIN_DECISION_INTERVAL_MS = 30_000;
export const AGENT_POLICY_MAX_DECISION_INTERVAL_MS = 300_000;
export const AGENT_POLICY_INCREASE_COOLDOWN_MS = 6 * 60 * 60_000;
export const AGENT_POLICY_SAME_MARKET_LOSS_COOLDOWN_MS = 24 * 60 * 60_000;

export interface AgentOperationalPolicy {
  version: string;
  risk: RiskPolicy;
  decisionIntervalMs: number;
  lastIncreaseAtMs: number | null;
  reconciledTradeCountAtIncrease: number;
  lastLossMarketConditionId: string | null;
  lastLossAtMs: number | null;
}

export type AgentPolicyPatch = Partial<{
  canaryMaxOrderPusd: string;
  pilotMaxOrderPusd: string;
  canaryMaxOpenExposurePusd: string;
  pilotMaxOpenExposurePusd: string;
  maxMarketOrCorrelationPusd: string;
  maxOpenMarkets: number;
  minEdge: string;
  maxSpread: string;
  depthMultiplier: number;
  decisionIntervalSeconds: number;
}>;

export const DEFAULT_AGENT_POLICY: AgentOperationalPolicy = Object.freeze({
  version: AGENT_POLICY_VERSION,
  risk: validatePolicyAdjustments({ ...DEFAULT_RISK_POLICY }),
  decisionIntervalMs: 30_000,
  lastIncreaseAtMs: null,
  reconciledTradeCountAtIncrease: 0,
  lastLossMarketConditionId: null,
  lastLossAtMs: null
});

export function validateAgentPolicy(policy: AgentOperationalPolicy): AgentOperationalPolicy {
  if (policy.version !== AGENT_POLICY_VERSION) {
    throw new Error("AGENT_POLICY_VERSION_UNSUPPORTED");
  }
  if (
    !Number.isInteger(policy.decisionIntervalMs) ||
    policy.decisionIntervalMs < AGENT_POLICY_MIN_DECISION_INTERVAL_MS ||
    policy.decisionIntervalMs > AGENT_POLICY_MAX_DECISION_INTERVAL_MS
  ) {
    throw new Error("AGENT_POLICY_DECISION_INTERVAL_OUT_OF_RANGE");
  }
  if (!Number.isInteger(policy.reconciledTradeCountAtIncrease) || policy.reconciledTradeCountAtIncrease < 0) {
    throw new Error("AGENT_POLICY_TRADE_COUNT_INVALID");
  }
  if (policy.risk.capitalMicros !== RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD) {
    throw new Error("AGENT_POLICY_CAPITAL_HARD_CEILING_IMMUTABLE");
  }
  if (policy.risk.dailyStopMicros !== RISK_HARD_DAILY_STOP_PUSD) {
    throw new Error("AGENT_POLICY_DAILY_STOP_IMMUTABLE");
  }
  return Object.freeze({
    ...policy,
    risk: validatePolicyAdjustments(policy.risk)
  });
}

export function applyAgentPolicyPatch(
  current: AgentOperationalPolicy,
  patch: AgentPolicyPatch,
  parsePusd: (value: string) => bigint,
  parseProbability: (value: string) => bigint,
  nowMs: number,
  reconciledTradeCount: number
): AgentOperationalPolicy {
  const risk = { ...current.risk };
  if (patch.canaryMaxOrderPusd !== undefined) risk.canaryMaxOrderMicros = parsePusd(patch.canaryMaxOrderPusd);
  if (patch.pilotMaxOrderPusd !== undefined) risk.pilotMaxOrderMicros = parsePusd(patch.pilotMaxOrderPusd);
  if (patch.canaryMaxOpenExposurePusd !== undefined) risk.canaryMaxOpenExposureMicros = parsePusd(patch.canaryMaxOpenExposurePusd);
  if (patch.pilotMaxOpenExposurePusd !== undefined) risk.pilotMaxOpenExposureMicros = parsePusd(patch.pilotMaxOpenExposurePusd);
  if (patch.maxMarketOrCorrelationPusd !== undefined) risk.maxMarketOrCorrelationMicros = parsePusd(patch.maxMarketOrCorrelationPusd);
  if (patch.maxOpenMarkets !== undefined) risk.maxOpenMarkets = patch.maxOpenMarkets;
  if (patch.minEdge !== undefined) risk.minEdgeMicros = parseProbability(patch.minEdge);
  if (patch.maxSpread !== undefined) risk.maxSpreadMicros = parseProbability(patch.maxSpread);
  if (patch.depthMultiplier !== undefined) risk.depthMultiplier = BigInt(patch.depthMultiplier);
  const decisionIntervalMs = patch.decisionIntervalSeconds === undefined
    ? current.decisionIntervalMs
    : patch.decisionIntervalSeconds * 1_000;
  const candidate = validateAgentPolicy({
    ...current,
    risk: validatePolicyAdjustments(risk),
    decisionIntervalMs,
    lastIncreaseAtMs: isRiskIncrease(current, risk, decisionIntervalMs) ? nowMs : current.lastIncreaseAtMs,
    reconciledTradeCountAtIncrease: isRiskIncrease(current, risk, decisionIntervalMs)
      ? reconciledTradeCount
      : current.reconciledTradeCountAtIncrease
  });
  return candidate;
}

export function isRiskIncrease(
  current: AgentOperationalPolicy,
  nextRisk: RiskPolicy,
  nextDecisionIntervalMs: number
): boolean {
  return (
    nextRisk.canaryMaxOrderMicros > current.risk.canaryMaxOrderMicros ||
    nextRisk.pilotMaxOrderMicros > current.risk.pilotMaxOrderMicros ||
    nextRisk.canaryMaxOpenExposureMicros > current.risk.canaryMaxOpenExposureMicros ||
    nextRisk.pilotMaxOpenExposureMicros > current.risk.pilotMaxOpenExposureMicros ||
    nextRisk.maxMarketOrCorrelationMicros > current.risk.maxMarketOrCorrelationMicros ||
    nextRisk.maxOpenMarkets > current.risk.maxOpenMarkets ||
    nextRisk.minEdgeMicros < current.risk.minEdgeMicros ||
    nextRisk.maxSpreadMicros > current.risk.maxSpreadMicros ||
    nextRisk.depthMultiplier < current.risk.depthMultiplier ||
    nextDecisionIntervalMs < current.decisionIntervalMs
  );
}

