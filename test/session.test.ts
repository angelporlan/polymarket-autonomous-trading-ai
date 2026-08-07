import { describe, expect, it } from "vitest";
import {
  createPendingTradingSession,
  createTradingSession,
  hashSessionChallenge,
  isSessionValid,
  DEFAULT_SESSION_TTL_MS
} from "../src/domain/session.js";
import { PUSD_SCALE } from "../src/domain/types.js";
import { TradingDatabase } from "../src/storage/database.js";

describe("TradingSession", () => {
  it("creates a valid active session with authorized budget", () => {
    const nowMs = Date.now();
    const session = createTradingSession({
      executionMode: "paper",
      authorizedBudgetMicros: 50n * PUSD_SCALE,
      nowMs
    });

    expect(session.id).toMatch(/^session_\d+_[a-f0-9-]+$/);
    expect(session.executionMode).toBe("paper");
    expect(session.authorizedBudgetMicros).toBe(50n * PUSD_SCALE);
    expect(session.remainingBudgetMicros).toBe(50n * PUSD_SCALE);
    expect(session.status).toBe("ACTIVE");
    expect(session.expiresAtMs).toBe(nowMs + DEFAULT_SESSION_TTL_MS);
  });

  it("rejects invalid budget authorization", () => {
    expect(() =>
      createTradingSession({
        executionMode: "live",
        authorizedBudgetMicros: 0n
      })
    ).toThrow("Authorized trading session budget must be positive.");
  });

  it("validates session remaining budget and expiration", () => {
    const nowMs = Date.now();
    const session = createTradingSession({
      executionMode: "live",
      authorizedBudgetMicros: 20n * PUSD_SCALE,
      nowMs
    });

    const validCheck = isSessionValid(session, 10n * PUSD_SCALE, nowMs);
    expect(validCheck.valid).toBe(true);

    const exceedCheck = isSessionValid(session, 30n * PUSD_SCALE, nowMs);
    expect(exceedCheck.valid).toBe(false);
    expect(exceedCheck.reason).toContain("Insufficient session budget");

    const expiredCheck = isSessionValid(session, 5n * PUSD_SCALE, nowMs + DEFAULT_SESSION_TTL_MS + 1000);
    expect(expiredCheck.valid).toBe(false);
    expect(expiredCheck.reason).toContain("has expired");
  });

  it("requires one local challenge authorization and consumes it atomically", () => {
    const nowMs = Date.now();
    const database = new TradingDatabase(":memory:");
    const challenge = "ABC123456789XYZ0";
    const pending = createPendingTradingSession({
      executionMode: "paper",
      cashAvailableMicros: null,
      openExposureMicros: 0n,
      hardCeilingRemainingMicros: 100n * PUSD_SCALE,
      dailyStopRemainingMicros: 10n * PUSD_SCALE,
      maximumAuthorizableMicros: 10n * PUSD_SCALE,
      challengeHash: hashSessionChallenge(challenge),
      nowMs
    });
    database.savePendingTradingSession(pending);

    database.recordSessionAuthorization(
      pending.id,
      5n * PUSD_SCALE,
      challenge,
      nowMs + 1
    );
    const authorization = database.getSessionAuthorization(pending.id);
    expect(authorization).toMatchObject({
      pendingSessionId: pending.id,
      amountMicros: 5n * PUSD_SCALE,
      challengeHash: hashSessionChallenge(challenge),
      consumedAtMs: null
    });

    const session = database.activateTradingSession(pending.id, nowMs + 2);
    expect(session).toMatchObject({
      executionMode: "paper",
      authorizedBudgetMicros: 5n * PUSD_SCALE,
      remainingBudgetMicros: 5n * PUSD_SCALE,
      status: "ACTIVE"
    });
    expect(database.activateTradingSession(pending.id, nowMs + 3)).toBeNull();
    expect(database.getSessionAuthorization(pending.id)?.consumedAtMs).toBe(
      nowMs + 2
    );
    expect(() =>
      database.recordSessionAuthorization(
        pending.id,
        5n * PUSD_SCALE,
        challenge,
        nowMs + 4
      )
    ).toThrow(/already authorized|already been used/i);
    database.close();
  });

  it("rejects a wrong challenge, an excessive amount, and a second active session", () => {
    const nowMs = Date.now();
    const database = new TradingDatabase(":memory:");
    const pending = createPendingTradingSession({
      executionMode: "paper",
      cashAvailableMicros: null,
      openExposureMicros: 0n,
      hardCeilingRemainingMicros: 100n * PUSD_SCALE,
      dailyStopRemainingMicros: 10n * PUSD_SCALE,
      maximumAuthorizableMicros: 5n * PUSD_SCALE,
      challengeHash: hashSessionChallenge("ABC123456789XYZ0"),
      nowMs
    });
    database.savePendingTradingSession(pending);
    expect(() =>
      database.recordSessionAuthorization(
        pending.id,
        1n * PUSD_SCALE,
        "WRONG123456789XYZ",
        nowMs + 1
      )
    ).toThrow("Trading session challenge mismatch.");
    expect(() =>
      database.recordSessionAuthorization(
        pending.id,
        6n * PUSD_SCALE,
        "ABC123456789XYZ0",
        nowMs + 1
      )
    ).toThrow(/exceeds the current maximum/);

    database.recordSessionAuthorization(
      pending.id,
      5n * PUSD_SCALE,
      "ABC123456789XYZ0",
      nowMs + 1
    );
    expect(database.activateTradingSession(pending.id, nowMs + 2)).not.toBeNull();

    const secondPending = createPendingTradingSession({
      executionMode: "paper",
      cashAvailableMicros: null,
      openExposureMicros: 0n,
      hardCeilingRemainingMicros: 100n * PUSD_SCALE,
      dailyStopRemainingMicros: 10n * PUSD_SCALE,
      maximumAuthorizableMicros: 5n * PUSD_SCALE,
      challengeHash: hashSessionChallenge("DEF123456789XYZ0"),
      nowMs: nowMs + 3
    });
    database.savePendingTradingSession(secondPending);
    expect(() =>
      database.recordSessionAuthorization(
        secondPending.id,
        1n * PUSD_SCALE,
        "DEF123456789XYZ0",
        nowMs + 4
      )
    ).toThrow("An active trading session already exists.");
    database.close();
  });
});
