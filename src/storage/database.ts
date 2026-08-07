import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  ExecutionRecord,
  ExecutionMode,
  LocalApproval,
  OrderProposal,
  PaperTrade,
  PositionRecord,
  ProposalStatus,
  ResearchBundle
} from "../domain/types.js";
import {
  createTradingSession,
  hashSessionChallenge,
  type PendingTradingSession,
  type SessionAuthorization,
  type TradingSession
} from "../domain/session.js";
import {
  canonicalCorrelationKey
} from "../domain/types.js";
import { RISK_POLICY_VERSION } from "../domain/risk-policy.js";
import { verifyProposalHash } from "../domain/proposals.js";
import {
  normalizeClobOrderStatus,
  parseClobFixed6
} from "../polymarket/reconciliation.js";
import { parseWithBigInts, stringifyWithBigInts } from "./codec.js";

interface ProposalRow {
  payload_json: string;
}

interface ApprovalRow {
  proposal_id: string;
  proposal_hash: string;
  approved_at_ms: number;
  expires_at_ms: number;
  nonce_hash: string;
  consumed_at_ms: number | null;
}

interface ExecutionRow {
  proposal_id: string;
  proposal_hash: string;
  clob_order_id: string | null;
  status: string;
  submitted_at_ms: number;
  response_json: string;
}

interface StateRow {
  value: string;
}

const ACTIVE_EXIT_RESERVATION_STATUSES = new Set([
  "STAGED",
  "AWAITING_LOCAL",
  "LOCALLY_APPROVED",
  "EXECUTING",
  "SUBMITTED"
]);

const TERMINAL_EXECUTION_STATUSES = new Set([
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
  "CONFIRMED",
  "REJECTED"
]);

export interface AuditEventRecord {
  id: number;
  createdAtMs: number;
  eventType: string;
  subjectId: string | null;
  payload: unknown;
  previousHash: string;
  eventHash: string;
}

export interface AccountBindingRecord {
  signerAddress: string;
  funderAddress: string;
  profileAddress: string;
  signatureType: 1 | 3;
  verifiedAtMs: number;
}

export class TradingDatabase {
  readonly db: DatabaseSync;
  private readonly getProposalStatement: StatementSync;

