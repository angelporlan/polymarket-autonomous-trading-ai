import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { PolymarketRuntime } from "../runtime.js";
import { SupervisorProcessLock } from "./process-lock.js";
import {
  nextSupervisorDelayMs,
  supervisorBackoffDelayMs
} from "./scheduler.js";
import type { SupervisorHeartbeat } from "./types.js";

const SUPERVISOR_LOCK_SUFFIX = ".supervisor.lock";
const SUPERVISOR_ERROR_CODE = "SUPERVISOR_CYCLE_FAILED";

export async function runSupervisor(): Promise<void> {
  const config = loadConfig();
  const lock = SupervisorProcessLock.acquire(
    `${config.databasePath}${SUPERVISOR_LOCK_SUFFIX}`
  );
  let runtime: PolymarketRuntime | null = null;
  let stopRequested = false;
  let wakeWaiter: (() => void) | null = null;
  const requestStop = (): void => {
    stopRequested = true;
    wakeWaiter?.();
  };

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  try {
    runtime = new PolymarketRuntime();
    const startedAtMs = Date.now();
    let consecutiveFailures = 0;
    let lastSuccessAtMs: number | null = null;
    let reconciliationActive = false;

    persistHeartbeat(runtime, {
      pid: process.pid,
      startedAtMs,
      status: "STARTING",
      lastCycleAtMs: null,
      lastSuccessAtMs: null,
      nextCycleAtMs: null,
      consecutiveFailures: 0,
      reconciliationActive: false,
      lastErrorCode: null
    });

    while (!stopRequested) {
      const cycleAtMs = Date.now();
      try {
        const result = await runtime.runSupervisorCycle();
        consecutiveFailures = 0;
        lastSuccessAtMs = Date.now();
        reconciliationActive = result.reconciliationActive;
        const delayMs = nextSupervisorDelayMs(
          reconciliationActive || result.priorityReevaluation
        );
        persistHeartbeat(runtime, {
          pid: process.pid,
          startedAtMs,
          status: "HEALTHY",
          lastCycleAtMs: cycleAtMs,
          lastSuccessAtMs,
          nextCycleAtMs: Date.now() + delayMs,
          consecutiveFailures,
          reconciliationActive,
          lastErrorCode: null
        });
        await waitForNextCycle(
          delayMs,
          () => stopRequested,
          (wake) => {
            wakeWaiter = wake;
          }
        );
      } catch {
        consecutiveFailures += 1;
        reconciliationActive = false;
        try {
          await runtime.failSafeSupervisor();
        } catch {
          // The persistent emergency lock remains active even if cancellation
          // could not be confirmed. Reconciliation will retry on the next cycle.
        }
        const delayMs = supervisorBackoffDelayMs(consecutiveFailures);
        persistHeartbeat(runtime, {
          pid: process.pid,
          startedAtMs,
          status: "DEGRADED",
          lastCycleAtMs: cycleAtMs,
          lastSuccessAtMs,
          nextCycleAtMs: Date.now() + delayMs,
          consecutiveFailures,
          reconciliationActive,
          lastErrorCode: SUPERVISOR_ERROR_CODE
        });
        process.stderr.write(`${SUPERVISOR_ERROR_CODE}\n`);
        await waitForNextCycle(
          delayMs,
          () => stopRequested,
          (wake) => {
            wakeWaiter = wake;
          }
        );
      }
    }

    persistHeartbeat(runtime, {
      pid: process.pid,
      startedAtMs,
      status: "STOPPING",
      lastCycleAtMs: Date.now(),
      lastSuccessAtMs,
      nextCycleAtMs: null,
      consecutiveFailures,
      reconciliationActive,
      lastErrorCode: null
    });
  } catch {
    process.stderr.write(`${SUPERVISOR_ERROR_CODE}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    try {
      await runtime?.close();
    } catch {
      process.exitCode = 1;
    }
    lock.release();
  }
}

function persistHeartbeat(
  runtime: PolymarketRuntime,
  heartbeat: SupervisorHeartbeat
): void {
  runtime.saveSupervisorHeartbeat(heartbeat);
}

function waitForNextCycle(
  delayMs: number,
  shouldStop: () => boolean,
  registerWake: (wake: (() => void) | null) => void
): Promise<void> {
  if (shouldStop()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      registerWake(null);
      resolve();
    }, delayMs);
    registerWake(() => {
      clearTimeout(timer);
      registerWake(null);
      resolve();
    });
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  void runSupervisor();
}
