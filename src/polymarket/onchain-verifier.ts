import {
  Chain,
  getContractConfig
} from "@polymarket/clob-client-v2";
import { keccak256, stringToHex } from "viem";
import type {
  OnchainSettlementPort,
  OnchainSettlementResult
} from "../application/ports.js";
import type { OrderProposal } from "../domain/types.js";
import { SafeExternalServiceError } from "./safe-error.js";

const ORDER_FILLED_TOPIC = keccak256(
  stringToHex(
    "OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)"
  )
).toLowerCase();
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const REQUEST_TIMEOUT_MS = 4_000;

type JsonRecord = Record<string, unknown>;
type FillRole = "TAKER" | "MAKER";

interface ExpectedTransaction {
  transactionHash: string;
  role: FillRole;
  sharesMicros: bigint;
  matchTimeMs: number;
}

interface ProviderTransactionProof {
  transactionHash: string;
  blockNumber: bigint;
  blockHash: string;
  blockTimestampMs: number;
  matchingLogs: JsonRecord[];
  finalized: boolean;
}

export interface PolygonReceiptVerifierOptions {
  rpcUrls: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Verifies V2 settlement against independent Polygon RPC providers. Live
 * configuration must supply at least two distinct HTTPS origins; a single
 * endpoint is not treated as independent evidence.
 */
export class PolygonReceiptVerifier implements OnchainSettlementPort {
  private readonly rpcUrls: string[];
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private requestId = 0;

  constructor(options: PolygonReceiptVerifierOptions) {
    this.rpcUrls = normalizeRpcUrls(options.rpcUrls);
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 30_000
    ) {
      throw new Error("Invalid Polygon receipt-verifier configuration.");
    }
  }