  constructor(filename: string) {
    if (filename !== ":memory:") {
      const directory = path.dirname(filename);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }

    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA secure_delete = ON;
      PRAGMA journal_mode = WAL;
    `);
    this.migrate();

    if (filename !== ":memory:") {
      chmodSync(filename, 0o600);
    }

    this.getProposalStatement = this.db.prepare(
      "SELECT payload_json FROM proposals WHERE id = ?"
    );
    this.expireInterruptedApprovals(Date.now());
  }

  close(): void {
    this.db.close();
  }

  stageProposal(
    proposal: OrderProposal,
    availableExitSharesMicros?: bigint
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (proposal.executionMode === "live" && proposal.intent === "EXIT") {
        if (
          availableExitSharesMicros === undefined ||
          availableExitSharesMicros < proposal.sharesMicros
        ) {
          throw new Error("EXIT_SHARES_UNAVAILABLE");
        }
        const reservedRows = this.db
          .prepare(
            `SELECT r.shares_micros, p.status, p.expires_at_ms
             FROM exit_reservations r
             JOIN proposals p ON p.id = r.proposal_id
             WHERE r.token_id = ?`
          )
          .all(proposal.market.tokenId) as Array<{
          shares_micros: string;
          status: string;
          expires_at_ms: number;
        }>;
        const reservedSharesMicros = reservedRows.reduce(
          (total, row) =>
            isExitReservationActive(
              row.status,
              row.expires_at_ms,
              proposal.createdAtMs
            )
              ? total + BigInt(row.shares_micros)
              : total,
          0n
        );
        if (
          reservedSharesMicros + proposal.sharesMicros >
          availableExitSharesMicros
        ) {
          throw new Error("EXIT_SHARES_ALREADY_RESERVED");
        }
      }

      const payload = stringifyWithBigInts(proposal);
      this.db
        .prepare(
          `INSERT INTO proposals
            (id, hash, status, payload_json, created_at_ms, expires_at_ms, revision, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .run(
          proposal.id,
          proposal.hash,
          proposal.status,
          payload,
          proposal.createdAtMs,
          proposal.expiresAtMs,
          proposal.createdAtMs
        );
      if (proposal.executionMode === "live" && proposal.intent === "EXIT") {
        this.db
          .prepare(
            `INSERT INTO exit_reservations
              (proposal_id, token_id, shares_micros, created_at_ms)
             VALUES (?, ?, ?, ?)`
          )
          .run(
            proposal.id,
            proposal.market.tokenId,
            proposal.sharesMicros.toString(),
            proposal.createdAtMs
          );
      }
      this.appendAudit("PROPOSAL_STAGED", proposal.id, {
        proposalId: proposal.id,
        proposalHash: proposal.hash,
        expiresAtMs: proposal.expiresAtMs,
        ...(proposal.intent === "EXIT"
          ? { reservedExitSharesMicros: proposal.sharesMicros }
          : {})
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getProposal(id: string): OrderProposal | null {
    const row = this.getProposalStatement.get(id) as ProposalRow | undefined;
    return row ? parseWithBigInts<OrderProposal>(row.payload_json) : null;
  }

  listProposals(): OrderProposal[] {
    const rows = this.db
      .prepare("SELECT payload_json FROM proposals ORDER BY created_at_ms ASC")
      .all() as unknown as ProposalRow[];
    return rows.map((row) => parseWithBigInts<OrderProposal>(row.payload_json));
  }

  transitionProposal(
    id: string,
    expectedStatus: ProposalStatus,
    nextStatus: ProposalStatus,
    nowMs: number
  ): OrderProposal | null {
    const proposal = this.getProposal(id);
    if (!proposal || proposal.status !== expectedStatus) {
      return null;
    }

    const updated: OrderProposal = { ...proposal, status: nextStatus };
    const result = this.db
      .prepare(
        `UPDATE proposals
         SET status = ?, payload_json = ?, revision = revision + 1, updated_at_ms = ?
         WHERE id = ? AND hash = ? AND status = ?`
      )
      .run(
        nextStatus,
        stringifyWithBigInts(updated),
        nowMs,
        id,
        proposal.hash,
        expectedStatus
      );
    if (result.changes !== 1) {
      return null;
    }

    this.appendAudit("PROPOSAL_TRANSITION", id, {
      from: expectedStatus,
      to: nextStatus,
      proposalHash: proposal.hash
    });
    return updated;
  }

  recordLocalApproval(approval: LocalApproval): void {
    this.db
      .prepare(
        `INSERT INTO approvals
          (proposal_id, proposal_hash, approved_at_ms, expires_at_ms, nonce_hash, consumed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(proposal_id) DO UPDATE SET
           proposal_hash = excluded.proposal_hash,
           approved_at_ms = excluded.approved_at_ms,
           expires_at_ms = excluded.expires_at_ms,
           nonce_hash = excluded.nonce_hash,
           consumed_at_ms = NULL`
      )
      .run(
        approval.proposalId,
        approval.proposalHash,
        approval.approvedAtMs,
        approval.expiresAtMs,
        approval.nonceHash,
        approval.consumedAtMs
      );
    this.appendAudit("LOCAL_APPROVAL_RECORDED", approval.proposalId, {
      proposalHash: approval.proposalHash,
      approvedAtMs: approval.approvedAtMs,
      expiresAtMs: approval.expiresAtMs
    });
  }

  getLocalApproval(proposalId: string): LocalApproval | null {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE proposal_id = ?")
      .get(proposalId) as ApprovalRow | undefined;
    if (!row) {
      return null;
    }
    return {
      proposalId: row.proposal_id,
      proposalHash: row.proposal_hash,
      approvedAtMs: row.approved_at_ms,
      expiresAtMs: row.expires_at_ms,
      nonceHash: row.nonce_hash,
      consumedAtMs: row.consumed_at_ms
    };
  }

  consumeLocalApproval(
    proposalId: string,
    proposalHash: string,
    nowMs: number
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE approvals
         SET consumed_at_ms = ?
         WHERE proposal_id = ?
           AND proposal_hash = ?
           AND consumed_at_ms IS NULL
           AND expires_at_ms >= ?`
      )
      .run(nowMs, proposalId, proposalHash, nowMs);
    if (result.changes === 1) {
      this.appendAudit("LOCAL_APPROVAL_CONSUMED", proposalId, {
        proposalHash,
        consumedAtMs: nowMs
      });
      return true;
    }
    return false;
  }

  claimExecution(proposalId: string, proposalHash: string, nowMs: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const proposal = this.getProposal(proposalId);
      const approval = this.getLocalApproval(proposalId);
      if (
        !proposal ||
        proposal.hash !== proposalHash ||
        proposal.status !== "LOCALLY_APPROVED" ||
        proposal.expiresAtMs < nowMs ||
        proposal.policyVersion !== RISK_POLICY_VERSION ||
        !verifyProposalHash(proposal) ||
        !approval ||
        approval.proposalHash !== proposalHash ||
        approval.expiresAtMs < nowMs ||
        approval.consumedAtMs !== null
      ) {
        this.db.exec("ROLLBACK");
        return false;
      }

      if (proposal.executionMode === "live" && proposal.intent === "ENTRY") {
        if (proposal.sessionId === null) {
          this.db.exec("ROLLBACK");
          return false;
        }
        const sessionRow = this.db
          .prepare(
            "SELECT payload_json FROM trading_sessions WHERE id = ? AND status = 'ACTIVE'"
          )
          .get(proposal.sessionId) as ProposalRow | undefined;
        if (!sessionRow) {
          this.db.exec("ROLLBACK");
          return false;
        }
        const session = parseWithBigInts<TradingSession>(sessionRow.payload_json);
        if (
          session.executionMode !== "live" ||
          nowMs >= session.expiresAtMs ||
          session.remainingBudgetMicros < proposal.maxLossMicros
        ) {
          this.db.exec("ROLLBACK");
          return false;
        }
        const remainingBudgetMicros =
          session.remainingBudgetMicros - proposal.maxLossMicros;
        const updatedSession: TradingSession = {
          ...session,
          remainingBudgetMicros,
          status: remainingBudgetMicros === 0n ? "EXHAUSTED" : "ACTIVE"
        };
        const sessionUpdate = this.db
          .prepare(
            `UPDATE trading_sessions
             SET status = ?, payload_json = ?
             WHERE id = ? AND status = 'ACTIVE'`
          )
          .run(
            updatedSession.status,
            stringifyWithBigInts(updatedSession),
            proposal.sessionId
          );
        if (sessionUpdate.changes !== 1) {
          this.db.exec("ROLLBACK");
          return false;
        }
      }

      const consumed = this.db
        .prepare(
          `UPDATE approvals SET consumed_at_ms = ?
           WHERE proposal_id = ? AND proposal_hash = ? AND consumed_at_ms IS NULL`
        )
        .run(nowMs, proposalId, proposalHash);
      const transitioned = this.db
        .prepare(
          `UPDATE proposals
           SET status = 'EXECUTING',
               payload_json = ?,
               revision = revision + 1,
               updated_at_ms = ?
           WHERE id = ? AND hash = ? AND status = 'LOCALLY_APPROVED'`
        )
        .run(
          stringifyWithBigInts({ ...proposal, status: "EXECUTING" }),
          nowMs,
          proposalId,
          proposalHash
        );
      const execution = this.db
        .prepare(
          `INSERT OR IGNORE INTO executions
            (proposal_id, proposal_hash, clob_order_id, status, submitted_at_ms, response_json)
           VALUES (?, ?, NULL, 'CLAIMED', ?, '{}')`
        )
        .run(proposalId, proposalHash, nowMs);

      if (consumed.changes !== 1 || transitioned.changes !== 1 || execution.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }

      this.appendAudit("EXECUTION_CLAIMED", proposalId, {
        proposalHash,
        claimedAtMs: nowMs
      });
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markExecutionSubmitted(record: ExecutionRecord): void {
    if (
      record.clobOrderId === null ||
      !/^0x[a-fA-F0-9]{64}$/u.test(record.clobOrderId) ||
      record.status !== "SUBMITTED_UNRECONCILED" ||
      record.responseJson.length > 1_000_000
    ) {
      throw new Error("Invalid submitted execution record.");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const execution = this.db
        .prepare(
          `UPDATE executions
           SET clob_order_id = ?, status = ?, submitted_at_ms = ?, response_json = ?
           WHERE proposal_id = ? AND proposal_hash = ?
             AND clob_order_id IS NULL AND status = 'CLAIMED'`
        )
        .run(
          record.clobOrderId,
          record.status,
          record.submittedAtMs,
          record.responseJson,
          record.proposalId,
          record.proposalHash
        );
      const proposal = this.db
        .prepare(
          `UPDATE proposals
           SET status = 'SUBMITTED',
               payload_json = json_set(payload_json, '$.status', 'SUBMITTED'),
               revision = revision + 1,
               updated_at_ms = ?
           WHERE id = ? AND hash = ? AND status = 'EXECUTING'`
        )
        .run(record.submittedAtMs, record.proposalId, record.proposalHash);
      if (execution.changes !== 1 || proposal.changes !== 1) {
        throw new Error("Execution submission state changed unexpectedly.");
      }
      this.appendAudit("EXECUTION_SUBMITTED", record.proposalId, {
        proposalHash: record.proposalHash,
        clobOrderId: record.clobOrderId,
        status: record.status,
        responseHash: createHash("sha256")
          .update(record.responseJson)
          .digest("hex")
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markExecutionFailed(proposalId: string, proposalHash: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `DELETE FROM executions WHERE proposal_id = ? AND proposal_hash = ? AND status = 'CLAIMED'`
        )
        .run(proposalId, proposalHash);
      this.db
        .prepare(
          `UPDATE proposals
           SET status = 'REJECTED',
               payload_json = json_set(payload_json, '$.status', 'REJECTED'),
               revision = revision + 1,
               updated_at_ms = ?
           WHERE id = ? AND hash = ? AND (status = 'STAGED' OR status = 'AWAITING_LOCAL' OR status = 'LOCALLY_APPROVED' OR status = 'EXECUTING')`
        )
        .run(Date.now(), proposalId, proposalHash);
      this.db
        .prepare("DELETE FROM exit_reservations WHERE proposal_id = ?")
        .run(proposalId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getExecution(proposalId: string): ExecutionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM executions WHERE proposal_id = ?")
      .get(proposalId) as ExecutionRow | undefined;
    if (!row) {
      return null;
    }
    return {
      proposalId: row.proposal_id,
      proposalHash: row.proposal_hash,
      clobOrderId: row.clob_order_id,
      status: row.status,
      submittedAtMs: row.submitted_at_ms,
      responseJson: row.response_json
    };
  }

  getExecutionByOrderId(orderId: string): ExecutionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM executions WHERE clob_order_id = ?")
      .get(orderId) as ExecutionRow | undefined;
    if (!row) {
      return null;
    }
    return {
      proposalId: row.proposal_id,
      proposalHash: row.proposal_hash,
      clobOrderId: row.clob_order_id,
      status: row.status,
      submittedAtMs: row.submitted_at_ms,
      responseJson: row.response_json
    };
  }

  listExecutions(): ExecutionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM executions ORDER BY submitted_at_ms ASC")
      .all() as unknown as ExecutionRow[];
    return rows.map((row) => ({
      proposalId: row.proposal_id,
      proposalHash: row.proposal_hash,
      clobOrderId: row.clob_order_id,
      status: row.status,
      submittedAtMs: row.submitted_at_ms,
      responseJson: row.response_json
    }));
  }

  updateExecutionStatus(
    proposalId: string,
    status: string,
    responseJson: string,
    nowMs = Date.now()
  ): boolean {
    if (responseJson.length > 1_000_000) {
      throw new Error("Execution reconciliation response is too large.");
    }
    const responseHash = createHash("sha256")
      .update(responseJson)
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare(
          "SELECT status FROM executions WHERE proposal_id = ?"
        )
        .get(proposalId) as { status: string } | undefined;
      if (
        current === undefined ||
        !isAllowedExecutionTransition(current.status, status)
      ) {
        throw new Error("Invalid or non-monotonic execution transition.");
      }
      const result = this.db
        .prepare(
          `UPDATE executions
           SET status = ?, response_json = ?
           WHERE proposal_id = ? AND status = ?`
        )
        .run(status, responseJson, proposalId, current.status);
      if (result.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const proposal = this.getProposal(proposalId);
      if (proposal?.executionMode === "live" && proposal.intent === "EXIT") {
        const normalizedStatus = status.toUpperCase();
        if (TERMINAL_EXECUTION_STATUSES.has(normalizedStatus)) {
          this.db
            .prepare("DELETE FROM exit_reservations WHERE proposal_id = ?")
            .run(proposalId);
        } else {
          const matchedSharesMicros = readMatchedSharesMicros(responseJson);
          if (matchedSharesMicros !== null) {
            const remainingSharesMicros =
              proposal.sharesMicros - matchedSharesMicros;
            if (remainingSharesMicros < 0n) {
              throw new Error("EXIT_FILL_EXCEEDS_PROPOSAL");
            }
            this.db
              .prepare(
                `UPDATE exit_reservations
                 SET shares_micros = ?
                 WHERE proposal_id = ?`
              )
              .run(remainingSharesMicros.toString(), proposalId);
          }
        }
      }
      this.appendAudit("EXECUTION_RECONCILED", proposalId, {
        status,
        responseHash,
        reconciledAtMs: nowMs
      });
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  countSubmittedExecutions(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM executions
         WHERE clob_order_id IS NOT NULL`
      )
      .get() as { count: number };
    return row.count;
  }

  countCanaryEligibleExecutions(): number {
    const baselineValue = this.getState("canary_execution_baseline");
    const baseline =
      baselineValue === null
        ? {
            executionRowId: 0,
            auditEventId: 0
          }
        : parseWithBigInts<{
            executionRowId?: number;
            auditEventId?: number;
          }>(baselineValue);
    const executionRowId = baseline.executionRowId ?? 0;
    const auditEventId = baseline.auditEventId ?? 0;
    if (
      !Number.isSafeInteger(executionRowId) ||
      executionRowId < 0 ||
      !Number.isSafeInteger(auditEventId) ||
      auditEventId < 0
    ) {
      throw new Error("Stored canary execution baseline is invalid.");
    }
    if (!this.verifyAuditChain() || this.getEmergencyStop().active) {
      return 0;
    }
    const incident = this.db
      .prepare(
        `SELECT 1
         FROM audit_events
         WHERE id > ? AND event_type = 'EMERGENCY_STOP_SET'
         LIMIT 1`
      )
      .get(auditEventId);
    if (incident !== undefined) {
      return 0;
    }

    const rows = this.db
      .prepare(
        `SELECT rowid, proposal_id, proposal_hash, clob_order_id, status,
                submitted_at_ms, response_json
         FROM executions
         WHERE rowid > ?
         ORDER BY rowid ASC`
      )
      .all(executionRowId) as unknown as Array<
      ExecutionRow & { rowid: number }
    >;
    return rows.filter((row) => this.isCanaryEligibleExecution(row)).length;
  }

  resetCanaryProgress(
    reason: "ACCOUNT_CHANGED" | "INCIDENT_REVIEWED",
    nowMs = Date.now()
  ): void {
    const submittedExecutionCount = this.countSubmittedExecutions();
    const executionRow = this.db
      .prepare("SELECT COALESCE(MAX(rowid), 0) AS id FROM executions")
      .get() as { id: number };
    const auditRow = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_events")
      .get() as { id: number };
    this.setState(
      "canary_execution_baseline",
      stringifyWithBigInts({
        submittedExecutionCount,
        executionRowId: executionRow.id,
        auditEventId: auditRow.id,
        resetAtMs: nowMs
      }),
      nowMs
    );
    this.appendAudit("CANARY_PROGRESS_RESET", null, {
      reason,
      submittedExecutionCount,
      resetAtMs: nowMs
    });
  }

  private isCanaryEligibleExecution(row: ExecutionRow): boolean {
    if (
      row.clob_order_id === null ||
      row.status.toUpperCase() !== "CONFIRMED"
    ) {
      return false;
    }
    const proposal = this.getProposal(row.proposal_id);
    if (
      proposal === null ||
      proposal.executionMode !== "live" ||
      proposal.status !== "SUBMITTED" ||
      proposal.hash !== row.proposal_hash ||
      !verifyProposalHash(proposal) ||
      proposal.market.eventId === null ||
      proposal.correlationKey !== canonicalCorrelationKey(proposal.market)
    ) {
      return false;
    }
    try {
      const response = parseWithBigInts<Record<string, unknown>>(
        row.response_json
      );
      const order = readRecord(response.order);
      const localOrder = readRecord(response.localOrder);
      const trades = readRecordArray(response.trades);
      const attributedTrades = readRecordArray(response.attributedTrades);
      const onchain = readRecord(response.onchain);
      const responseHash = createHash("sha256")
        .update(row.response_json)
        .digest("hex");
      const auditRow = this.db
        .prepare(
          `SELECT payload_json
           FROM audit_events
           WHERE event_type = 'EXECUTION_RECONCILED' AND subject_id = ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(row.proposal_id) as { payload_json: string } | undefined;
      const auditPayload =
        auditRow === undefined
          ? null
          : parseWithBigInts<Record<string, unknown>>(auditRow.payload_json);
      if (
        auditPayload === null ||
        auditPayload.responseHash !== responseHash ||
        auditPayload.status !== "CONFIRMED" ||
        readNonEmptyString(localOrder.orderHash).toLowerCase() !==
          row.clob_order_id.toLowerCase() ||
        readNonEmptyString(localOrder.metadata).toLowerCase() !==
          `0x${proposal.hash}`.toLowerCase() ||
        readNonEmptyString(localOrder.builder).toLowerCase() !==
          `0x${"00".repeat(32)}` ||
        typeof localOrder.expiration !== "number" ||
        !Number.isSafeInteger(localOrder.expiration) ||
        localOrder.expiration <= 0 ||
        typeof localOrder.timestampMs !== "number" ||
        !Number.isSafeInteger(localOrder.timestampMs) ||
        localOrder.timestampMs < proposal.createdAtMs - 300_000 ||
        localOrder.timestampMs > proposal.expiresAtMs + 60_000 ||
        typeof localOrder.makerAmountMicros !== "bigint" ||
        localOrder.makerAmountMicros !==
          (proposal.side === "BUY"
            ? proposal.maxCostMicros
            : proposal.sharesMicros) ||
        typeof localOrder.takerAmountMicros !== "bigint" ||
        localOrder.takerAmountMicros !==
          (proposal.side === "BUY"
            ? proposal.sharesMicros
            : proposal.maxCostMicros) ||
        readNonEmptyString(order.id) !== row.clob_order_id ||
        !["MATCHED", "FILLED"].includes(normalizeClobOrderStatus(order.status)) ||
        parseClobFixed6(
          order.originalSize,
          "CANARY_ORDER_SIZE_INVALID"
        ) !==
          proposal.sharesMicros ||
        parseClobFixed6(
          order.sizeMatched,
          "CANARY_MATCHED_SIZE_INVALID"
        ) !==
          proposal.sharesMicros ||
        readNonEmptyString(order.market).toLowerCase() !==
          proposal.market.conditionId.toLowerCase() ||
        readNonEmptyString(order.assetId) !== proposal.market.tokenId ||
        readNonEmptyString(order.side).toUpperCase() !== proposal.side ||
        attributedTrades.length === 0 ||
        trades.length !== attributedTrades.length ||
        onchain.finalized !== true ||
        onchain.filledSharesMicros !== proposal.sharesMicros
      ) {
        return false;
      }
      const tradeIds = new Set<string>();
      const transactionHashes = new Set<string>();
      let attributedShares = 0n;
      for (const trade of attributedTrades) {
        const tradeId = readNonEmptyString(trade.tradeId);
        const transactionHash = readNonEmptyString(trade.transactionHash);
        if (
          tradeIds.has(tradeId) ||
          !/^0x[a-fA-F0-9]{64}$/u.test(transactionHash) ||
          trade.status !== "CONFIRMED" ||
          (trade.role !== "TAKER" && trade.role !== "MAKER") ||
          typeof trade.sharesMicros !== "bigint" ||
          trade.sharesMicros <= 0n
        ) {
          return false;
        }
        tradeIds.add(tradeId);
        transactionHashes.add(transactionHash.toLowerCase());
        attributedShares += trade.sharesMicros;
      }
      const onchainHashes = readStringArrayStrict(
        onchain.transactionHashes
      ).map((hash) => hash.toLowerCase());
      const blockHashes = readStringArrayStrict(onchain.blockHashes).map(
        (hash) => hash.toLowerCase()
      );
      if (
        !Array.isArray(onchain.blockNumbers) ||
        !Array.isArray(onchain.blockTimestampsMs) ||
        blockHashes.length !== onchainHashes.length ||
        onchain.blockNumbers.length !== onchainHashes.length ||
        onchain.blockTimestampsMs.length !== onchainHashes.length ||
        blockHashes.some((hash) => !/^0x[a-f0-9]{64}$/u.test(hash)) ||
        onchain.blockNumbers.some(
          (value) => typeof value !== "bigint" || value <= 0n
        ) ||
        onchain.blockTimestampsMs.some(
          (value) =>
            typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value <= 0 ||
            value > (localOrder.expiration as number) * 1_000
        ) ||
        typeof onchain.grossCostMicros !== "bigint" ||
        onchain.grossCostMicros < 0n ||
        typeof onchain.feeMicros !== "bigint" ||
        onchain.feeMicros < 0n ||
        onchain.feeMicros > proposal.estimatedFeeMicros ||
        (proposal.side === "BUY" &&
          (onchain.grossCostMicros > proposal.maxCostMicros ||
            onchain.grossCostMicros + onchain.feeMicros >
              proposal.maxLossMicros))
      ) {
        return false;
      }
      return (
        attributedShares === proposal.sharesMicros &&
        onchainHashes.length === transactionHashes.size &&
        onchainHashes.every((hash) => transactionHashes.has(hash))
      );
    } catch {
      return false;
    }
  }

  setEmergencyStop(active: boolean, reason: string, nowMs = Date.now()): void {
    this.setState(
      "emergency_stop",
      stringifyWithBigInts({ active, reason, updatedAtMs: nowMs }),
      nowMs
    );
    this.appendAudit(active ? "EMERGENCY_STOP_SET" : "EMERGENCY_STOP_CLEARED", null, {
      reason,
      updatedAtMs: nowMs
    });
  }

  getEmergencyStop(): { active: boolean; reason: string; updatedAtMs: number } {
    const value = this.getState("emergency_stop");
    return value
      ? parseWithBigInts(value)
      : { active: false, reason: "", updatedAtMs: 0 };
  }

  setLiveActivation(active: boolean, nowMs = Date.now()): void {
    this.setState(
      "live_activation",
      stringifyWithBigInts({ active, updatedAtMs: nowMs }),
      nowMs
    );
    this.appendAudit(active ? "LIVE_ACTIVATED_LOCALLY" : "LIVE_DEACTIVATED", null, {
      updatedAtMs: nowMs
    });
  }

  getLiveActivation(): { active: boolean; updatedAtMs: number } {
    const value = this.getState("live_activation");
    return value ? parseWithBigInts(value) : { active: false, updatedAtMs: 0 };
  }

  setAccountBinding(binding: AccountBindingRecord): void {
    const previous = this.getAccountBinding();
    const normalized: AccountBindingRecord = {
      signerAddress: normalizeAddress(binding.signerAddress),
      funderAddress: normalizeAddress(binding.funderAddress),
      profileAddress: normalizeAddress(binding.profileAddress),
      signatureType: binding.signatureType,
      verifiedAtMs: binding.verifiedAtMs
    };
    if (normalized.signatureType !== 1 && normalized.signatureType !== 3) {
      throw new Error("Only POLY_PROXY and POLY_1271 bindings are supported.");
    }
    this.setState(
      "account_binding",
      stringifyWithBigInts(normalized),
      binding.verifiedAtMs
    );
    this.appendAudit("ACCOUNT_BINDING_VERIFIED", null, {
      ...normalized
    });
    if (
      previous === null ||
      previous.signerAddress !== normalized.signerAddress ||
      previous.funderAddress !== normalized.funderAddress ||
      previous.profileAddress !== normalized.profileAddress ||
      previous.signatureType !== normalized.signatureType
    ) {
      this.resetCanaryProgress("ACCOUNT_CHANGED", binding.verifiedAtMs);
      this.setLiveActivation(false, binding.verifiedAtMs);
    }
  }

  getAccountBinding(): AccountBindingRecord | null {
    const value = this.getState("account_binding");
    return value ? parseWithBigInts<AccountBindingRecord>(value) : null;
  }

  getDailyPnl(
    dayKey: string,
    currentTotalPnlMicros: bigint,
    nowMs = Date.now()
  ): bigint {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) {
      throw new Error("Invalid daily PnL key.");
    }
    const key = `daily_pnl_baseline:${dayKey}`;
    const value = this.getState(key);
    if (value === null) {
      this.setState(
        key,
        stringifyWithBigInts({
          baselineMicros: currentTotalPnlMicros,
          createdAtMs: nowMs
        }),
        nowMs
      );
      this.appendAudit("DAILY_PNL_BASELINE_CREATED", null, {
        dayKey,
        baselineMicros: currentTotalPnlMicros
      });
      return 0n;
    }
    const parsed = parseWithBigInts<{ baselineMicros: bigint }>(value);
    return currentTotalPnlMicros - parsed.baselineMicros;
  }

  armDailyRiskSession(
    dayKey: string,
    baselineMicros: bigint,
    nowMs = Date.now()
  ): void {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) {
      throw new Error("Invalid daily risk-session key.");
    }
    const accountFingerprint = this.dailyRiskAccountFingerprint();
    if (accountFingerprint === null) {
      throw new Error("Account binding is required for a daily risk session.");
    }
    const stateKey = `daily_risk_session:${accountFingerprint}:${dayKey}`;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO system_state (key, value, updated_at_ms)
         VALUES (?, ?, ?)`
      )
      .run(
        stateKey,
        stringifyWithBigInts({
          dayKey,
          accountFingerprint,
          baselineMicros,
          armedAtMs: nowMs
        }),
        nowMs
      );
    if (result.changes === 1) {
      this.appendAudit("DAILY_RISK_SESSION_ARMED", null, {
        dayKey,
        accountFingerprint,
        baselineMicros,
        armedAtMs: nowMs
      });
      return;
    }
    this.appendAudit("DAILY_RISK_SESSION_REUSED", null, {
      dayKey,
      accountFingerprint,
      reviewedAtMs: nowMs
    });
  }

  getDailyRiskPnl(
    dayKey: string,
    currentTotalPnlMicros: bigint
  ): { known: boolean; pnlMicros: bigint; armedAtMs: number | null } {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) {
      throw new Error("Invalid daily risk-session key.");
    }
    const accountFingerprint = this.dailyRiskAccountFingerprint();
    if (accountFingerprint === null) {
      return { known: false, pnlMicros: 0n, armedAtMs: null };
    }
    const value = this.getState(
      `daily_risk_session:${accountFingerprint}:${dayKey}`
    );
    if (value === null) {
      return { known: false, pnlMicros: 0n, armedAtMs: null };
    }
    const session = parseWithBigInts<{
      dayKey: string;
      accountFingerprint: string;
      baselineMicros: bigint;
      armedAtMs: number;
    }>(value);
    if (
      session.dayKey !== dayKey ||
      session.accountFingerprint !== accountFingerprint
    ) {
      throw new Error("Stored daily risk-session identity is inconsistent.");
    }
    return {
      known: true,
      pnlMicros: currentTotalPnlMicros - session.baselineMicros,
      armedAtMs: session.armedAtMs
    };
  }

  setCooldownUntil(
    untilMs: number,
    reason: string,
    nowMs = Date.now()
  ): void {
    if (!Number.isSafeInteger(untilMs) || untilMs <= nowMs) {
      throw new Error("Cooldown must end in the future.");
    }
    this.setState(
      "cooldown",
      stringifyWithBigInts({ untilMs, reason, updatedAtMs: nowMs }),
      nowMs
    );
    this.appendAudit("COOLDOWN_SET", null, { untilMs, reason });
  }

  getCooldown(): { untilMs: number; reason: string; updatedAtMs: number } {
    const value = this.getState("cooldown");
    return value
      ? parseWithBigInts(value)
      : { untilMs: 0, reason: "", updatedAtMs: 0 };
  }

  savePaperTrade(trade: PaperTrade): void {
    this.db
      .prepare(
        `INSERT INTO paper_trades
          (id, proposal_id, status, payload_json, opened_at_ms, closed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           payload_json = excluded.payload_json,
           closed_at_ms = excluded.closed_at_ms`
      )
      .run(
        trade.id,
        trade.proposalId,
        trade.status,
        stringifyWithBigInts(trade),
        trade.openedAtMs,
        trade.closedAtMs
      );
    this.appendAudit("PAPER_TRADE_SAVED", trade.id, {
      proposalId: trade.proposalId,
      status: trade.status
    });
  }

  listPaperTrades(): PaperTrade[] {
    const rows = this.db
      .prepare("SELECT payload_json FROM paper_trades ORDER BY opened_at_ms ASC")
      .all() as unknown as ProposalRow[];
    return rows.map((row) => parseWithBigInts<PaperTrade>(row.payload_json));
  }

  getPaperTradeByProposal(proposalId: string): PaperTrade | null {
    const row = this.db
      .prepare(
        `SELECT payload_json FROM paper_trades
         WHERE proposal_id = ? ORDER BY opened_at_ms DESC LIMIT 1`
      )
      .get(proposalId) as ProposalRow | undefined;
    return row ? parseWithBigInts<PaperTrade>(row.payload_json) : null;
  }

  saveTradingSession(session: TradingSession): void {
    this.db
      .prepare(
        `INSERT INTO trading_sessions
          (id, execution_mode, status, created_at_ms, expires_at_ms, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           payload_json = excluded.payload_json`
      )
      .run(
        session.id,
        session.executionMode,
        session.status,
        session.createdAtMs,
        session.expiresAtMs,
        stringifyWithBigInts(session)
      );
    this.appendAudit("TRADING_SESSION_SAVED", session.id, {
      executionMode: session.executionMode,
      authorizedBudgetMicros: session.authorizedBudgetMicros,
      remainingBudgetMicros: session.remainingBudgetMicros,
      status: session.status
    });
  }

  savePendingTradingSession(pending: PendingTradingSession): void {
    this.db
      .prepare(
        `INSERT INTO pending_trading_sessions
          (id, execution_mode, status, created_at_ms, expires_at_ms, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        pending.id,
        pending.executionMode,
        pending.status,
        pending.createdAtMs,
        pending.expiresAtMs,
        stringifyWithBigInts(pending)
      );
    this.appendAudit("TRADING_SESSION_PREPARED", pending.id, {
      executionMode: pending.executionMode,
      maximumAuthorizableMicros: pending.maximumAuthorizableMicros,
      expiresAtMs: pending.expiresAtMs
    });
  }

  getPendingTradingSession(id: string, nowMs = Date.now()): PendingTradingSession | null {
    const row = this.db
      .prepare(
        `SELECT payload_json FROM pending_trading_sessions
         WHERE id = ? AND status IN ('PENDING', 'AUTHORIZED') AND expires_at_ms > ?`
      )
      .get(id, nowMs) as ProposalRow | undefined;
    return row ? parseWithBigInts<PendingTradingSession>(row.payload_json) : null;
  }

  getPendingTradingSessionForMode(
    executionMode: ExecutionMode,
    nowMs = Date.now()
  ): PendingTradingSession | null {
    const row = this.db
      .prepare(
        `SELECT payload_json FROM pending_trading_sessions
         WHERE execution_mode = ? AND status IN ('PENDING', 'AUTHORIZED')
           AND expires_at_ms > ?
         ORDER BY created_at_ms DESC LIMIT 1`
      )
      .get(executionMode, nowMs) as ProposalRow | undefined;
    return row ? parseWithBigInts<PendingTradingSession>(row.payload_json) : null;
  }

  getSessionAuthorization(pendingSessionId: string): SessionAuthorization | null {
    const row = this.db
      .prepare(
        `SELECT pending_session_id, amount_micros, challenge_hash,
                confirmed_at_ms, consumed_at_ms
         FROM session_authorizations WHERE pending_session_id = ?`
      )
      .get(pendingSessionId) as
      | {
          pending_session_id: string;
          amount_micros: string;
          challenge_hash: string;
          confirmed_at_ms: number;
          consumed_at_ms: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      pendingSessionId: row.pending_session_id,
      amountMicros: BigInt(row.amount_micros),
      challengeHash: row.challenge_hash,
      confirmedAtMs: row.confirmed_at_ms,
      consumedAtMs: row.consumed_at_ms
    };
  }

  recordSessionAuthorization(
    pendingSessionId: string,
    amountMicros: bigint,
    challenge: string,
    nowMs = Date.now()
  ): void {
    if (amountMicros <= 0n) {
      throw new Error("Authorized trading session budget must be positive.");
    }
    const challengeHash = hashSessionChallenge(challenge);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pendingRow = this.db
        .prepare(
          `SELECT payload_json FROM pending_trading_sessions
           WHERE id = ? AND status = 'PENDING'`
        )
        .get(pendingSessionId) as ProposalRow | undefined;
      if (!pendingRow) {
        throw new Error("Pending trading session is missing or already authorized.");
      }
      const pending = parseWithBigInts<PendingTradingSession>(pendingRow.payload_json);
      if (nowMs >= pending.expiresAtMs) {
        throw new Error("Pending trading session challenge has expired.");
      }
      if (pending.challengeHash !== challengeHash) {
        throw new Error("Trading session challenge mismatch.");
      }
      if (amountMicros > pending.maximumAuthorizableMicros) {
        throw new Error(
          `Authorized amount exceeds the current maximum of ${pending.maximumAuthorizableMicros} micros.`
        );
      }
      const active = this.db
        .prepare(
          `SELECT 1 FROM trading_sessions
           WHERE execution_mode = ? AND status = 'ACTIVE' AND expires_at_ms > ?
           LIMIT 1`
        )
        .get(pending.executionMode, nowMs);
      if (active) {
        throw new Error("An active trading session already exists.");
      }
      const existing = this.db
        .prepare(
          "SELECT 1 FROM session_authorizations WHERE pending_session_id = ?"
        )
        .get(pendingSessionId);
      if (existing) {
        throw new Error("Trading session authorization has already been used.");
      }

      this.db
        .prepare(
          `INSERT INTO session_authorizations
            (pending_session_id, amount_micros, challenge_hash, confirmed_at_ms, consumed_at_ms)
           VALUES (?, ?, ?, ?, NULL)`
        )
        .run(
          pendingSessionId,
          amountMicros.toString(),
          challengeHash,
          nowMs
        );
      const updated: PendingTradingSession = {
        ...pending,
        status: "AUTHORIZED"
      };
      this.db
        .prepare(
          `UPDATE pending_trading_sessions
           SET status = ?, payload_json = ? WHERE id = ? AND status = 'PENDING'`
        )
        .run(updated.status, stringifyWithBigInts(updated), pendingSessionId);
      this.appendAudit("TRADING_SESSION_AUTHORIZED", pendingSessionId, {
        amountMicros,
        challengeHash,
        confirmedAtMs: nowMs
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  activateTradingSession(
    pendingSessionId: string,
    nowMs = Date.now()
  ): TradingSession | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pendingRow = this.db
        .prepare(
          `SELECT payload_json FROM pending_trading_sessions
           WHERE id = ? AND status = 'AUTHORIZED' AND expires_at_ms > ?`
        )
        .get(pendingSessionId, nowMs) as ProposalRow | undefined;
      const authorization = this.getSessionAuthorization(pendingSessionId);
      if (!pendingRow || !authorization || authorization.consumedAtMs !== null) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const pending = parseWithBigInts<PendingTradingSession>(pendingRow.payload_json);
      const active = this.db
        .prepare(
          `SELECT 1 FROM trading_sessions
           WHERE execution_mode = ? AND status = 'ACTIVE' AND expires_at_ms > ?
           LIMIT 1`
        )
        .get(pending.executionMode, nowMs);
      if (active) {
        this.db.exec("ROLLBACK");
        return null;
      }

      const session = createTradingSession({
        executionMode: pending.executionMode,
        authorizedBudgetMicros: authorization.amountMicros,
        ttlMs: pending.sessionTtlMs,
        nowMs
      });
      this.saveTradingSession(session);
      const updatedPending: PendingTradingSession = {
        ...pending,
        status: "ACTIVATED"
      };
      const pendingUpdate = this.db
        .prepare(
          `UPDATE pending_trading_sessions
           SET status = ?, payload_json = ?
           WHERE id = ? AND status = 'AUTHORIZED'`
        )
        .run(
          updatedPending.status,
          stringifyWithBigInts(updatedPending),
          pendingSessionId
        );
      const authorizationUpdate = this.db
        .prepare(
          `UPDATE session_authorizations
           SET consumed_at_ms = ?
           WHERE pending_session_id = ? AND consumed_at_ms IS NULL`
        )
        .run(nowMs, pendingSessionId);
      if (pendingUpdate.changes !== 1 || authorizationUpdate.changes !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.appendAudit("TRADING_SESSION_ACTIVATED", session.id, {
        pendingSessionId,
        amountMicros: session.authorizedBudgetMicros,
        activatedAtMs: nowMs
      });
      this.db.exec("COMMIT");
      return session;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getTradingSession(id: string): TradingSession | null {
    const row = this.db
      .prepare("SELECT payload_json FROM trading_sessions WHERE id = ?")
      .get(id) as ProposalRow | undefined;
    return row ? parseWithBigInts<TradingSession>(row.payload_json) : null;
  }

  getActiveTradingSession(executionMode: ExecutionMode, nowMs = Date.now()): TradingSession | null {
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM trading_sessions
         WHERE execution_mode = ? AND status = 'ACTIVE' AND expires_at_ms > ?
         ORDER BY created_at_ms DESC`
      )
      .all(executionMode, nowMs) as unknown as ProposalRow[];

    for (const row of rows) {
      const session = parseWithBigInts<TradingSession>(row.payload_json);
      if (session.remainingBudgetMicros > 0n) {
        return session;
      }
    }
    return null;
  }

  closeTradingSession(id: string, reason: string, nowMs = Date.now()): void {
    const session = this.getTradingSession(id);
    if (!session) return;
    const updated: TradingSession = {
      ...session,
      status: "CLOSED",
      closedReason: reason
    };
    this.saveTradingSession(updated);
    this.appendAudit("TRADING_SESSION_CLOSED", id, { reason, closedAtMs: nowMs });
  }

  savePositionRecord(position: PositionRecord, nowMs = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO position_records
          (token_id, condition_id, side, exit_state, updated_at_ms, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_id) DO UPDATE SET
           exit_state = excluded.exit_state,
           updated_at_ms = excluded.updated_at_ms,
           payload_json = excluded.payload_json`
      )
      .run(
        position.tokenId,
        position.conditionId,
        position.side,
        position.exitState,
        nowMs,
        stringifyWithBigInts(position)
      );
    this.appendAudit("POSITION_RECORD_SAVED", position.tokenId, {
      conditionId: position.conditionId,
      side: position.side,
      exitState: position.exitState
    });
  }

  saveResearchBundle(bundle: ResearchBundle): void {
    this.db
      .prepare(
        `INSERT INTO research_bundles
          (id, market_condition_id, token_id, created_at_ms, expires_at_ms, content_hash, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(
        bundle.id,
        bundle.marketConditionId,
        bundle.tokenId,
        bundle.createdAtMs,
        bundle.expiresAtMs,
        bundle.contentHash,
        stringifyWithBigInts(bundle)
      );
    this.appendAudit("RESEARCH_BUNDLE_VERIFIED", bundle.id, {
      marketConditionId: bundle.marketConditionId,
      tokenId: bundle.tokenId,
      contentHash: bundle.contentHash,
      sourceDomains: bundle.sources.map((source) => source.registrableDomain),
      expiresAtMs: bundle.expiresAtMs
    });
  }

  getResearchBundle(id: string): ResearchBundle | null {
    const row = this.db
      .prepare("SELECT payload_json FROM research_bundles WHERE id = ?")
      .get(id) as ProposalRow | undefined;
    return row ? parseWithBigInts<ResearchBundle>(row.payload_json) : null;
  }

  getLatestResearchBundle(
    marketConditionId: string,
    tokenId: string,
    nowMs = Date.now()
  ): ResearchBundle | null {
    const row = this.db
      .prepare(
        `SELECT payload_json FROM research_bundles
         WHERE market_condition_id = ? AND token_id = ? AND expires_at_ms > ?
         ORDER BY created_at_ms DESC LIMIT 1`
      )
      .get(marketConditionId, tokenId, nowMs) as ProposalRow | undefined;
    return row ? parseWithBigInts<ResearchBundle>(row.payload_json) : null;
  }

  getPositionRecord(tokenId: string): PositionRecord | null {
    const row = this.db
      .prepare("SELECT payload_json FROM position_records WHERE token_id = ?")
      .get(tokenId) as ProposalRow | undefined;
    return row
      ? normalizePositionRecord(parseWithBigInts<Record<string, unknown>>(row.payload_json))
      : null;
  }

  listPositionRecords(): PositionRecord[] {
    const rows = this.db
      .prepare("SELECT payload_json FROM position_records ORDER BY updated_at_ms DESC")
      .all() as unknown as ProposalRow[];
    return rows.map((row) =>
      normalizePositionRecord(parseWithBigInts<Record<string, unknown>>(row.payload_json))
    );
  }

  getReservedExitShares(tokenId: string, nowMs = Date.now()): bigint {
    const rows = this.db
      .prepare(
        `SELECT r.shares_micros, p.status, p.expires_at_ms
         FROM exit_reservations r
         JOIN proposals p ON p.id = r.proposal_id
         WHERE r.token_id = ?`
      )
      .all(tokenId) as Array<{
      shares_micros: string;
      status: string;
      expires_at_ms: number;
    }>;
    return rows.reduce(
      (total, row) =>
        isExitReservationActive(row.status, row.expires_at_ms, nowMs)
          ? total + BigInt(row.shares_micros)
          : total,
      0n
    );
  }

  claimAutonomousExecution(
    proposalId: string,
    proposalHash: string,
    sessionId: string | null,
    nowMs: number
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const proposal = this.getProposal(proposalId);
      if (
        !proposal ||
        proposal.hash !== proposalHash ||
        proposal.status !== "STAGED" ||
        proposal.expiresAtMs < nowMs ||
        !verifyProposalHash(proposal) ||
        proposal.executionMode !== "live" ||
        proposal.policyVersion !== RISK_POLICY_VERSION ||
        (proposal.intent === "EXIT" &&
          (proposal.side !== "SELL" || proposal.maxLossMicros !== 0n))
      ) {
        this.db.exec("ROLLBACK");
        return false;
      }

      if (proposal.intent === "EXIT") {
        const reservation = this.db
          .prepare(
            "SELECT shares_micros FROM exit_reservations WHERE proposal_id = ?"
          )
          .get(proposal.id) as { shares_micros: string } | undefined;
        if (
          reservation === undefined ||
          BigInt(reservation.shares_micros) !== proposal.sharesMicros
        ) {
          this.db.exec("ROLLBACK");
          return false;
        }
      }

      if (proposal.intent === "ENTRY") {
        if (proposal.sessionId === null || proposal.sessionId !== sessionId) {
          this.db.exec("ROLLBACK");
          return false;
        }
        const sessionRow = this.db
          .prepare("SELECT payload_json FROM trading_sessions WHERE id = ? AND status = 'ACTIVE'")
          .get(proposal.sessionId) as ProposalRow | undefined;
        if (!sessionRow) {
          this.db.exec("ROLLBACK");
          return false;
        }
        const session = parseWithBigInts<TradingSession>(sessionRow.payload_json);
        if (
          nowMs >= session.expiresAtMs ||
          session.executionMode !== "live" ||
          session.remainingBudgetMicros < proposal.maxLossMicros
        ) {
          this.db.exec("ROLLBACK");
          return false;
        }

        const newRemaining = session.remainingBudgetMicros - proposal.maxLossMicros;
        const newStatus = newRemaining === 0n ? "EXHAUSTED" : "ACTIVE";
        const updatedSession: TradingSession = {
          ...session,
          remainingBudgetMicros: newRemaining,
          status: newStatus
        };
        const sessionUpdate = this.db
          .prepare(
            `UPDATE trading_sessions
             SET status = ?, payload_json = ?
             WHERE id = ? AND status = 'ACTIVE'`
          )
          .run(newStatus, stringifyWithBigInts(updatedSession), proposal.sessionId);
        if (sessionUpdate.changes !== 1) {
          this.db.exec("ROLLBACK");
          return false;
        }
      }

      const transitioned = this.db
        .prepare(
          `UPDATE proposals
           SET status = 'EXECUTING',
               payload_json = ?,
               revision = revision + 1,
               updated_at_ms = ?
           WHERE id = ? AND hash = ? AND status = 'STAGED'`
        )
        .run(
          stringifyWithBigInts({ ...proposal, status: "EXECUTING" }),
          nowMs,
          proposalId,
          proposalHash
        );

      const execution = this.db
        .prepare(
          `INSERT OR IGNORE INTO executions
            (proposal_id, proposal_hash, clob_order_id, status, submitted_at_ms, response_json)
           VALUES (?, ?, NULL, 'CLAIMED', ?, '{}')`
        )
        .run(proposalId, proposalHash, nowMs);

      if (transitioned.changes !== 1 || execution.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }

      this.appendAudit("AUTONOMOUS_EXECUTION_CLAIMED", proposalId, {
        proposalHash,
        sessionId,
        claimedAtMs: nowMs
      });
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  countAuditEvents(eventType: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = ?")
      .get(eventType) as { count: number };
    return row.count;
  }

  listAuditEvents(): AuditEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at_ms, event_type, subject_id, payload_json,
                previous_hash, event_hash
         FROM audit_events ORDER BY id ASC`
      )
      .all() as Array<{
      id: number;
      created_at_ms: number;
      event_type: string;
      subject_id: string | null;
      payload_json: string;
      previous_hash: string;
      event_hash: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      createdAtMs: row.created_at_ms,
      eventType: row.event_type,
      subjectId: row.subject_id,
      payload: parseWithBigInts(row.payload_json),
      previousHash: row.previous_hash,
      eventHash: row.event_hash
    }));
  }

  appendAudit(eventType: string, subjectId: string | null, payload: unknown): string {
    const previous = this.db
      .prepare("SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1")
      .get() as { event_hash: string } | undefined;
    const createdAtMs = Date.now();
    const payloadJson = stringifyWithBigInts(payload);
    const previousHash = previous?.event_hash ?? "GENESIS";
    const eventHash = createHash("sha256")
      .update(
        stringifyWithBigInts({
          previousHash,
          eventType,
          subjectId,
          createdAtMs,
          payload
        })
      )
      .digest("hex");
    this.db
      .prepare(
        `INSERT INTO audit_events
          (created_at_ms, event_type, subject_id, payload_json, previous_hash, event_hash)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(createdAtMs, eventType, subjectId, payloadJson, previousHash, eventHash);
    return eventHash;
  }

  verifyAuditChain(): boolean {
    const rows = this.db
      .prepare(
        `SELECT created_at_ms, event_type, subject_id, payload_json, previous_hash, event_hash
         FROM audit_events ORDER BY id ASC`
      )
      .all() as Array<{
      created_at_ms: number;
      event_type: string;
      subject_id: string | null;
      payload_json: string;
      previous_hash: string;
      event_hash: string;
    }>;
    let previousHash = "GENESIS";
    for (const row of rows) {
      if (row.previous_hash !== previousHash) {
        return false;
      }
      const payload = parseWithBigInts(row.payload_json);
      const expected = createHash("sha256")
        .update(
          stringifyWithBigInts({
            previousHash,
            eventType: row.event_type,
            subjectId: row.subject_id,
            createdAtMs: row.created_at_ms,
            payload
          })
        )
        .digest("hex");
      if (expected !== row.event_hash) {
        return false;
      }
      previousHash = row.event_hash;
    }
    return true;
  }

  private expireInterruptedApprovals(nowMs: number): void {
    const interrupted = this.db
      .prepare(
        `SELECT id FROM proposals
         WHERE status IN ('AWAITING_LOCAL', 'LOCALLY_APPROVED', 'EXECUTING')`
      )
      .all() as Array<{ id: string }>;
    this.db
      .prepare(
        `UPDATE proposals
         SET status = 'EXPIRED',
             payload_json = json_set(payload_json, '$.status', 'EXPIRED'),
             revision = revision + 1,
             updated_at_ms = ?
         WHERE status IN ('AWAITING_LOCAL', 'LOCALLY_APPROVED', 'EXECUTING')`
      )
      .run(nowMs);
    for (const row of interrupted) {
      this.appendAudit("INTERRUPTED_APPROVAL_EXPIRED", row.id, { expiredAtMs: nowMs });
    }
  }

  private setState(key: string, value: string, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO system_state (key, value, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`
      )
      .run(key, value, nowMs);
  }

  private getState(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM system_state WHERE key = ?")
      .get(key) as StateRow | undefined;
    return row?.value ?? null;
  }

  private dailyRiskAccountFingerprint(): string | null {
    const binding = this.getAccountBinding();
    if (binding === null) {
      return null;
    }
    return createHash("sha256")
      .update(
        stringifyWithBigInts({
          profileAddress: binding.profileAddress,
          funderAddress: binding.funderAddress,
          signerAddress: binding.signerAddress,
          signatureType: binding.signatureType
        })
      )
      .digest("hex");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        proposal_id TEXT PRIMARY KEY REFERENCES proposals(id),
        proposal_hash TEXT NOT NULL,
        approved_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        nonce_hash TEXT NOT NULL,
        consumed_at_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS executions (
        proposal_id TEXT PRIMARY KEY REFERENCES proposals(id),
        proposal_hash TEXT NOT NULL UNIQUE,
        clob_order_id TEXT,
        status TEXT NOT NULL,
        submitted_at_ms INTEGER NOT NULL,
        response_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paper_trades (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL REFERENCES proposals(id),
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        opened_at_ms INTEGER NOT NULL,
        closed_at_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at_ms INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        subject_id TEXT,
        payload_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS trading_sessions (
        id TEXT PRIMARY KEY,
        execution_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_trading_sessions (
        id TEXT PRIMARY KEY,
        execution_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_authorizations (
        pending_session_id TEXT PRIMARY KEY REFERENCES pending_trading_sessions(id),
        amount_micros TEXT NOT NULL,
        challenge_hash TEXT NOT NULL,
        confirmed_at_ms INTEGER NOT NULL,
        consumed_at_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS position_records (
        token_id TEXT PRIMARY KEY,
        condition_id TEXT NOT NULL,
        side TEXT NOT NULL,
        exit_state TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS research_bundles (
        id TEXT PRIMARY KEY,
        market_condition_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS exit_reservations (
        proposal_id TEXT PRIMARY KEY REFERENCES proposals(id),
        token_id TEXT NOT NULL,
        shares_micros TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
      CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_events(subject_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_mode_status ON trading_sessions(execution_mode, status);
      CREATE INDEX IF NOT EXISTS idx_pending_sessions_mode_status
        ON pending_trading_sessions(execution_mode, status);
      CREATE INDEX IF NOT EXISTS idx_exit_reservations_token
        ON exit_reservations(token_id);
      CREATE INDEX IF NOT EXISTS idx_research_bundles_market
        ON research_bundles(market_condition_id, token_id, expires_at_ms);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_clob_order_id
        ON executions(clob_order_id)
        WHERE clob_order_id IS NOT NULL;
    `);
  }
}

function normalizePositionRecord(value: Record<string, unknown>): PositionRecord {
  const legacyLastProbabilityMicros = value.lastProbabilityMicros;
  const {
    lastProbabilityMicros: _legacyLastProbabilityMicros,
    ...withoutLegacyProbability
  } = value;
  const record = withoutLegacyProbability as Partial<PositionRecord>;
  return {
    ...(record as PositionRecord),
    entryProbabilityMicros: record.entryProbabilityMicros ?? null,
    entryEdgeMicros: record.entryEdgeMicros ?? null,
    lastMarketPriceMicros:
      record.lastMarketPriceMicros ??
      (typeof legacyLastProbabilityMicros === "bigint"
        ? legacyLastProbabilityMicros
        : 0n),
    lastEstimatedProbabilityMicros: record.lastEstimatedProbabilityMicros ?? null,
    lastResearchBundleId: record.lastResearchBundleId ?? null,
    activeExitProposalId: record.activeExitProposalId ?? null,
    activeExitOrderId: record.activeExitOrderId ?? null
  };
}

function normalizeAddress(value: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/u.test(value)) {
    throw new Error("Invalid EVM address.");
  }
  return value.toLowerCase();
}

function readRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid execution reconciliation record.");
  }
  return value as Record<string, unknown>;
}

function readRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error("Invalid execution reconciliation list.");
  }
  return value.map(readRecord);
}

