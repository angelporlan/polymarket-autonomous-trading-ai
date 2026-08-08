import { spawn } from "node:child_process";
import path from "node:path";
import type { SessionAuthorizationAttestation } from "../domain/session.js";

export const KEYCHAIN_SERVICE = "codex-polymarket-guarded";
export const SOCIAL_PRIVATE_KEY_ACCOUNT = "social-private-key.v1";
export const L2_CREDENTIALS_ACCOUNT = "l2-credentials.v1";
export const SESSION_AUTHORIZATION_ACCOUNT = "session-authorization.v1";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 128 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;

export interface KeychainReadContext {
  reason: string;
  proposalId?: string;
  proposalHash?: string;
}

export interface KeychainPort {
  readSocialPrivateKey(context: KeychainReadContext): Promise<Uint8Array>;
}

export interface KeychainItemStatus {
  exists: boolean;
}

export type ProtectedAccount =
  | typeof SOCIAL_PRIVATE_KEY_ACCOUNT
  | typeof L2_CREDENTIALS_ACCOUNT
  | typeof SESSION_AUTHORIZATION_ACCOUNT;

export class KeychainHelperError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`macOS Keychain operation failed (${code}).`);
    this.name = "KeychainHelperError";
    this.code = code;
  }
}

export interface MacOSKeychainOptions {
  helperPath: string;
  timeoutMs?: number;
}

interface HelperRequestHeader {
  version: 1;
  operation:
    | "status"
    | "import-social-key"
    | "authorize-session"
    | "put"
    | "read";
  service: typeof KEYCHAIN_SERVICE;
  account: ProtectedAccount;
  payloadLength: number;
  reason?: string;
}

interface HelperResponseHeader {
  version: number;
  ok: boolean;
  code: string;
  payloadLength: number;
  exists?: boolean;
}

interface HelperResponse {
  header: HelperResponseHeader;
  payload: Buffer;
}

export class MacOSKeychain implements KeychainPort {
  private readonly helperPath: string;
  private readonly timeoutMs: number;

