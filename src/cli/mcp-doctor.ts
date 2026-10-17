import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../config.js";
import {
  createMcpServer,
  MCP_TOOL_NAMES,
  type McpToolDependencies
} from "../mcp/server.js";
import { BUILD_ID } from "../runtime.js";
import { verifyAuditChainReadOnly } from "../storage/database.js";

interface DoctorResult {
  configuration: "ok";
  build: "ok";
  database: "ok";
  auditChain: "ok";
  handshake: "ok";
  registeredToolCount: number;
  required: true;
  buildId: string;
}

export async function runMcpDoctor(
  workspace = process.cwd()
): Promise<DoctorResult> {
  const configPath = path.join(workspace, ".codex", "config.toml");
  const distServerPath = path.join(workspace, "dist", "mcp", "server.js");
  const distRuntimePath = path.join(workspace, "dist", "runtime.js");
  const sourcePath = path.join(workspace, "src");
  const mcpConfig = readRequiredFile(configPath, "MCP_CONFIG_MISSING");
  if (
    !/^\[mcp_servers\.polymarket\]$/mu.test(mcpConfig) ||
    !/^enabled\s*=\s*true$/mu.test(mcpConfig) ||
    !/^required\s*=\s*true$/mu.test(mcpConfig) ||
    !/^command\s*=\s*"node"$/mu.test(mcpConfig) ||
    !/^args\s*=\s*\["dist\/mcp\/server\.js"\]$/mu.test(mcpConfig)
  ) {
    throw new Error("MCP_CONFIG_INVALID");
  }

  const config = loadConfig();
  if (config.paperGateSkip && config.paperGateSkipSource !== "dotenv") {
    throw new Error("PAPER_GATE_SKIP_NOT_DOTENV");
  }
  if (!existsSync(config.databasePath)) {
    throw new Error("MCP_DATABASE_MISSING");
  }
  if (!verifyAuditChainReadOnly(config.databasePath)) {
    throw new Error("AUDIT_CHAIN_INVALID");
  }

  const distServer = readRequiredFile(distServerPath, "MCP_BUILD_MISSING");
  const distRuntime = readRequiredFile(distRuntimePath, "MCP_BUILD_MISSING");
  const buildMtimeMs = Math.min(
    statSync(distServerPath).mtimeMs,
    statSync(distRuntimePath).mtimeMs
  );
  if (
    buildMtimeMs < newestSourceMtimeMs(sourcePath) ||
    !distServer.includes('"prepare_agent_cycle"') ||
    !distRuntime.includes(BUILD_ID)
  ) {
    throw new Error("MCP_BUILD_STALE");
  }

  const tools = await handshakeTools();
  if (
    tools.length !== MCP_TOOL_NAMES.length ||
    MCP_TOOL_NAMES.some((name, index) => tools[index] !== name)
  ) {
    throw new Error("MCP_TOOL_REGISTRY_MISMATCH");
  }

  return {
    configuration: "ok",
    build: "ok",
    database: "ok",
    auditChain: "ok",
    handshake: "ok",
    registeredToolCount: tools.length,
    required: true,
    buildId: BUILD_ID
  };
}

async function handshakeTools(): Promise<string[]> {
  const unavailable = async (): Promise<never> => {
    throw new Error("MCP_DOCTOR_TOOL_INVOCATION_FORBIDDEN");
  };
  const dependencies = new Proxy(
    {},
    { get: () => unavailable }
  ) as McpToolDependencies;
  const server = createMcpServer(dependencies);
  const client = new Client(
    { name: "polymarket-mcp-doctor", version: "1.0.0" },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.listTools();
    return result.tools.map((tool) => tool.name);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function readRequiredFile(filename: string, code: string): string {
  if (!existsSync(filename)) throw new Error(code);
  return readFileSync(filename, "utf8");
}

function newestSourceMtimeMs(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestSourceMtimeMs(filename) : statSync(filename).mtimeMs
    );
  }
  return newest;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  void runMcpDoctor()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      const code =
        error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message)
          ? error.message
          : "MCP_DOCTOR_FAILED";
      process.stderr.write(`[mcp-doctor] ${code}\n`);
      process.exitCode = 1;
    });
}
