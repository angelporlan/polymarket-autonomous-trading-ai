import {
  bytesToHex,
  getAddress,
  hashTypedData,
  isAddress,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { KeychainPort } from "./keychain.js";

const CHAIN_ID = 137n;
const DEFAULT_BEFORE_SIGN_TIMEOUT_MS = 4_000;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const CLOB_AUTH_MESSAGE = "This message attests that I control the given wallet";
const ORDER_TYPE = [
  ["salt", "uint256"],
  ["maker", "address"],
  ["signer", "address"],
  ["tokenId", "uint256"],
  ["makerAmount", "uint256"],
  ["takerAmount", "uint256"],
  ["side", "uint8"],
  ["signatureType", "uint8"],
  ["timestamp", "uint256"],
  ["metadata", "bytes32"],
  ["builder", "bytes32"]
] as const;
const CLOB_AUTH_TYPE = [
  ["address", "address"],
  ["timestamp", "string"],
  ["nonce", "uint256"],
  ["message", "string"]
] as const;
const TYPED_DATA_SIGN_TYPE = [
  ["contents", "Order"],
  ["name", "string"],
  ["version", "string"],
  ["chainId", "uint256"],
  ["verifyingContract", "address"],
  ["salt", "bytes32"]
] as const;

export interface TypedDataField {
  name: string;
  type: string;
}

export type TypedDataTypes = Record<string, TypedDataField[]>;
export type TypedDataDomain = Record<string, unknown>;
export type TypedDataValue = Record<string, unknown>;

interface BaseSigningPermit {
  expiresAtMs: number;
  expectedAddress: Address;
}

export interface ClobAuthSigningPermit extends BaseSigningPermit {
  purpose: "clob-auth";
}

export interface OrderSigningPermit extends BaseSigningPermit {
  purpose: "order";
  proposalId: string;
  proposalHash: string;
  maker: Address;
  orderSigner: Address;
  tokenId: bigint;
  side: 0 | 1;
  signatureType: 0 | 1 | 2 | 3;
  maxMakerAmount: bigint;
  maxTakerAmount: bigint;
  allowedVerifyingContracts: readonly Address[];
  allowedDomainVersions?: readonly ("2" | "3")[];
  metadata?: Hex;
  builder?: Hex;
}

export type SigningPermit = ClobAuthSigningPermit | OrderSigningPermit;

export interface RestrictedSignerOptions {
  keychain: KeychainPort;
  permit: SigningPermit;
  now?: () => number;
  beforeSign?: () => void | Promise<void>;
  beforeSignTimeoutMs?: number;
}

/**
 * Structurally implements the Ethers-style ClobSigner accepted by
 * @polymarket/clob-client-v2 without retaining a Wallet or private key.
 */
export class RestrictedKeychainSigner {
  private readonly keychain: KeychainPort;
  private readonly permit: SigningPermit;
  private readonly now: () => number;
  private readonly beforeSign: (() => void | Promise<void>) | undefined;
  private readonly beforeSignTimeoutMs: number;
  private consumed = false;
  private lastOrderHash: Hex | null = null;

  constructor(options: RestrictedSignerOptions) {
    if (!isAddress(options.permit.expectedAddress, { strict: false })) {
      throw new RestrictedSigningError("INVALID_EXPECTED_ADDRESS");
    }
    this.keychain = options.keychain;
    this.permit = normalizePermit(options.permit);
    this.now = options.now ?? Date.now;
    this.beforeSign = options.beforeSign;
    this.beforeSignTimeoutMs =
      options.beforeSignTimeoutMs ?? DEFAULT_BEFORE_SIGN_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.beforeSignTimeoutMs) ||
      this.beforeSignTimeoutMs <= 0 ||
      this.beforeSignTimeoutMs > 30_000
    ) {
      throw new RestrictedSigningError("INVALID_PREFLIGHT_TIMEOUT");
    }
  }

  async getAddress(): Promise<string> {
    return this.permit.expectedAddress;
  }

  /**
   * Returns the exact inner CLOB Order hash observed immediately before the
   * one-shot Keychain signature. Authentication permits never produce one.
   */
  getLastOrderHash(): Hex | null {
    return this.lastOrderHash;
  }

  async _signTypedData(
    domain: TypedDataDomain,
    types: TypedDataTypes,
    value: TypedDataValue
  ): Promise<string> {
    if (this.consumed) {
      throw new RestrictedSigningError("PERMIT_ALREADY_CONSUMED");
    }
    if (this.now() > this.permit.expiresAtMs) {
      this.consumed = true;
      throw new RestrictedSigningError("PERMIT_EXPIRED");
    }

    const validated =
      this.permit.purpose === "clob-auth"
        ? {
            primaryType: validateClobAuth(
              this.permit,
              domain,
              types,
              value,
              this.now()
            ),
            order: null
          }
        : validateOrder(this.permit, domain, types, value, this.now());

    // A failed Keychain access or signing attempt consumes the permit. Retrying
    // requires a fresh staged execution permit and prevents replay ambiguity.
    this.consumed = true;
    const privateKey = await this.keychain.readSocialPrivateKey({
      reason:
        this.permit.purpose === "order"
          ? signingReason(this.permit)
          : "Authorize Polymarket credential setup"
    });

    try {
      if (privateKey.byteLength !== 32 || privateKey.every((byte) => byte === 0)) {
        throw new RestrictedSigningError("INVALID_PRIVATE_KEY");
      }
      const privateKeyHex = bytesToHex(privateKey) as Hex;
      const account = privateKeyToAccount(privateKeyHex);
      if (getAddress(account.address) !== getAddress(this.permit.expectedAddress)) {
        throw new RestrictedSigningError("SIGNER_ADDRESS_MISMATCH");
      }
      if (this.beforeSign !== undefined) {
        await runBeforeSignWithTimeout(
          this.beforeSign,
          this.beforeSignTimeoutMs
        );
      }
      if (this.now() > this.permit.expiresAtMs) {
        throw new RestrictedSigningError("PERMIT_EXPIRED");
      }
      const revalidated =
        this.permit.purpose === "clob-auth"
          ? {
              primaryType: validateClobAuth(
                this.permit,
                domain,
                types,
                value,
                this.now()
              ),
              order: null
            }
          : validateOrder(this.permit, domain, types, value, this.now());
      if (revalidated.order !== null) {
        this.lastOrderHash = hashValidatedOrder(domain, revalidated.order);
      }

      const signTypedData = account.signTypedData as unknown as (parameters: {
        domain: TypedDataDomain;
        types: TypedDataTypes;
        primaryType: string;
        message: TypedDataValue;
      }) => Promise<Hex>;
      return await signTypedData({
        domain,
        types,
        primaryType: revalidated.primaryType ?? validated.primaryType,
        message: value
      });
    } finally {
      privateKey.fill(0);
    }
  }
}

