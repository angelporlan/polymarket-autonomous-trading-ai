import { createHash, randomUUID } from "node:crypto";
import { PUSD_SCALE, type ExecutionMode } from "./types.js";

export type SessionStatus = "ACTIVE" | "EXPIRED" | "EXHAUSTED" | "CLOSED";
export type PendingTradingSessionStatus =
  | "PENDING"
  | "AUTHORIZED"
  | "ACTIVATED"
  | "EXPIRED";

export function minBigInt(...values: bigint[]): bigint {
  if (values.length === 0) throw new Error("minBigInt requires at least one value.");
  let min = values[0]!;
  for (let i = 1; i < values.length; i++) {
    if (values[i]! < min) {
      min = values[i]!;
    }
  }
  return min;
}

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

export interface PendingTradingSession {
  id: string;
  executionMode: ExecutionMode;
  cashAvailableMicros: bigint | null;
  openExposureMicros: bigint;
  hardCeilingRemainingMicros: bigint;
  dailyStopRemainingMicros: bigint;
  maximumAuthorizableMicros: bigint;
  challengeHash: string;
  sessionTtlMs: number;
  status: PendingTradingSessionStatus;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface SessionAuthorization {
  pendingSessionId: string;
  amountMicros: bigint;
  challengeHash: string;
  confirmedAtMs: number;
  consumedAtMs: number | null;
}

export interface CreateSessionInput {
  executionMode: ExecutionMode;
  authorizedBudgetMicros: bigint;
  ttlMs?: number; // Default 8 hours (28,800,000 ms)
  nowMs?: number;
}

export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000; // 8 hours
export const MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
export const PENDING_SESSION_TTL_MS = 10 * 60 * 1_000;

export function normalizeSessionTtlMs(ttlMs = DEFAULT_SESSION_TTL_MS): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_SESSION_TTL_MS) {
    throw new Error("Trading session duration must be between 1 and 24 hours.");
  }
  return ttlMs;
}

export function hashSessionChallenge(challenge: string): string {
  const normalized = challenge.trim().toUpperCase();
  if (!/^[A-Z0-9]{16,64}$/u.test(normalized)) {
    throw new Error("Invalid trading session challenge.");
  }
  return createHash("sha256").update(normalized).digest("hex");
}

export function createPendingTradingSession(input: {
  executionMode: ExecutionMode;
  cashAvailableMicros: bigint | null;
  openExposureMicros: bigint;
  hardCeilingRemainingMicros: bigint;
  dailyStopRemainingMicros: bigint;
  maximumAuthorizableMicros: bigint;
  challengeHash: string;
  sessionTtlMs?: number;
  nowMs?: number;
}): PendingTradingSession {
  const nowMs = input.nowMs ?? Date.now();
  const sessionTtlMs = normalizeSessionTtlMs(input.sessionTtlMs);
  if (input.maximumAuthorizableMicros <= 0n) {
    throw new Error("No trading session capacity remains to authorize.");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.challengeHash)) {
    throw new Error("Invalid trading session challenge hash.");
  }
  return {
    id: `pending_${nowMs}_${randomUUID().slice(0, 8)}`,
    executionMode: input.executionMode,
    cashAvailableMicros: input.cashAvailableMicros,
    openExposureMicros: input.openExposureMicros,
    hardCeilingRemainingMicros: input.hardCeilingRemainingMicros,
    dailyStopRemainingMicros: input.dailyStopRemainingMicros,
    maximumAuthorizableMicros: input.maximumAuthorizableMicros,
    challengeHash: input.challengeHash,
    sessionTtlMs,
    status: "PENDING",
    createdAtMs: nowMs,
    expiresAtMs: nowMs + PENDING_SESSION_TTL_MS
  };
}

export function createTradingSession(input: CreateSessionInput): TradingSession {
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = normalizeSessionTtlMs(input.ttlMs);

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