  constructor(options: MacOSKeychainOptions) {
    if (process.platform !== "darwin") {
      throw new KeychainHelperError("UNSUPPORTED_PLATFORM");
    }
    if (!path.isAbsolute(options.helperPath)) {
      throw new KeychainHelperError("HELPER_PATH_NOT_ABSOLUTE");
    }
    this.helperPath = options.helperPath;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async status(account: ProtectedAccount): Promise<KeychainItemStatus> {
    const response = await this.invoke({
      version: PROTOCOL_VERSION,
      operation: "status",
      service: KEYCHAIN_SERVICE,
      account,
      payloadLength: 0
    });
    try {
      return { exists: response.header.exists === true };
    } finally {
      response.payload.fill(0);
    }
  }

  async importSocialPrivateKeyInteractive(): Promise<void> {
    const response = await this.invoke({
      version: PROTOCOL_VERSION,
      operation: "import-social-key",
      service: KEYCHAIN_SERVICE,
      account: SOCIAL_PRIVATE_KEY_ACCOUNT,
      payloadLength: 0
    });
    response.payload.fill(0);
  }

  async storeL2Credentials(secret: Uint8Array): Promise<void> {
    if (secret.byteLength === 0 || secret.byteLength > MAX_SECRET_BYTES) {
      throw new KeychainHelperError("INVALID_SECRET");
    }
    const payload = Buffer.from(secret);
    try {
      const response = await this.invoke(
        {
          version: PROTOCOL_VERSION,
          operation: "put",
          service: KEYCHAIN_SERVICE,
          account: L2_CREDENTIALS_ACCOUNT,
          payloadLength: payload.byteLength
        },
        payload
      );
      response.payload.fill(0);
    } finally {
      payload.fill(0);
    }
  }

  async readL2Credentials(context: KeychainReadContext): Promise<Uint8Array> {
    return this.readProtectedSecret(L2_CREDENTIALS_ACCOUNT, context);
  }

  async readSocialPrivateKey(context: KeychainReadContext): Promise<Uint8Array> {
    const secret = await this.readProtectedSecret(SOCIAL_PRIVATE_KEY_ACCOUNT, context);
    if (secret.byteLength !== 32 || secret.every((byte) => byte === 0)) {
      secret.fill(0);
      throw new KeychainHelperError("INVALID_PRIVATE_KEY");
    }
    return secret;
  }

  async authorizeTradingSession(input: {
    pendingSessionId: string;
    executionMode: "paper" | "live";
    maximumAuthorizableMicros: bigint;
    expiresAtMs: number;
  }): Promise<SessionAuthorizationAttestation> {
    if (
      !/^pending_[0-9]+_[a-f0-9-]+$/u.test(input.pendingSessionId) ||
      input.maximumAuthorizableMicros <= 0n ||
      !Number.isSafeInteger(input.expiresAtMs)
    ) {
      throw new KeychainHelperError("INVALID_SESSION_AUTHORIZATION");
    }
    const payload = Buffer.from(
      JSON.stringify({
        pendingSessionId: input.pendingSessionId,
        executionMode: input.executionMode,
        maximumAuthorizableMicros: input.maximumAuthorizableMicros.toString(),
        expiresAtMs: input.expiresAtMs
      }),
      "utf8"
    );
    try {
      const response = await this.invoke(
        {
          version: PROTOCOL_VERSION,
          operation: "authorize-session",
          service: KEYCHAIN_SERVICE,
          account: SESSION_AUTHORIZATION_ACCOUNT,
          payloadLength: payload.byteLength
        },
        payload
      );
      try {
        const candidate = JSON.parse(response.payload.toString("utf8")) as Record<
          string,
          unknown
        >;
        if (
          typeof candidate.confirmedAtMs === "number" &&
          Number.isSafeInteger(candidate.confirmedAtMs) &&
          candidate.confirmedAtMs > input.expiresAtMs
        ) {
          throw new KeychainHelperError("SESSION_AUTHORIZATION_EXPIRED");
        }
        if (candidate.pendingSessionId !== input.pendingSessionId) {
          throw new KeychainHelperError("INVALID_SESSION_PENDING_ID");
        }
        if (candidate.source !== "macos-native-user-presence") {
          throw new KeychainHelperError("INVALID_SESSION_SOURCE");
        }
        if (
          typeof candidate.amountMicros !== "string" ||
          !/^\d+$/u.test(candidate.amountMicros)
        ) {
          throw new KeychainHelperError("INVALID_SESSION_AMOUNT_FORMAT");
        }
        const amountMicros = BigInt(candidate.amountMicros);
        if (amountMicros <= 0n || amountMicros > input.maximumAuthorizableMicros) {
          throw new KeychainHelperError("INVALID_SESSION_AMOUNT_LIMIT");
        }
        if (
          typeof candidate.attestationNonce !== "string" ||
          !/^[a-f0-9]{64}$/u.test(candidate.attestationNonce)
        ) {
          throw new KeychainHelperError("INVALID_SESSION_NONCE");
        }
        if (
          typeof candidate.confirmedAtMs !== "number" ||
          !Number.isSafeInteger(candidate.confirmedAtMs)
        ) {
          throw new KeychainHelperError("INVALID_SESSION_TIMESTAMP");
        }
        return {
          pendingSessionId: input.pendingSessionId,
          amountMicros,
          attestationNonce: candidate.attestationNonce,
          attestationSource: "macos-native-user-presence",
          confirmedAtMs: candidate.confirmedAtMs
        };
      } catch (error) {
        if (error instanceof KeychainHelperError) throw error;
        throw new KeychainHelperError("MALFORMED_SESSION_ATTESTATION");
      } finally {
        response.payload.fill(0);
      }
    } finally {
      payload.fill(0);
    }
  }

  private async readProtectedSecret(
    account: ProtectedAccount,
    context: KeychainReadContext
  ): Promise<Uint8Array> {
    const reason = sanitizeReason(context.reason);
    const response = await this.invoke({
      version: PROTOCOL_VERSION,
      operation: "read",
      service: KEYCHAIN_SERVICE,
      account,
      payloadLength: 0,
      reason
    });
    if (response.payload.byteLength === 0 || response.payload.byteLength > MAX_SECRET_BYTES) {
      response.payload.fill(0);
      throw new KeychainHelperError("INVALID_SECRET");
    }
    return response.payload;
  }

  private async invoke(
    header: HelperRequestHeader,
    payload: Uint8Array = new Uint8Array()
  ): Promise<HelperResponse> {
    const frame = encodeRequest(header, payload);
    try {
      return await new Promise<HelperResponse>((resolve, reject) => {
        const child = spawn(this.helperPath, [], {
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            LANG: "en_US.UTF-8",
            PATH: "/usr/bin:/bin"
          }
        });

        const stdoutChunks: Buffer[] = [];
        let stdoutLength = 0;
        let settled = false;
        let timeout: NodeJS.Timeout | undefined;

        const finish = (
          callback: () => void
        ): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
          callback();
        };
        const rejectSafely = (error: KeychainHelperError): void => {
          finish(() => {
            for (const chunk of stdoutChunks) {
              chunk.fill(0);
            }
            stdoutChunks.length = 0;
            reject(error);
          });
        };

        timeout = setTimeout(() => {
          child.kill("SIGKILL");
          rejectSafely(new KeychainHelperError("TIMEOUT"));
        }, this.timeoutMs);
        timeout.unref();

        child.once("error", () => {
          rejectSafely(new KeychainHelperError("HELPER_UNAVAILABLE"));
        });

        child.stdout.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          stdoutLength += bytes.byteLength;
          if (stdoutLength > MAX_FRAME_BYTES) {
            bytes.fill(0);
            child.kill("SIGKILL");
            rejectSafely(new KeychainHelperError("RESPONSE_TOO_LARGE"));
            return;
          }
          stdoutChunks.push(bytes);
        });

        // stderr is intentionally drained but never retained or logged. Authenticated
        // HTTP and Keychain errors can otherwise become an accidental secret sink.
        child.stderr.on("data", () => undefined);

        child.once("close", (code, signal) => {
          finish(() => {
            const responseFrame = Buffer.concat(stdoutChunks, stdoutLength);
            for (const chunk of stdoutChunks) {
              chunk.fill(0);
            }
            try {
              const response = decodeResponse(responseFrame);
              if (!response.header.ok || code !== 0 || signal !== null) {
                response.payload.fill(0);
                reject(
                  new KeychainHelperError(
                    response.header.code || (signal === null ? "HELPER_FAILED" : "HELPER_KILLED")
                  )
                );
                return;
              }
              resolve(response);
            } catch (error) {
              reject(
                error instanceof KeychainHelperError
                  ? error
                  : new KeychainHelperError("MALFORMED_RESPONSE")
              );
            } finally {
              responseFrame.fill(0);
            }
          });
        });

        child.stdin.once("error", () => {
          child.kill("SIGKILL");
          rejectSafely(new KeychainHelperError("HELPER_STDIN_FAILED"));
        });
        child.stdin.end(frame);
      });
    } finally {
      frame.fill(0);
    }
  }
}