async function runBeforeSignWithTimeout(
  beforeSign: () => void | Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(beforeSign),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new RestrictedSigningError("FINAL_PREFLIGHT_TIMEOUT")
            ),
          timeoutMs
        );
        timeout.unref();
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export class RestrictedSigningError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Restricted signing rejected (${code}).`);
    this.name = "RestrictedSigningError";
    this.code = code;
  }
}

function normalizePermit(permit: SigningPermit): SigningPermit {
  const expectedAddress = getAddress(permit.expectedAddress);
  if (permit.purpose === "clob-auth") {
    return { ...permit, expectedAddress };
  }
  if (
    permit.maxMakerAmount <= 0n ||
    permit.maxTakerAmount <= 0n ||
    permit.allowedVerifyingContracts.length === 0 ||
    !/^[a-fA-F0-9]{64}$/.test(permit.proposalHash)
  ) {
    throw new RestrictedSigningError("INVALID_ORDER_PERMIT");
  }
  return {
    ...permit,
    expectedAddress,
    maker: getAddress(permit.maker),
    orderSigner: getAddress(permit.orderSigner),
    allowedVerifyingContracts: permit.allowedVerifyingContracts.map((address) =>
      getAddress(address)
    )
  };
}

function validateClobAuth(
  permit: ClobAuthSigningPermit,
  domain: TypedDataDomain,
  types: TypedDataTypes,
  value: TypedDataValue,
  nowMs: number
): "ClobAuth" {
  assertExactKeys(domain, ["name", "version", "chainId"], "AUTH_DOMAIN_FIELDS");
  if (
    domain.name !== "ClobAuthDomain" ||
    domain.version !== "1" ||
    parseUnsigned(domain.chainId, "AUTH_CHAIN") !== CHAIN_ID
  ) {
    throw new RestrictedSigningError("AUTH_DOMAIN_MISMATCH");
  }
  assertExactTypes(types, { ClobAuth: CLOB_AUTH_TYPE });
  assertExactKeys(
    value,
    ["address", "timestamp", "nonce", "message"],
    "AUTH_MESSAGE_FIELDS"
  );
  if (
    normalizeAddress(value.address, "AUTH_ADDRESS") !==
      getAddress(permit.expectedAddress) ||
    value.message !== CLOB_AUTH_MESSAGE
  ) {
    throw new RestrictedSigningError("AUTH_MESSAGE_MISMATCH");
  }

  if (typeof value.timestamp !== "string" || !/^\d+$/.test(value.timestamp)) {
    throw new RestrictedSigningError("AUTH_TIMESTAMP_INVALID");
  }
  const timestampSeconds = BigInt(value.timestamp);
  const nowSeconds = BigInt(Math.floor(nowMs / 1_000));
  if (timestampSeconds < nowSeconds - 300n || timestampSeconds > nowSeconds + 60n) {
    throw new RestrictedSigningError("AUTH_TIMESTAMP_STALE");
  }
  parseUnsigned(value.nonce, "AUTH_NONCE");
  return "ClobAuth";
}

function validateOrder(
  permit: OrderSigningPermit,
  domain: TypedDataDomain,
  types: TypedDataTypes,
  value: TypedDataValue,
  nowMs: number
): {
  primaryType: "Order" | "TypedDataSign";
  order: TypedDataValue;
} {
  assertExactKeys(
    domain,
    ["name", "version", "chainId", "verifyingContract"],
    "ORDER_DOMAIN_FIELDS"
  );
  const allowedVersions = permit.allowedDomainVersions ?? ["2", "3"];
  const verifyingContract = normalizeAddress(
    domain.verifyingContract,
    "ORDER_VERIFYING_CONTRACT"
  );
  if (
    domain.name !== "Polymarket CTF Exchange" ||
    typeof domain.version !== "string" ||
    !allowedVersions.includes(domain.version as "2" | "3") ||
    parseUnsigned(domain.chainId, "ORDER_CHAIN") !== CHAIN_ID ||
    !permit.allowedVerifyingContracts.some(
      (allowed) => getAddress(allowed) === verifyingContract
    )
  ) {
    throw new RestrictedSigningError("ORDER_DOMAIN_MISMATCH");
  }

  let order: TypedDataValue;
  let primaryType: "Order" | "TypedDataSign";
  if ("TypedDataSign" in types) {
    assertExactTypes(types, {
      TypedDataSign: TYPED_DATA_SIGN_TYPE,
      Order: ORDER_TYPE
    });
    assertExactKeys(
      value,
      ["contents", "name", "version", "chainId", "verifyingContract", "salt"],
      "WRAPPED_ORDER_FIELDS"
    );
    if (
      value.name !== "DepositWallet" ||
      value.version !== "1" ||
      parseUnsigned(value.chainId, "WRAPPED_ORDER_CHAIN") !== CHAIN_ID ||
      normalizeAddress(value.verifyingContract, "WRAPPED_VERIFYING_CONTRACT") !==
        getAddress(permit.orderSigner) ||
      normalizeBytes32(value.salt, "WRAPPED_SALT") !== ZERO_BYTES32 ||
      value.contents === null ||
      typeof value.contents !== "object" ||
      Array.isArray(value.contents)
    ) {
      throw new RestrictedSigningError("WRAPPED_ORDER_MISMATCH");
    }
    order = value.contents as TypedDataValue;
    primaryType = "TypedDataSign";
  } else {
    assertExactTypes(types, { Order: ORDER_TYPE });
    order = value;
    primaryType = "Order";
  }

  validateOrderMessage(permit, order, nowMs);
  return { primaryType, order };
}

function hashValidatedOrder(
  domain: TypedDataDomain,
  order: TypedDataValue
): Hex {
  return hashTypedData({
    domain: {
      name: "Polymarket CTF Exchange",
      version: String(domain.version),
      chainId: Number(parseUnsigned(domain.chainId, "ORDER_CHAIN")),
      verifyingContract: normalizeAddress(
        domain.verifyingContract,
        "ORDER_VERIFYING_CONTRACT"
      )
    },
    types: {
      Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "side", type: "uint8" },
        { name: "signatureType", type: "uint8" },
        { name: "timestamp", type: "uint256" },
        { name: "metadata", type: "bytes32" },
        { name: "builder", type: "bytes32" }
      ]
    },
    primaryType: "Order",
    message: {
      salt: parseUnsigned(order.salt, "ORDER_SALT"),
      maker: normalizeAddress(order.maker, "ORDER_MAKER"),
      signer: normalizeAddress(order.signer, "ORDER_SIGNER"),
      tokenId: parseUnsigned(order.tokenId, "ORDER_TOKEN"),
      makerAmount: parseUnsigned(order.makerAmount, "ORDER_MAKER_AMOUNT"),
      takerAmount: parseUnsigned(order.takerAmount, "ORDER_TAKER_AMOUNT"),
      side: Number(parseUnsigned(order.side, "ORDER_SIDE")),
      signatureType: Number(
        parseUnsigned(order.signatureType, "ORDER_SIGNATURE_TYPE")
      ),
      timestamp: parseUnsigned(order.timestamp, "ORDER_TIMESTAMP"),
      metadata: normalizeBytes32(order.metadata, "ORDER_METADATA") as Hex,
      builder: normalizeBytes32(order.builder, "ORDER_BUILDER") as Hex
    }
  });
}

function validateOrderMessage(
  permit: OrderSigningPermit,
  order: TypedDataValue,
  nowMs: number
): void {
  assertExactKeys(
    order,
    [
      "salt",
      "maker",
      "signer",
      "tokenId",
      "makerAmount",
      "takerAmount",
      "side",
      "signatureType",
      "timestamp",
      "metadata",
      "builder"
    ],
    "ORDER_MESSAGE_FIELDS"
  );
  const salt = parseUnsigned(order.salt, "ORDER_SALT");
  const makerAmount = parseUnsigned(order.makerAmount, "ORDER_MAKER_AMOUNT");
  const takerAmount = parseUnsigned(order.takerAmount, "ORDER_TAKER_AMOUNT");
  const timestamp = parseUnsigned(order.timestamp, "ORDER_TIMESTAMP");

  if (
    salt === 0n ||
    normalizeAddress(order.maker, "ORDER_MAKER") !== getAddress(permit.maker) ||
    normalizeAddress(order.signer, "ORDER_SIGNER") !==
      getAddress(permit.orderSigner) ||
    parseUnsigned(order.tokenId, "ORDER_TOKEN") !== permit.tokenId ||
    parseUnsigned(order.side, "ORDER_SIDE") !== BigInt(permit.side) ||
    parseUnsigned(order.signatureType, "ORDER_SIGNATURE_TYPE") !==
      BigInt(permit.signatureType) ||
    makerAmount === 0n ||
    takerAmount === 0n ||
    makerAmount !== permit.maxMakerAmount ||
    takerAmount !== permit.maxTakerAmount ||
    normalizeBytes32(order.metadata, "ORDER_METADATA") !==
      (permit.metadata?.toLowerCase() ?? ZERO_BYTES32) ||
    normalizeBytes32(order.builder, "ORDER_BUILDER") !==
      (permit.builder?.toLowerCase() ?? ZERO_BYTES32)
  ) {
    throw new RestrictedSigningError("ORDER_MESSAGE_MISMATCH");
  }

  const now = BigInt(nowMs);
  if (timestamp < now - 300_000n || timestamp > now + 60_000n) {
    throw new RestrictedSigningError("ORDER_TIMESTAMP_STALE");
  }
}

function signingReason(permit: OrderSigningPermit): string {
  const side = permit.side === 0 ? "BUY" : "SELL";
  return `Authorize ${side} order ${permit.proposalHash.slice(0, 8)}…${permit.proposalHash.slice(-8)}`;
}

function assertExactTypes(
  actual: TypedDataTypes,
  expected: Record<string, ReadonlyArray<readonly [string, string]>>
): void {
  assertExactKeys(actual, Object.keys(expected), "TYPED_DATA_TYPES");
  for (const [typeName, expectedFields] of Object.entries(expected)) {
    const fields = actual[typeName];
    if (
      fields === undefined ||
      fields.length !== expectedFields.length ||
      fields.some(
        (field, index) =>
          field.name !== expectedFields[index]?.[0] ||
          field.type !== expectedFields[index]?.[1]
      )
    ) {
      throw new RestrictedSigningError("TYPED_DATA_SCHEMA_MISMATCH");
    }
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new RestrictedSigningError(code);
  }
}

function parseUnsigned(value: unknown, code: string): bigint {
  if (
    !(
      typeof value === "bigint" ||
      (typeof value === "number" && Number.isSafeInteger(value)) ||
      (typeof value === "string" && /^\d+$/.test(value))
    )
  ) {
    throw new RestrictedSigningError(code);
  }
  const parsed = BigInt(value);
  if (parsed < 0n) {
    throw new RestrictedSigningError(code);
  }
  return parsed;
}

function normalizeAddress(value: unknown, code: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new RestrictedSigningError(code);
  }
  return getAddress(value);
}

function normalizeBytes32(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new RestrictedSigningError(code);
  }
  return value.toLowerCase();
}
