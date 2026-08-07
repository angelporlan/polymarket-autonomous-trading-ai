import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";

const LABEL = "com.codex.polymarket.supervisor";

export function installSupervisor(): void {
  if (process.platform !== "darwin") {
    throw new Error("SUPERVISOR_INSTALL_REQUIRES_MACOS");
  }
  const config = loadConfig();
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const entrypoint = path.join(repositoryRoot, "dist/supervisor/main.js");
  if (!existsSync(entrypoint)) {
    throw new Error("SUPERVISOR_BUILD_REQUIRED");
  }
  const launchAgentsDirectory = path.join(os.homedir(), "Library/LaunchAgents");
  const plistPath = path.join(launchAgentsDirectory, `${LABEL}.plist`);
  const logDirectory = path.dirname(config.databasePath);
  mkdirSync(launchAgentsDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });

  writeFileSync(
    plistPath,
    renderLaunchdPlist({
      executable: process.execPath,
      entrypoint,
      repositoryRoot,
      stdoutPath: path.join(logDirectory, "supervisor.stdout.log"),
      stderrPath: path.join(logDirectory, "supervisor.stderr.log")
    }),
    { encoding: "utf8", mode: 0o600 }
  );
  chmodSync(plistPath, 0o600);

  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("SUPERVISOR_USER_ID_UNAVAILABLE");
  }
  execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], {
    stdio: "ignore"
  });
  process.stderr.write(`Installed ${LABEL}.\n`);
}

export function renderLaunchdPlist(input: {
  executable: string;
  entrypoint: string;
  repositoryRoot: string;
  stdoutPath: string;
  stderrPath: string;
}): string {
  const stringValue = (value: string): string =>
    `<string>${escapeXml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${stringValue(LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${stringValue(input.executable)}
    ${stringValue(input.entrypoint)}
  </array>
  <key>WorkingDirectory</key>
  ${stringValue(input.repositoryRoot)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  ${stringValue(input.stdoutPath)}
  <key>StandardErrorPath</key>
  ${stringValue(input.stderrPath)}
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    installSupervisor();
  } catch {
    process.stderr.write("SUPERVISOR_INSTALL_FAILED\n");
    process.exitCode = 1;
  }
}
