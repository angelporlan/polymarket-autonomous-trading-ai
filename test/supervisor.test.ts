import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bootstrapOrRestartSupervisor,
  renderLaunchdPlist
} from "../src/cli/install-supervisor.js";
import { TradingDatabase } from "../src/storage/database.js";
import { SupervisorProcessLock } from "../src/supervisor/process-lock.js";
import {
  nextSupervisorDelayMs,
  supervisorBackoffDelayMs
} from "../src/supervisor/scheduler.js";
import { sanitizeSupervisorErrorCode } from "../src/supervisor/main.js";
import type { SupervisorHeartbeat } from "../src/supervisor/types.js";

describe("persistent position supervisor", () => {
  it("allows one process and recovers a lock owned by a dead pid", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "polymarket-supervisor-"));
    const lockPath = path.join(directory, "supervisor.lock");
    try {
      const first = SupervisorProcessLock.acquire(lockPath, 100);
      expect(() => SupervisorProcessLock.acquire(lockPath, 101)).toThrow(
        "SUPERVISOR_ALREADY_RUNNING"
      );
      first.release();

      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: Number.MAX_SAFE_INTEGER,
          startedAtMs: 100,
          token: "stale-lock"
        })
      );
      const recovered = SupervisorProcessLock.acquire(lockPath, 102);
      expect(readFileSync(lockPath, "utf8")).toContain(String(process.pid));
      recovered.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the required normal, active, and jittered failure cadences", () => {
    expect(nextSupervisorDelayMs(false, 0)).toBe(10_000);
    expect(nextSupervisorDelayMs(true, 0)).toBe(5_000);
    expect(nextSupervisorDelayMs(true, 1)).toBe(15_000);
    expect(supervisorBackoffDelayMs(1, 0)).toBe(800);
    expect(supervisorBackoffDelayMs(2, 1)).toBe(2_400);
  });

  it("persists and validates a local heartbeat without storing secrets", () => {
    const database = new TradingDatabase(":memory:");
    const heartbeat: SupervisorHeartbeat = {
      pid: process.pid,
      startedAtMs: 100,
      status: "HEALTHY",
      lastCycleAtMs: 200,
      lastSuccessAtMs: 200,
      nextCycleAtMs: 60_200,
      consecutiveFailures: 0,
      reconciliationActive: true,
      lastErrorCode: null
    };
    database.saveSupervisorHeartbeat(heartbeat, 200);
    expect(database.getSupervisorHeartbeat()).toEqual(heartbeat);
    database.db
      .prepare(
        "UPDATE system_state SET value = ? WHERE key = 'supervisor_heartbeat'"
      )
      .run(JSON.stringify({ ...heartbeat, status: "INVALID" }));
    expect(database.getSupervisorHeartbeat()).toBeNull();
    database.close();
  });

  it("renders a launchd job with no environment or credential arguments", () => {
    const plist = renderLaunchdPlist({
      executable: "/usr/local/bin/node",
      entrypoint: "/workspace/dist/supervisor/main.js",
      repositoryRoot: "/workspace",
      stdoutPath: "/workspace/data/supervisor.stdout.log",
      stderrPath: "/workspace/data/supervisor.stderr.log"
    });
    expect(plist).toContain("com.codex.polymarket.supervisor");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).not.toContain("EnvironmentVariables");
    expect(plist).not.toContain("PRIVATE_KEY");
    expect(plist).not.toContain("L2");
  });

  it("bootstraps a supervisor that is not loaded", () => {
    const calls: string[][] = [];
    const result = bootstrapOrRestartSupervisor(
      501,
      "/tmp/supervisor.plist",
      (args) => calls.push(args)
    );
    expect(result).toBe("installed");
    expect(calls).toEqual([
      ["bootstrap", "gui/501", "/tmp/supervisor.plist"]
    ]);
  });

  it("restarts an already loaded supervisor instead of failing", () => {
    const calls: string[][] = [];
    const result = bootstrapOrRestartSupervisor(
      501,
      "/tmp/supervisor.plist",
      (args) => {
        calls.push(args);
        if (args[0] === "bootstrap") throw new Error("already loaded");
      }
    );
    expect(result).toBe("restarted");
    expect(calls).toEqual([
      ["bootstrap", "gui/501", "/tmp/supervisor.plist"],
      ["print", "gui/501/com.codex.polymarket.supervisor"],
      ["kickstart", "-k", "gui/501/com.codex.polymarket.supervisor"]
    ]);
  });

  it("preserves the bootstrap failure when no loaded service exists", () => {
    const bootstrapError = new Error("bootstrap failed");
    expect(() =>
      bootstrapOrRestartSupervisor(
        501,
        "/tmp/supervisor.plist",
        (args) => {
          if (args[0] === "bootstrap") throw bootstrapError;
          throw new Error("service missing");
        }
      )
    ).toThrow(bootstrapError);
  });

  it("preserves validated safe error codes from typed supervisor failures", () => {
    expect(
      sanitizeSupervisorErrorCode(
        Object.assign(new Error("A safe external request failed."), {
          code: "CLOB_OPEN_ORDERS_ERROR"
        })
      )
    ).toBe("CLOB_OPEN_ORDERS_ERROR");
    expect(
      sanitizeSupervisorErrorCode(
        Object.assign(new Error("A request failed."), {
          code: "unsafe detail with spaces"
        })
      )
    ).toBe("SUPERVISOR_CYCLE_FAILED");
  });
});
