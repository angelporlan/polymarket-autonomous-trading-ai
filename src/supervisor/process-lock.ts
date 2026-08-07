import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface LockOwner {
  pid: number;
  startedAtMs: number;
  token: string;
}

export class SupervisorProcessLock {
  private released = false;

  private constructor(
    private readonly lockPath: string,
    private readonly fd: number,
    private readonly owner: LockOwner
  ) {}

  static acquire(lockPath: string, nowMs = Date.now()): SupervisorProcessLock {
    const normalizedPath = path.resolve(lockPath);
    mkdirSync(path.dirname(normalizedPath), { recursive: true, mode: 0o700 });
    const owner: LockOwner = {
      pid: process.pid,
      startedAtMs: nowMs,
      token: randomUUID()
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(normalizedPath, "wx", 0o600);
        const payload = JSON.stringify(owner);
        writeSync(fd, payload, 0, "utf8");
        fsyncSync(fd);
        return new SupervisorProcessLock(normalizedPath, fd, owner);
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
        const existing = readLockOwner(normalizedPath);
        if (existing === null) {
          throw new Error("SUPERVISOR_LOCK_UNREADABLE");
        }
        if (isProcessAlive(existing.pid)) {
          throw new Error("SUPERVISOR_ALREADY_RUNNING");
        }
        unlinkSync(normalizedPath);
      }
    }

    throw new Error("SUPERVISOR_LOCK_ACQUIRE_FAILED");
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    closeSync(this.fd);
    const current = readLockOwner(this.lockPath);
    if (current?.token === this.owner.token) {
      unlinkSync(this.lockPath);
    }
  }
}

function readLockOwner(lockPath: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(record.pid) ||
      typeof record.startedAtMs !== "number" ||
      !Number.isFinite(record.startedAtMs) ||
      typeof record.token !== "string" ||
      record.token.length === 0
    ) {
      return null;
    }
    return {
      pid: record.pid as number,
      startedAtMs: record.startedAtMs,
      token: record.token
    };
  } catch {
    return null;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "EPERM"
    );
  }
}
