import {
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import type { OrderProposal } from "../domain/types.js";
import { verifyProposalHash } from "../domain/proposals.js";
import { TradingDatabase } from "../storage/database.js";

const TOKEN_BYTES = 32;
const HASH_SUFFIX_LENGTH = 6;
const DEFAULT_APPROVAL_TTL_MS = 90_000;

interface PendingApproval {
  proposalId: string;
  proposalHash: string;
  csrfHash: Buffer;
  nonceHash: Buffer;
  expiresAtMs: number;
  used: boolean;
}

export interface LocalApprovalChallenge {
  proposalId: string;
  proposalHash: string;
  csrfToken: string;
  nonce: string;
  requiredHashSuffix: string;
  expiresAtMs: number;
}

export interface LocalApprovalSubmission {
  proposalId: string;
  proposalHash: string;
  csrfToken: string;
  nonce: string;
  hashSuffix: string;
}

export interface LocalApprovalCoordinatorOptions {
  database: TradingDatabase;
  now?: () => number;
  approvalTtlMs?: number;
}

export class LocalApprovalError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Local approval rejected (${code}).`);
    this.name = "LocalApprovalError";
    this.code = code;
  }
}

/**
 * Owns only the in-memory challenge material. Raw CSRF and nonce values never
 * enter SQLite; a restart therefore invalidates every pending approval.
 */
export class LocalApprovalCoordinator {
  private readonly database: TradingDatabase;
  private readonly now: () => number;
  private readonly approvalTtlMs: number;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(options: LocalApprovalCoordinatorOptions) {
    this.database = options.database;
    this.now = options.now ?? Date.now;
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (!Number.isSafeInteger(this.approvalTtlMs) || this.approvalTtlMs <= 0) {
      throw new LocalApprovalError("INVALID_TTL");
    }
  }

  begin(proposalId: string, proposalHash: string): LocalApprovalChallenge {
    const nowMs = this.now();
    const proposal = this.database.getProposal(proposalId);
    validateStagedProposal(proposal, proposalHash, nowMs);
    if (this.pending.has(proposalId)) {
      throw new LocalApprovalError("APPROVAL_ALREADY_PENDING");
    }

    const transitioned = this.database.transitionProposal(
      proposalId,
      "STAGED",
      "AWAITING_LOCAL",
      nowMs
    );
    if (transitioned === null) {
      throw new LocalApprovalError("PROPOSAL_STATE_CONFLICT");
    }

    const csrfToken = randomBytes(TOKEN_BYTES).toString("base64url");
    const nonce = randomBytes(TOKEN_BYTES).toString("base64url");
    const expiresAtMs = Math.min(
      proposal!.expiresAtMs,
      nowMs + this.approvalTtlMs
    );
    this.pending.set(proposalId, {
      proposalId,
      proposalHash,
      csrfHash: digestToken(csrfToken),
      nonceHash: digestToken(nonce),
      expiresAtMs,
      used: false
    });

    return {
      proposalId,
      proposalHash,
      csrfToken,
      nonce,
      requiredHashSuffix: proposalHash.slice(-HASH_SUFFIX_LENGTH),
      expiresAtMs
    };
  }

  approve(submission: LocalApprovalSubmission): OrderProposal {
    const nowMs = this.now();
    const pending = this.requirePending(submission.proposalId);
    this.validateSubmission(pending, submission, nowMs);

    // Consume in memory before any persistence. Every failure after this point
    // is fail-closed and requires staging a new proposal.
    pending.used = true;
    const proposal = this.database.getProposal(submission.proposalId);
    if (
      proposal === null ||
      proposal.status !== "AWAITING_LOCAL" ||
      proposal.hash !== pending.proposalHash ||
      proposal.expiresAtMs < nowMs ||
      !verifyOriginalProposalHash(proposal)
    ) {
      this.pending.delete(submission.proposalId);
      throw new LocalApprovalError("PROPOSAL_CHANGED_OR_EXPIRED");
    }

    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      const transitioned = this.database.transitionProposal(
        proposal.id,
        "AWAITING_LOCAL",
        "LOCALLY_APPROVED",
        nowMs
      );
      if (transitioned === null) {
        throw new LocalApprovalError("PROPOSAL_STATE_CONFLICT");
      }
      this.database.recordLocalApproval({
        proposalId: proposal.id,
        proposalHash: proposal.hash,
        approvedAtMs: nowMs,
        expiresAtMs: pending.expiresAtMs,
        nonceHash: pending.nonceHash.toString("hex"),
        consumedAtMs: null
      });
      this.database.db.exec("COMMIT");
      this.pending.delete(submission.proposalId);
      pending.csrfHash.fill(0);
      pending.nonceHash.fill(0);
      return transitioned;
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      this.pending.delete(submission.proposalId);
      pending.csrfHash.fill(0);
      pending.nonceHash.fill(0);
      throw error;
    }
  }

  reject(submission: LocalApprovalSubmission): OrderProposal {
    const nowMs = this.now();
    const pending = this.requirePending(submission.proposalId);
    this.validateSubmission(pending, submission, nowMs);
    pending.used = true;

    const rejected = this.database.transitionProposal(
      submission.proposalId,
      "AWAITING_LOCAL",
      "REJECTED",
      nowMs
    );
    this.pending.delete(submission.proposalId);
    pending.csrfHash.fill(0);
    pending.nonceHash.fill(0);
    if (rejected === null) {
      throw new LocalApprovalError("PROPOSAL_STATE_CONFLICT");
    }
    return rejected;
  }

  sweepExpired(): number {
    const nowMs = this.now();
    let count = 0;
    for (const [proposalId, pending] of this.pending) {
      if (pending.expiresAtMs < nowMs) {
        pending.used = true;
        this.database.transitionProposal(
          proposalId,
          "AWAITING_LOCAL",
          "EXPIRED",
          nowMs
        );
        pending.csrfHash.fill(0);
        pending.nonceHash.fill(0);
        this.pending.delete(proposalId);
        count += 1;
      }
    }
    return count;
  }

  private requirePending(proposalId: string): PendingApproval {
    const pending = this.pending.get(proposalId);
    if (pending === undefined || pending.used) {
      throw new LocalApprovalError("APPROVAL_NOT_PENDING");
    }
    return pending;
  }

  private validateSubmission(
    pending: PendingApproval,
    submission: LocalApprovalSubmission,
    nowMs: number
  ): void {
    if (pending.expiresAtMs < nowMs) {
      this.sweepExpired();
      throw new LocalApprovalError("APPROVAL_EXPIRED");
    }
    if (
      submission.proposalHash !== pending.proposalHash ||
      submission.hashSuffix.toLowerCase() !==
        pending.proposalHash.slice(-HASH_SUFFIX_LENGTH).toLowerCase()
    ) {
      throw new LocalApprovalError("HASH_MISMATCH");
    }
    if (
      !tokenMatches(submission.csrfToken, pending.csrfHash) ||
      !tokenMatches(submission.nonce, pending.nonceHash)
    ) {
      throw new LocalApprovalError("CHALLENGE_MISMATCH");
    }
  }
}

function validateStagedProposal(
  proposal: OrderProposal | null,
  expectedHash: string,
  nowMs: number
): asserts proposal is OrderProposal {
  if (proposal === null) {
    throw new LocalApprovalError("PROPOSAL_NOT_FOUND");
  }
  if (
    proposal.status !== "STAGED" ||
    proposal.hash !== expectedHash ||
    !verifyProposalHash(proposal)
  ) {
    throw new LocalApprovalError("PROPOSAL_HASH_OR_STATE_MISMATCH");
  }
  if (proposal.expiresAtMs < nowMs) {
    throw new LocalApprovalError("PROPOSAL_EXPIRED");
  }
}

function verifyOriginalProposalHash(proposal: OrderProposal): boolean {
  return verifyProposalHash({ ...proposal, status: "STAGED" });
}

function digestToken(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function tokenMatches(value: string, expectedDigest: Buffer): boolean {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 128
  ) {
    return false;
  }
  const actual = digestToken(value);
  try {
    return timingSafeEqual(actual, expectedDigest);
  } finally {
    actual.fill(0);
  }
}
