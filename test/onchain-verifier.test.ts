import {
  Chain,
  getContractConfig
} from "@polymarket/clob-client-v2";
import { describe, expect, it } from "vitest";
import { createOrderProposal } from "../src/domain/proposals.js";
import {
  ONCHAIN_ORDER_FILLED_TOPIC,
  PolygonReceiptVerifier
} from "../src/polymarket/onchain-verifier.js";
import { intentFixture, riskContextFixture } from "./fixtures.js";

const NOW_MS = 1_800_000_000_000;
const ORDER_ID = `0x${"1".repeat(64)}`;
const TX_HASH = `0x${"2".repeat(64)}`;
const BLOCK_HASH = `0x${"3".repeat(64)}`;
const MAKER = `0x${"a".repeat(40)}`;
const EXCHANGE = getContractConfig(Chain.POLYGON).exchangeV2.toLowerCase();
const EXPIRATION = Math.floor(NOW_MS / 1_000) + 16 * 60;

describe("PolygonReceiptVerifier", () => {
  it("verifies finalized canonical V2 evidence from two independent RPCs", async () => {
    const proposal = liveProposal();
    const verifier = receiptVerifier(
      receipt(proposal, [
        0n,
        BigInt(proposal.market.tokenId),
        proposal.maxCostMicros,
        proposal.sharesMicros,
        0n,
        0n,
        BigInt(`0x${proposal.hash}`)
      ])
    );

    await expect(
      verifier.verifySettlement({
        proposal,
        orderId: ORDER_ID,
        makerAddress: MAKER,
        sizeMatchedMicros: proposal.sharesMicros,
        expirationEpochSeconds: EXPIRATION,
        transactions: [
          {
            transactionHash: TX_HASH,
            role: "TAKER",
            sharesMicros: proposal.sharesMicros,
            matchTimeMs: NOW_MS
          }
        ]
      })
    ).resolves.toMatchObject({
      finalized: true,
      filledSharesMicros: proposal.sharesMicros,
      grossCostMicros: proposal.maxCostMicros,
      feeMicros: 0n,
      transactionHashes: [TX_HASH],
      blockHashes: [BLOCK_HASH]
    });
  });

  it("keeps canonical evidence pending until both providers report finality", async () => {
    const proposal = liveProposal();
    const verifier = receiptVerifier(
      receipt(proposal, validWords(proposal)),
      { finalizedNumber: "0x70" }
    );

    await expect(
      verifier.verifySettlement(verificationInput(proposal))
    ).resolves.toMatchObject({ finalized: false });
  });

  it("rejects a receipt whose aggregate on-chain fill differs from CLOB", async () => {
    const proposal = liveProposal();
    const shares = proposal.sharesMicros - 1n;
    const verifier = receiptVerifier(
      receipt(proposal, [
        0n,
        BigInt(proposal.market.tokenId),
        (shares * proposal.limitPriceMicros) / 1_000_000n,
        shares,
        0n,
        0n,
        BigInt(`0x${proposal.hash}`)
      ])
    );

    await expect(
      verifier.verifySettlement({
        ...verificationInput(proposal),
        transactions: [
          {
            transactionHash: TX_HASH,
            role: "TAKER",
            sharesMicros: shares,
            matchTimeMs: NOW_MS
          }
        ]
      })
    ).rejects.toThrow("ONCHAIN_FILL_SIZE_MISMATCH");
  });

  it("rejects divergent canonical block evidence", async () => {
    const proposal = liveProposal();
    const verifier = receiptVerifier(
      receipt(proposal, validWords(proposal)),
      { divergeSecondProvider: true }
    );
    await expect(
      verifier.verifySettlement(verificationInput(proposal))
    ).rejects.toThrow("POLYGON_RPC_QUORUM_DIVERGENCE");
  });

  it("rejects a settlement mined after the posted GTD expiration", async () => {
    const proposal = liveProposal();
    const verifier = receiptVerifier(
      receipt(proposal, validWords(proposal)),
      { blockTimestamp: EXPIRATION + 1 }
    );
    await expect(
      verifier.verifySettlement(verificationInput(proposal))
    ).rejects.toThrow("ONCHAIN_FILL_AFTER_GTD_EXPIRATION");
  });
});

function liveProposal() {
  const intent = intentFixture(NOW_MS);
  intent.executionMode = "live";
  return createOrderProposal(intent, riskContextFixture(NOW_MS));
}

function validWords(proposal: ReturnType<typeof liveProposal>): bigint[] {
  return [
    0n,
    BigInt(proposal.market.tokenId),
    proposal.maxCostMicros,
    proposal.sharesMicros,
    0n,
    0n,
    BigInt(`0x${proposal.hash}`)
  ];
}

function verificationInput(proposal: ReturnType<typeof liveProposal>) {
  return {
    proposal,
    orderId: ORDER_ID,
    makerAddress: MAKER,
    sizeMatchedMicros: proposal.sharesMicros,
    expirationEpochSeconds: EXPIRATION,
    transactions: [
      {
        transactionHash: TX_HASH,
        role: "TAKER" as const,
        sharesMicros: proposal.sharesMicros,
        matchTimeMs: NOW_MS
      }
    ]
  };
}

function receiptVerifier(
  receiptResult: Record<string, unknown>,
  options: {
    finalizedNumber?: string;
    blockTimestamp?: number;
    divergeSecondProvider?: boolean;
  } = {}
): PolygonReceiptVerifier {
  const urls = [
    "https://polygon-rpc-one.test/",
    "https://polygon-rpc-two.test/"
  ];
  return new PolygonReceiptVerifier({
    rpcUrls: urls,
    fetch: async (input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: unknown[];
      };
      const providerIndex = urls.indexOf(String(input));
      let result: unknown;
      if (request.method === "eth_chainId") {
        result = "0x89";
      } else if (
        request.method === "eth_getTransactionReceipt"
      ) {
        result =
          options.divergeSecondProvider && providerIndex === 1
            ? {
                ...receiptResult,
                blockHash: `0x${"4".repeat(64)}`
              }
            : receiptResult;
      } else if (
        request.method === "eth_getBlockByNumber" &&
        request.params[0] === "finalized"
      ) {
        result = block(
          options.finalizedNumber ?? "0x100",
          `0x${"f".repeat(64)}`,
          options.blockTimestamp ?? Math.floor(NOW_MS / 1_000)
        );
      } else {
        const hash =
          options.divergeSecondProvider && providerIndex === 1
            ? `0x${"4".repeat(64)}`
            : BLOCK_HASH;
        result = block(
          "0x80",
          hash,
          options.blockTimestamp ?? Math.floor(NOW_MS / 1_000)
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });
}

function receipt(
  _proposal: ReturnType<typeof liveProposal>,
  words: bigint[]
): Record<string, unknown> {
  return {
    transactionHash: TX_HASH,
    to: EXCHANGE,
    status: "0x1",
    blockNumber: "0x80",
    blockHash: BLOCK_HASH,
    logs: [
      {
        address: EXCHANGE,
        removed: false,
        topics: [
          ONCHAIN_ORDER_FILLED_TOPIC,
          ORDER_ID,
          addressTopic(MAKER),
          addressTopic(EXCHANGE)
        ],
        data: `0x${words.map(word).join("")}`
      }
    ]
  };
}

function block(number: string, hash: string, timestamp: number) {
  return {
    number,
    hash,
    timestamp: `0x${timestamp.toString(16)}`
  };
}

function addressTopic(address: string): string {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}
