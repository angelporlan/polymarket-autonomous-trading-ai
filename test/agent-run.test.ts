import { describe, expect, it } from "vitest";
import { AGENT_RUN_LEASE_MS, TradingDatabase } from "../src/storage/database.js";

describe("agent supervised lease", () => {
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
});
