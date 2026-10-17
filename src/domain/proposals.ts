import { createHash, randomUUID } from "node:crypto";
import {
  type OrderIntent,
  type OrderProposal,
  type RiskContext,
  type MarketSnapshot
} from "./types.js";
import {
  DEFAULT_RISK_POLICY,
  RISK_POLICY_VERSION,
  evaluateOrderRisk,
  type RiskPolicy
} from "./risk-policy.js";

export class ProposalRejectedError extends Error {
  readonly violations: ReturnType<typeof evaluateOrderRisk>["violations"];

  constructor(violations: ReturnType<typeof evaluateOrderRisk>["violations"]) {
    super(violations.map((violation) => violation.message).join(" "));
    this.name = "ProposalRejectedError";
    this.violations = violations;
  }
}

export function createOrderProposal(
  intent: OrderIntent,
  context: RiskContext,
  policy: RiskPolicy = DEFAULT_RISK_POLICY
): OrderProposal {
  const evaluation = evaluateOrderRisk(intent, context, policy);
  if (evaluation.violations.length > 0) {
    throw new ProposalRejectedError(evaluation.violations);
  }

  const proposalWithoutHash = {
    id: randomUUID(),
    status: "STAGED" as const,
    createdAtMs: context.nowMs,
    expiresAtMs: context.nowMs + policy.proposalTtlMs,
    intent: intent.intent,
    sessionId: intent.sessionId ?? null,
    researchBundleId: intent.researchBundleId ?? null,
    executionMode: intent.executionMode,
    market: intent.market,
    side: intent.side,
    sharesMicros: intent.sharesMicros,
    limitPriceMicros: intent.limitPriceMicros,
    maxCostMicros: evaluation.maxCostMicros,
    maxLossMicros:
      intent.side === "BUY"
        ? evaluation.maxCostMicros + evaluation.estimatedFeeMicros
        : 0n,
    estimatedFeeMicros: evaluation.estimatedFeeMicros,
    estimatedProbabilityMicros: intent.estimatedProbabilityMicros,
    expectedEdgeMicros: evaluation.expectedEdgeMicros,
    postTradeMarketExposureMicros: evaluation.postTradeMarketExposureMicros,
    postTradeTotalExposureMicros: evaluation.postTradeTotalExposureMicros,
    thesis: intent.thesis.trim(),
    counterThesis: intent.counterThesis.trim(),
    sources: intent.sources,
    correlationKey: intent.correlationKey,
    policyVersion: RISK_POLICY_VERSION,
    ...(intent.decisionOwner === undefined
      ? {}
      : { decisionOwner: intent.decisionOwner }),
    ...(intent.agentRunId === undefined
      ? {}
      : { agentRunId: intent.agentRunId }),
    ...(intent.modelVersion === undefined
      ? {}
      : { modelVersion: intent.modelVersion }),
    ...(intent.analysisHash === undefined
      ? {}
      : { analysisHash: intent.analysisHash }),
    ...(intent.exitReason === undefined
      ? {}
      : { exitReason: intent.exitReason })
  };

  const hash = hashCanonical(proposalHashMaterial(proposalWithoutHash));
  return { ...proposalWithoutHash, hash };
}

export function verifyProposalHash(proposal: OrderProposal): boolean {
  return hashCanonical(proposalHashMaterial(proposal)) === proposal.hash;
}

export function hashCanonical(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  return createHash("sha256").update(serialized).digest("hex");
}

/** Hash market facts used by an analysis while ignoring capture-time noise. */
export function hashMarketSnapshot(snapshot: MarketSnapshot): string {
  const {
    capturedAtMs: _capturedAtMs,
    receivedAtMs: _receivedAtMs,
    sourceTimestampMs: _sourceTimestampMs,
    ...stableSnapshot
  } = snapshot;
  return hashCanonical(stableSnapshot);
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") {
    return { $bigint: value.toString() };
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])])
    );
  }

  return value;
}

function proposalHashMaterial(
  proposal: Omit<OrderProposal, "hash"> | OrderProposal
): Omit<OrderProposal, "hash" | "status"> {
  const record = proposal as OrderProposal;
  const { hash: _hash, status: _status, ...immutable } = record;
  return immutable;
}