  async verifySettlement(input: {
    proposal: OrderProposal;
    orderId: string;
    makerAddress: string;
    sizeMatchedMicros: bigint;
    expirationEpochSeconds: number;
    transactions: Array<{
      transactionHash: string;
      role: FillRole;
      sharesMicros: bigint;
      matchTimeMs: number;
    }>;
  }): Promise<OnchainSettlementResult> {
    if (this.rpcUrls.length < 2) {
      throw new Error("POLYGON_RPC_QUORUM_UNAVAILABLE");
    }
    const orderId = normalizeBytes32(input.orderId, "ONCHAIN_ORDER_ID_INVALID");
    const makerAddress = normalizeAddress(
      input.makerAddress,
      "ONCHAIN_MAKER_INVALID"
    );
    if (
      !Number.isSafeInteger(input.expirationEpochSeconds) ||
      input.expirationEpochSeconds <= 0 ||
      input.sizeMatchedMicros <= 0n ||
      input.sizeMatchedMicros > input.proposal.sharesMicros
    ) {
      throw new Error("ONCHAIN_SETTLEMENT_BOUNDS_INVALID");
    }
    const expectedTransactions = groupExpectedTransactions(input.transactions);
    if (expectedTransactions.length === 0) {
      throw new Error("ONCHAIN_TRANSACTION_SET_INVALID");
    }
    if (
      expectedTransactions.some(
        (transaction) =>
          transaction.matchTimeMs > input.expirationEpochSeconds * 1_000
      )
    ) {
      throw new Error("ONCHAIN_MATCH_AFTER_GTD_EXPIRATION");
    }

    const contracts = getContractConfig(Chain.POLYGON);
    const exchangeAddress = normalizeAddress(
      input.proposal.market.negRisk
        ? contracts.negRiskExchangeV2
        : contracts.exchangeV2,
      "ONCHAIN_EXCHANGE_INVALID"
    );

    const providerProofs = await Promise.all(
      this.rpcUrls.map((rpcUrl) =>
        this.fetchProviderProofs(
          rpcUrl,
          expectedTransactions,
          orderId,
          exchangeAddress
        )
      )
    );
    const receiptPresence = providerProofs.map((proofs) => proofs !== null);
    if (receiptPresence.some((present) => present !== receiptPresence[0])) {
      throw new Error("POLYGON_RPC_QUORUM_DIVERGENCE");
    }
    if (providerProofs[0] === null) {
      return emptyPendingResult(expectedTransactions);
    }
    const completeProofs = providerProofs as ProviderTransactionProof[][];
    const canonical = canonicalProofMaterial(completeProofs[0]!);
    if (
      completeProofs
        .slice(1)
        .some((proofs) => canonicalProofMaterial(proofs) !== canonical)
    ) {
      throw new Error("POLYGON_RPC_QUORUM_DIVERGENCE");
    }

    const proofs = completeProofs[0]!;
    let filledSharesMicros = 0n;
    let grossCostMicros = 0n;
    let feeMicros = 0n;
    for (const expected of expectedTransactions) {
      const proof = proofs.find(
        (candidate) =>
          candidate.transactionHash === expected.transactionHash
      );
      if (proof === undefined || proof.matchingLogs.length === 0) {
        throw new Error("ONCHAIN_ORDER_FILL_LOG_MISSING");
      }
      let transactionShares = 0n;
      for (const log of proof.matchingLogs) {
        const topics = requireStringArray(
          log.topics,
          "ONCHAIN_RECEIPT_TOPICS_INVALID"
        ).map((topic) => topic.toLowerCase());
        if (log.removed === true || topics.length !== 4) {
          throw new Error("ONCHAIN_ORDER_FILL_LOG_INVALID");
        }
        const logMaker = topicAddress(
          topics[2],
          "ONCHAIN_ORDER_FILL_MAKER_INVALID"
        );
        const logTaker = topicAddress(
          topics[3],
          "ONCHAIN_ORDER_FILL_TAKER_INVALID"
        );
        if (logMaker !== makerAddress) {
          throw new Error("ONCHAIN_ORDER_FILL_MAKER_MISMATCH");
        }
        const actualRole: FillRole =
          logTaker === exchangeAddress ? "TAKER" : "MAKER";
        if (actualRole !== expected.role) {
          throw new Error("ONCHAIN_ORDER_FILL_ROLE_MISMATCH");
        }

        const words = decodeEventWords(
          log.data,
          7,
          "ONCHAIN_ORDER_FILL_DATA_INVALID"
        );
        const side = words[0]!;
        const tokenId = words[1]!;
        const makerAmount = words[2]!;
        const takerAmount = words[3]!;
        const fee = words[4]!;
        const builder = wordToBytes32(words[5]!);
        const metadata = wordToBytes32(words[6]!);
        const expectedSide = input.proposal.side === "BUY" ? 0n : 1n;
        if (
          side !== expectedSide ||
          tokenId !== BigInt(input.proposal.market.tokenId) ||
          makerAmount <= 0n ||
          takerAmount <= 0n ||
          builder !== ZERO_BYTES32 ||
          metadata !== `0x${input.proposal.hash}`.toLowerCase() ||
          (input.proposal.market.feesTakerOnly === true &&
            actualRole === "MAKER" &&
            fee !== 0n)
        ) {
          throw new Error("ONCHAIN_ORDER_FILL_MISMATCH");
        }
        const shares =
          input.proposal.side === "BUY" ? takerAmount : makerAmount;
        const grossCost =
          input.proposal.side === "BUY" ? makerAmount : takerAmount;
        if (
          (input.proposal.side === "BUY" &&
            grossCost * 1_000_000n >
              shares * input.proposal.limitPriceMicros) ||
          (input.proposal.side === "SELL" &&
            grossCost * 1_000_000n <
              shares * input.proposal.limitPriceMicros)
        ) {
          throw new Error("ONCHAIN_FILL_PRICE_OUTSIDE_LIMIT");
        }
        transactionShares += shares;
        filledSharesMicros += shares;
        grossCostMicros += grossCost;
        feeMicros += fee;
      }
      if (transactionShares !== expected.sharesMicros) {
        throw new Error("ONCHAIN_TRANSACTION_FILL_SIZE_MISMATCH");
      }
    }

    if (
      filledSharesMicros !== input.sizeMatchedMicros ||
      filledSharesMicros > input.proposal.sharesMicros
    ) {
      throw new Error("ONCHAIN_FILL_SIZE_MISMATCH");
    }
    if (feeMicros > input.proposal.estimatedFeeMicros) {
      throw new Error("ONCHAIN_FEE_EXCEEDS_APPROVAL");
    }
    if (
      input.proposal.side === "BUY" &&
      (grossCostMicros > input.proposal.maxCostMicros ||
        grossCostMicros + feeMicros > input.proposal.maxLossMicros)
    ) {
      throw new Error("ONCHAIN_BUY_COST_EXCEEDS_APPROVAL");
    }

    if (
      proofs.some(
        (proof) => proof.blockTimestampMs > input.expirationEpochSeconds * 1_000
      )
    ) {
      throw new Error("ONCHAIN_FILL_AFTER_GTD_EXPIRATION");
    }

    return {
      finalized: completeProofs.every((provider) =>
        provider.every((proof) => proof.finalized)
      ),
      filledSharesMicros,
      grossCostMicros,
      feeMicros,
      transactionHashes: proofs.map((proof) => proof.transactionHash),
      blockNumbers: proofs.map((proof) => proof.blockNumber),
      blockHashes: proofs.map((proof) => proof.blockHash),
      blockTimestampsMs: proofs.map((proof) => proof.blockTimestampMs)
    };
  }

