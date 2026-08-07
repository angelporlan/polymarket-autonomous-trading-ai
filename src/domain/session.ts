import { randomUUID } from "node:crypto";
import { PUSD_SCALE, type ExecutionMode } from "./types.js";

export type SessionStatus = "ACTIVE" | "EXPIRED" | "EXHAUSTED" | "CLOSED";

export interface TradingSession {
  id: string;
  executionMode: ExecutionMode;
  authorizedBudgetMicros: bigint;
  remainingBudgetMicros: bigint;
  status: SessionStatus;
  createdAtMs: number;
  expiresAtMs: number;
  closedReason: string | null;
}

export interface CreateSessionInput {
  executionMode: ExecutionMode;
  authorizedBudgetMicros: bigint;
  ttlMs?: number; // Default 8 hours (28,800,000 ms)
  nowMs?: number;
}

export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000; // 8 hours

export function createTradingSession(input: CreateSessionInput): TradingSession {
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_SESSION_TTL_MS;

  if (input.authorizedBudgetMicros <= 0n) {
    throw new Error("Authorized trading session budget must be positive.");
  }

  const id = `session_${nowMs}_${randomUUID().slice(0, 8)}`;

  return {
    id,
    executionMode: input.executionMode,
    authorizedBudgetMicros: input.authorizedBudgetMicros,
    remainingBudgetMicros: input.authorizedBudgetMicros,
    status: "ACTIVE",
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    closedReason: null
  };
}

export function isSessionValid(
  session: TradingSession,
  requiredAmountMicros: bigint,
  nowMs: number = Date.now()
): { valid: boolean; reason?: string } {
  if (session.status !== "ACTIVE") {
    return { valid: false, reason: `Trading session ${session.id} is ${session.status}.` };
  }
  if (nowMs >= session.expiresAtMs) {
    return { valid: false, reason: `Trading session ${session.id} has expired.` };
  }
  if (session.remainingBudgetMicros < requiredAmountMicros) {
    return {
      valid: false,
      reason: `Insufficient session budget. Remaining: ${session.remainingBudgetMicros} micros, required: ${requiredAmountMicros} micros.`
    };
  }
  return { valid: true };
}