function readStringArrayStrict(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid execution reconciliation string list.");
  }
  return value.map((entry) => readNonEmptyString(entry));
}

function readNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Invalid execution reconciliation value.");
  }
  return value;
}

function readMatchedSharesMicros(responseJson: string): bigint | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const order =
    record.order !== null &&
    typeof record.order === "object" &&
    !Array.isArray(record.order)
      ? (record.order as Record<string, unknown>)
      : record;
  const raw = order.sizeMatched ?? order.size_matched;
  if (raw === undefined) {
    return null;
  }
  return parseClobFixed6(raw, "EXIT_MATCHED_SIZE_INVALID");
}

function isExitReservationActive(
  status: string,
  expiresAtMs: number,
  nowMs: number
): boolean {
  if (!ACTIVE_EXIT_RESERVATION_STATUSES.has(status)) {
    return false;
  }
  return (
    status === "EXECUTING" ||
    status === "SUBMITTED" ||
    expiresAtMs >= nowMs
  );
}

function isAllowedExecutionTransition(
  currentValue: string,
  nextValue: string
): boolean {
  const current = currentValue.toUpperCase();
  const next = nextValue.toUpperCase();
  const terminal = new Set([
    "CANCELLED",
    "CANCELED",
    "EXPIRED",
    "CONFIRMED",
    "REJECTED"
  ]);
  const known = new Set([
    "SUBMITTED_UNRECONCILED",
    "LIVE",
    "PARTIALLY_FILLED",
    "CANCEL_REQUESTED",
    "RECONCILING",
    ...terminal
  ]);
  if (!known.has(current) || !known.has(next)) {
    return false;
  }
  if (terminal.has(current)) {
    return next === current;
  }
  if (current === "RECONCILING") {
    return next === "RECONCILING" || terminal.has(next);
  }
  if (current === "PARTIALLY_FILLED" && next === "LIVE") {
    return false;
  }
  return true;
}