  private async fetchProviderProofs(
    rpcUrl: string,
    expectedTransactions: ExpectedTransaction[],
    orderId: string,
    exchangeAddress: string
  ): Promise<ProviderTransactionProof[] | null> {
    const [chainIdValue, finalizedValue, receiptValues] = await Promise.all([
      this.rpc(rpcUrl, "eth_chainId", []),
      this.rpc(rpcUrl, "eth_getBlockByNumber", ["finalized", false]),
      Promise.all(
        expectedTransactions.map((transaction) =>
          this.rpc(rpcUrl, "eth_getTransactionReceipt", [
            transaction.transactionHash
          ])
        )
      )
    ]);
    if (parseRpcQuantity(chainIdValue, "ONCHAIN_CHAIN_ID_INVALID") !== 137n) {
      throw new Error("ONCHAIN_CHAIN_ID_MISMATCH");
    }
    const finalizedBlock = requireCanonicalBlock(
      finalizedValue,
      "ONCHAIN_FINALIZED_BLOCK_INVALID"
    );
    if (receiptValues.every((receipt) => receipt === null)) {
      return null;
    }
    if (receiptValues.some((receipt) => receipt === null)) {
      throw new Error("POLYGON_RPC_PARTIAL_RECEIPT_SET");
    }

    return Promise.all(
      receiptValues.map(async (receiptValue, index) => {
        const expected = expectedTransactions[index]!;
        const receipt = requireRecord(
          receiptValue,
          "ONCHAIN_RECEIPT_INVALID"
        );
        const transactionHash = normalizeBytes32(
          receipt.transactionHash,
          "ONCHAIN_RECEIPT_HASH_INVALID"
        );
        const blockHash = normalizeBytes32(
          receipt.blockHash,
          "ONCHAIN_RECEIPT_BLOCK_HASH_INVALID"
        );
        const blockNumber = parseRpcQuantity(
          receipt.blockNumber,
          "ONCHAIN_RECEIPT_BLOCK_INVALID"
        );
        if (
          transactionHash !== expected.transactionHash ||
          normalizeAddress(receipt.to, "ONCHAIN_RECEIPT_TARGET_INVALID") !==
            exchangeAddress ||
          parseRpcQuantity(
            receipt.status,
            "ONCHAIN_RECEIPT_STATUS_INVALID"
          ) !== 1n
        ) {
          throw new Error("ONCHAIN_RECEIPT_MISMATCH");
        }

        const [byHashValue, canonicalAtHeightValue] = await Promise.all([
          this.rpc(rpcUrl, "eth_getBlockByHash", [blockHash, false]),
          this.rpc(rpcUrl, "eth_getBlockByNumber", [
            toRpcQuantity(blockNumber),
            false
          ])
        ]);
        const byHash = requireCanonicalBlock(
          byHashValue,
          "ONCHAIN_BLOCK_BY_HASH_INVALID"
        );
        const canonicalAtHeight = requireCanonicalBlock(
          canonicalAtHeightValue,
          "ONCHAIN_CANONICAL_BLOCK_INVALID"
        );
        if (
          byHash.hash !== blockHash ||
          byHash.number !== blockNumber ||
          canonicalAtHeight.hash !== blockHash ||
          canonicalAtHeight.number !== blockNumber ||
          canonicalAtHeight.timestamp !== byHash.timestamp
        ) {
          throw new Error("ONCHAIN_BLOCK_NOT_CANONICAL");
        }

        const matchingLogs = requireArray(
          receipt.logs,
          "ONCHAIN_RECEIPT_LOGS_INVALID"
        )
          .map((value) =>
            requireRecord(value, "ONCHAIN_RECEIPT_LOG_INVALID")
          )
          .filter((log) => {
            const topics = requireStringArray(
              log.topics,
              "ONCHAIN_RECEIPT_TOPICS_INVALID"
            ).map((topic) => topic.toLowerCase());
            return (
              normalizeOptionalAddress(log.address) === exchangeAddress &&
              topics[0] === ORDER_FILLED_TOPIC &&
              topics[1] === orderId
            );
          });
        return {
          transactionHash,
          blockNumber,
          blockHash,
          blockTimestampMs: quantitySecondsToMs(byHash.timestamp),
          matchingLogs,
          finalized: blockNumber <= finalizedBlock.number
        };
      })
    );
  }