function sanitizeReason(reason: string): string {
  const trimmed = reason.trim();
  if (
    trimmed.length === 0 ||
    Buffer.byteLength(trimmed, "utf8") > 180 ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new KeychainHelperError("INVALID_REASON");
  }
  return trimmed;
}

function encodeRequest(
  header: HelperRequestHeader,
  payload: Uint8Array
): Buffer {
  if (header.payloadLength !== payload.byteLength) {
    throw new KeychainHelperError("PAYLOAD_LENGTH_MISMATCH");
  }
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.byteLength + payload.byteLength + 4 > MAX_FRAME_BYTES) {
    headerBytes.fill(0);
    throw new KeychainHelperError("REQUEST_TOO_LARGE");
  }
  const frame = Buffer.allocUnsafe(4 + headerBytes.byteLength + payload.byteLength);
  frame.writeUInt32BE(headerBytes.byteLength, 0);
  headerBytes.copy(frame, 4);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(
    frame,
    4 + headerBytes.byteLength
  );
  headerBytes.fill(0);
  return frame;
}

function decodeResponse(frame: Buffer): HelperResponse {
  if (frame.byteLength < 4) {
    throw new KeychainHelperError("MALFORMED_RESPONSE");
  }
  const headerLength = frame.readUInt32BE(0);
  if (headerLength === 0 || 4 + headerLength > frame.byteLength) {
    throw new KeychainHelperError("MALFORMED_RESPONSE");
  }
  const rawHeader = frame.subarray(4, 4 + headerLength).toString("utf8");
  const candidate = JSON.parse(rawHeader) as Partial<HelperResponseHeader>;
  if (
    candidate.version !== PROTOCOL_VERSION ||
    typeof candidate.ok !== "boolean" ||
    typeof candidate.code !== "string" ||
    !Number.isSafeInteger(candidate.payloadLength) ||
    (candidate.payloadLength ?? -1) < 0 ||
    (candidate.payloadLength ?? 0) > MAX_SECRET_BYTES
  ) {
    throw new KeychainHelperError("MALFORMED_RESPONSE");
  }
  const payloadLength = candidate.payloadLength as number;
  if (frame.byteLength !== 4 + headerLength + payloadLength) {
    throw new KeychainHelperError("MALFORMED_RESPONSE");
  }
  const header: HelperResponseHeader = {
    version: candidate.version,
    ok: candidate.ok,
    code: candidate.code,
    payloadLength,
    ...(typeof candidate.exists === "boolean" ? { exists: candidate.exists } : {})
  };
  return {
    header,
    payload: Buffer.from(frame.subarray(4 + headerLength))
  };
}
