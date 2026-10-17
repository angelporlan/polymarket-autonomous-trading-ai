import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_POLICY,
  applyAgentPolicyPatch,
  validateAgentPolicy
} from "../src/domain/agent-policy.js";
import { DEFAULT_RISK_POLICY, validatePolicyAdjustments } from "../src/domain/risk-policy.js";
import { TradingDatabase } from "../src/storage/database.js";

describe("autonomous agent policy and lease guardrails", () => {
  const databases: TradingDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it("keeps the hard exposure and daily stop immutable", () => {
    expect(() => validateAgentPolicy({
      ...DEFAULT_AGENT_POLICY,
      risk: { ...DEFAULT_AGENT_POLICY.risk, dailyStopMicros: 11_000_000n }
    })).toThrow("DAILY_STOP_IMMUTABLE");
    expect(() => validatePolicyAdjustments({
      ...DEFAULT_RISK_POLICY,
      pilotMaxOpenExposureMicros: 101_000_000n
    })).toThrow("exceeds hard ceiling");
  });

  it("applies bounded policy changes without changing fixed risk values", () => {
    const next = applyAgentPolicyPatch(
      DEFAULT_AGENT_POLICY,
      {
        canaryMaxOrderPusd: "4",
        minEdge: "0.10",
        decisionIntervalSeconds: 60
      },
      (value) => BigInt(Math.round(Number(value) * 1_000_000)),
      (value) => BigInt(Math.round(Number(value) * 1_000_000)),
      1_000,
      10
    );
    expect(next.risk.canaryMaxOrderMicros).toBe(4_000_000n);
    expect(next.risk.minEdgeMicros).toBe(100_000n);
    expect(next.decisionIntervalMs).toBe(60_000);
    expect(next.risk.capitalMicros).toBe(100_000_000n);
    expect(next.risk.dailyStopMicros).toBe(10_000_000n);
  });

  it("binds heartbeats and stops to the runtime controller instance", () => {
    const database = new TradingDatabase(":memory:");
    databases.push(database);
    const run = database.startAgentRun({
      host: "codex",
      model: "test",
      controllerId: "controller-a",
      nowMs: 1_000
    });
    expect(() => database.heartbeatAgentRun(run.agentRunId, 2_000, "controller-b"))
      .toThrow("AGENT_RUN_INSTANCE_MISMATCH");
    expect(() => database.stopAgentRun(run.agentRunId, "test", 2_000, "controller-b"))
      .toThrow("AGENT_RUN_INSTANCE_MISMATCH");
    expect(database.heartbeatAgentRun(run.agentRunId, 2_000, "controller-a").status)
      .toBe("ACTIVE");
  });

  it("does not append repeated emergency-stop events for the same state", () => {
    const database = new TradingDatabase(":memory:");
    databases.push(database);
    database.setEmergencyStop(true, "SUPERVISOR_CYCLE_FAILED", 1_000);
    const firstCount = database.listAuditEvents().filter((event) => event.eventType === "EMERGENCY_STOP_SET").length;
    database.setEmergencyStop(true, "SUPERVISOR_CYCLE_FAILED", 2_000);
    const secondCount = database.listAuditEvents().filter((event) => event.eventType === "EMERGENCY_STOP_SET").length;
    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);
  });

  it("persists a same-market loss for the 24-hour increase cooldown", () => {
    const database = new TradingDatabase(":memory:");
    databases.push(database);
    database.recordAgentMarketLoss("CONDITION-ONE", 5_000);
    database.recordAgentMarketLoss("CONDITION-ONE", 4_000);
    expect(database.getAgentPolicy()).toMatchObject({
      lastLossMarketConditionId: "condition-one",
      lastLossAtMs: 5_000
    });
    expect(database.countAuditEvents("AGENT_MARKET_LOSS_RECORDED")).toBe(1);
  });
});
