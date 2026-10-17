import { describe, expect, it } from "vitest";
import { AGENT_RUN_LEASE_MS, TradingDatabase } from "../src/storage/database.js";
import {
  classifyAgentCycleMarketError,
  expiredAgentRunRequiresRelock,
  runtimeCloseSafetyDecision
} from "../src/runtime.js";
import { SafeExternalServiceError } from "../src/polymarket/safe-error.js";

describe("agent supervised lease", () => {
  it("skips only a channel receipt that aged out during enrichment", () => {
    expect(
      classifyAgentCycleMarketError(
        new SafeExternalServiceError("stale", {
          code: "CLOB_MARKET_CHANNEL_BOOK_STALE",
          service: "clob"
        })
      )
    ).toBe("SKIP_BOOK");
    expect(
      classifyAgentCycleMarketError(
        new SafeExternalServiceError("identity mismatch", {
          code: "CLOB_MARKET_CHANNEL_BOOK_INVALID",
          service: "clob"
        })
      )
    ).toBe("FAIL_RUN");
    expect(
      classifyAgentCycleMarketError(
        new SafeExternalServiceError("cross-check mismatch", {
          code: "CLOB_BOOK_CROSSCHECK_MISMATCH",
          service: "clob"
        })
      )
    ).toBe("FAIL_RUN");
  });

  it("allows one owner, renews its lease, and rejects a concurrent owner", () => {
    const database = new TradingDatabase(":memory:");
    try {
      const first = database.startAgentRun({
        host: "codex",
        model: "test-model",
        nowMs: 1_000
      });
      expect(first.status).toBe("ACTIVE");
      expect(first.leaseExpiresAtMs).toBe(1_000 + AGENT_RUN_LEASE_MS);
      expect(() =>
        database.startAgentRun({ host: "claude", model: "other", nowMs: 2_000 })
      ).toThrow("AGENT_RUN_ALREADY_ACTIVE");
      const heartbeat = database.heartbeatAgentRun(first.agentRunId, 10_000);
      expect(heartbeat.leaseExpiresAtMs).toBe(10_000 + AGENT_RUN_LEASE_MS);
      expect(database.isAgentRunActive(first.agentRunId, 10_001)).toBe(true);
    } finally {
      database.close();
    }
  });

  it("expires a silent owner and persists an emergency lock", () => {
    const database = new TradingDatabase(":memory:");
    try {
      const run = database.startAgentRun({ host: "codex", model: "test", nowMs: 1_000 });
      const expired = database.getAgentRun(run.leaseExpiresAtMs + 1);
      expect(expired?.status).toBe("EXPIRED");
      expect(database.getEmergencyStop().active).toBe(true);
      expect(database.countAuditEvents("AGENT_RUN_EXPIRED")).toBe(1);
      expect(database.countAuditEvents("EMERGENCY_STOP_SET")).toBe(1);
    } finally {
      database.close();
    }
  });

  it("does not relock an expired run after a later explicit local review", () => {
    const database = new TradingDatabase(":memory:");
    try {
      const run = database.startAgentRun({
        host: "codex",
        model: "test",
        nowMs: 1_000
      });
      const expiredAtMs = run.leaseExpiresAtMs + 1;
      const expired = database.getAgentRun(expiredAtMs);
      expect(expiredAgentRunRequiresRelock(
        expired,
        true,
        database.getEmergencyStop()
      )).toBe(true);

      database.setEmergencyStop(
        false,
        "MANUAL_LOCAL_REVIEW",
        expiredAtMs + 1
      );
      expect(expiredAgentRunRequiresRelock(
        expired,
        true,
        database.getEmergencyStop()
      )).toBe(false);
      expect(expired?.status).toBe("EXPIRED");
      expect(database.countAuditEvents("AGENT_RUN_EXPIRED")).toBe(1);
    } finally {
      database.close();
    }
  });

  it("relocks when the manual review predates the expired run", () => {
    const database = new TradingDatabase(":memory:");
    try {
      database.setEmergencyStop(false, "MANUAL_LOCAL_REVIEW", 500);
      const run = database.startAgentRun({
        host: "codex",
        model: "test",
        nowMs: 1_000
      });
      const expired = database.getAgentRun(run.leaseExpiresAtMs + 1);
      expect(expiredAgentRunRequiresRelock(
        expired,
        true,
        {
          active: false,
          reason: "MANUAL_LOCAL_REVIEW",
          updatedAtMs: 500
        }
      )).toBe(true);
    } finally {
      database.close();
    }
  });

  it("stops the lease append-only", () => {
    const database = new TradingDatabase(":memory:");
    try {
      const run = database.startAgentRun({ host: "codex", model: "test", nowMs: 1_000 });
      const stopped = database.stopAgentRun(run.agentRunId, "button", 2_000);
      expect(stopped.status).toBe("STOPPED");
      expect(stopped.stopReason).toBe("button");
      expect(database.isAgentRunActive(run.agentRunId, 2_001)).toBe(false);
      expect(database.countAuditEvents("AGENT_RUN_STOPPED")).toBe(1);
    } finally {
      database.close();
    }
  });

  it("binds every tool renewal and stop to the owning runtime instance", () => {
    const database = new TradingDatabase(":memory:");
    try {
      const run = database.startAgentRun({
        host: "codex",
        model: "test",
        runtimeInstanceId: "runtime-owner",
        nowMs: 1_000
      });
      expect(run.runtimeInstanceId).toBe("runtime-owner");
      expect(() =>
        database.touchAgentRun({
          agentRunId: run.agentRunId,
          runtimeInstanceId: "runtime-other",
          phase: "ANALYZING",
          nowMs: 2_000
        })
      ).toThrow("AGENT_RUN_INSTANCE_MISMATCH");

      const touched = database.touchAgentRun({
        agentRunId: run.agentRunId,
        runtimeInstanceId: "runtime-owner",
        phase: "ANALYZING",
        currentCycleId: "cycle-one",
        nowMs: 2_000
      });
      expect(touched).toMatchObject({
        currentCycleId: "cycle-one",
        lastToolActivityAtMs: 2_000,
        leaseExpiresAtMs: 2_000 + AGENT_RUN_LEASE_MS
      });
      expect(() =>
        database.stopAgentRun(
          run.agentRunId,
          "foreign-close",
          3_000,
          "runtime-other"
        )
      ).toThrow("AGENT_RUN_INSTANCE_MISMATCH");
      expect(database.getAgentRun(3_000)?.status).toBe("ACTIVE");
    } finally {
      database.close();
    }
  });

  it("keeps an inactive MCP instance from shutting down another owner", () => {
    const database = new TradingDatabase(":memory:");
    try {
      const run = database.startAgentRun({
        host: "codex",
        model: "test",
        runtimeInstanceId: "runtime-owner",
        nowMs: 1_000
      });
      expect(
        runtimeCloseSafetyDecision(run, "runtime-diagnostic", true)
      ).toEqual({
        ownsActiveAgentRun: false,
        failClosedForUnreconciledExecution: false
      });
      expect(runtimeCloseSafetyDecision(run, "runtime-owner", true)).toEqual({
        ownsActiveAgentRun: true,
        failClosedForUnreconciledExecution: true
      });
    } finally {
      database.close();
    }
  });
});