  private async rpc(
    rpcUrl: string,
    method: string,
    params: unknown[]
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    try {
      this.requestId += 1;
      const requestId = this.requestId;
      const response = await this.fetchFn(rpcUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method,
          params
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error("POLYGON_RPC_HTTP_ERROR");
      }
      const payload = requireRecord(
        await response.json(),
        "POLYGON_RPC_RESPONSE_INVALID"
      );
      if (
        payload.jsonrpc !== "2.0" ||
        payload.id !== requestId ||
        "error" in payload ||
        !("result" in payload)
      ) {
        throw new Error("POLYGON_RPC_RESPONSE_INVALID");
      }
      return payload.result;
    } catch (error) {
      if (
        error instanceof Error &&
        /^[A-Z][A-Z0-9_]+$/u.test(error.message)
      ) {
        throw error;
      }
      throw new SafeExternalServiceError(
        "Polygon receipt verification failed.",
        {
          code: "POLYGON_RPC_ERROR",
          service: "polygon-rpc",
          retryable: false
        }
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function groupExpectedTransactions(
  values: Array<{
    transactionHash: string;
    role: FillRole;
    sharesMicros: bigint;
    matchTimeMs: number;
  }>
): ExpectedTransaction[] {
  if (values.length === 0 || values.length > 100) {
    throw new Error("ONCHAIN_TRANSACTION_SET_INVALID");
  }
  const grouped = new Map<string, ExpectedTransaction>();
  for (const value of values) {
    const transactionHash = normalizeBytes32(
      value.transactionHash,
      "ONCHAIN_TRANSACTION_HASH_INVALID"
    );
    if (
      value.sharesMicros <= 0n ||
      !Number.isSafeInteger(value.matchTimeMs) ||
      value.matchTimeMs <= 0
    ) {
      throw new Error("ONCHAIN_TRANSACTION_SET_INVALID");
    }
    const existing = grouped.get(transactionHash);
    if (existing !== undefined) {
      if (existing.role !== value.role) {
        throw new Error("ONCHAIN_TRANSACTION_ROLE_CONFLICT");
      }
      existing.sharesMicros += value.sharesMicros;
      existing.matchTimeMs = Math.max(
        existing.matchTimeMs,
        value.matchTimeMs
      );
    } else {
      grouped.set(transactionHash, {
        transactionHash,
        role: value.role,
        sharesMicros: value.sharesMicros,
        matchTimeMs: value.matchTimeMs
      });
    }
  }
  return [...grouped.values()];
}

function emptyPendingResult(
  transactions: ExpectedTransaction[]
): OnchainSettlementResult {
  return {
    finalized: false,
    filledSharesMicros: 0n,
    grossCostMicros: 0n,
    feeMicros: 0n,
    transactionHashes: transactions.map(
      (transaction) => transaction.transactionHash
    ),
    blockNumbers: [],
    blockHashes: [],
    blockTimestampsMs: []
  };
}

function canonicalProofMaterial(
  proofs: ProviderTransactionProof[]
): string {
  return JSON.stringify(
    proofs.map((proof) => ({
      transactionHash: proof.transactionHash,
      blockNumber: proof.blockNumber.toString(),
      blockHash: proof.blockHash,
      blockTimestampMs: proof.blockTimestampMs,
      matchingLogs: proof.matchingLogs.map((log) => ({
        address: normalizeOptionalAddress(log.address),
        topics: requireStringArray(
          log.topics,
          "ONCHAIN_RECEIPT_TOPICS_INVALID"
        ).map((topic) => topic.toLowerCase()),
        data:
          typeof log.data === "string"
            ? log.data.toLowerCase()
            : null,
        removed: log.removed === true
      }))
    }))
  );
}

function requireCanonicalBlock(
  value: unknown,
  code: string
): {
  number: bigint;
  hash: string;
  timestamp: bigint;
} {
  const block = requireRecord(value, code);
  return {
    number: parseRpcQuantity(block.number, code),
    hash: normalizeBytes32(block.hash, code),
    timestamp: parseRpcQuantity(block.timestamp, code)
  };
}

function normalizeRpcUrls(values: readonly string[]): string[] {
  const normalized: string[] = [];
  const origins = new Set<string>();
  for (const value of values) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error("Polygon RPC URLs must be credential-free HTTPS URLs.");
    }
    const serialized = url.toString();
    if (normalized.includes(serialized) || origins.has(url.origin)) {
      throw new Error("Polygon RPC providers must use distinct HTTPS origins.");
    }
    normalized.push(serialized);
    origins.add(url.origin);
  }
  return normalized;
}

function normalizeBytes32(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/u.test(value)) {
    throw new Error(code);
  }
  return value.toLowerCase();
}

function normalizeAddress(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/u.test(value)) {
    throw new Error(code);
  }
  return value.toLowerCase();
}

