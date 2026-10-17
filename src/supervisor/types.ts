import type { SupervisePositionsOutput } from "../mcp/schemas.js";

export type SupervisorHeartbeatStatus =
  | "STARTING"
  | "HEALTHY"
  | "DEGRADED"
  | "STOPPING";

export type SupervisorMode =
  | "IDLE"
  | "ARMED"
  | "AGENT_ACTIVE"
  | "LOCKED_RECONCILING"
  | "DEGRADED";

export interface SupervisorHeartbeat {
  pid: number;
  startedAtMs: number;
  status: SupervisorHeartbeatStatus;
  lastCycleAtMs: number | null;
  lastSuccessAtMs: number | null;
  nextCycleAtMs: number | null;
  consecutiveFailures: number;
  reconciliationActive: boolean;
  lastErrorCode: string | null;
  mode?: SupervisorMode;
}

export interface SupervisorCycleResult extends SupervisePositionsOutput {
  reconciliationActive: boolean;
  priorityReevaluation: boolean;
  entryEvaluatedCandidatesCount: number;
  entryStagedCount: number;
  entryExecutedCount: number;
  entrySkippedCount: number;
}