function normalizeOptionalAddress(value: unknown): string | null {
  try {
    return normalizeAddress(value, "ONCHAIN_LOG_ADDRESS_INVALID");
  } catch {
    return null;
  }
}

function topicAddress(value: unknown, code: string): string {
  const topic = normalizeBytes32(value, code);
  if (!/^0x0{24}[a-f0-9]{40}$/u.test(topic)) {
    throw new Error(code);
  }
  return `0x${topic.slice(-40)}`;
}

function parseRpcQuantity(value: unknown, code: string): bigint {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-fA-F][a-fA-F0-9]*)$/u.test(value)
  ) {
    throw new Error(code);
  }
  return BigInt(value);
}

function toRpcQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function quantitySecondsToMs(value: bigint): number {
  const milliseconds = value * 1_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("ONCHAIN_BLOCK_TIMESTAMP_INVALID");
  }
  return Number(milliseconds);
}

function wordToBytes32(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function decodeEventWords(
  value: unknown,
  count: number,
  code: string
): bigint[] {
  if (
    typeof value !== "string" ||
    !new RegExp(`^0x[a-fA-F0-9]{${count * 64}}$`, "u").test(value)
  ) {
    throw new Error(code);
  }
  const words: bigint[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = 2 + index * 64;
    words.push(BigInt(`0x${value.slice(start, start + 64)}`));
  }
  return words;
}

function requireRecord(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as JsonRecord;
}

function requireArray(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

function requireStringArray(value: unknown, code: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new Error(code);
  }
  return value as string[];
}

export const ONCHAIN_ORDER_FILLED_TOPIC = ORDER_FILLED_TOPIC;
