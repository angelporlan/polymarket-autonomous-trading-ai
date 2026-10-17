import path from "node:path";
import { loadConfig } from "../config.js";
import { OnboardingService } from "../onboarding/service.js";
import {
  PaperReconciler,
  ReconciledPaperGate
} from "../paper/reconciler.js";
import { PolymarketPublicClient } from "../polymarket/public-client.js";
import { MacOSKeychain } from "../security/keychain.js";
import { TradingDatabase } from "../storage/database.js";

function optionValue(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? "" : "";
}

const RESUME_LIVE_CONFIRMATION = "RESUME_LIVE_AFTER_REVIEW";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "status";
  const config = loadConfig();
  const database = new TradingDatabase(config.databasePath);
  const keychain = new MacOSKeychain({
    helperPath: path.resolve("bin/polymarket-keychain-helper")
  });
  const service = new OnboardingService(config, database, keychain);
  const publicClient = new PolymarketPublicClient({
    gammaHost: config.gammaHost,
    dataHost: config.dataHost,
    clobHost: config.clobHost
  });
  const paperGate = new ReconciledPaperGate(
    database,
    new PaperReconciler(database, publicClient)
  );

  try {
    switch (command) {
      case "status":
        process.stdout.write(`${JSON.stringify(await service.status(), null, 2)}\n`);
        break;
      case "import-key":
        await service.importSocialKey();
        process.stdout.write(
          "La clave se guardó directamente en el Llavero; no se imprimió.\n"
        );
        break;
      case "configure": {
        const result = await service.configureAccount(
          argv.includes("--confirm-legacy-proxy")
        );
        process.stdout.write(
          `${JSON.stringify(
            {
              configured: true,
              signerAddress: result.signerAddress,
              funderAddress: result.funderAddress,
              signatureType: result.signatureType
            },
            null,
            2
          )}\n`
        );
        break;
      }
      case "activate-live":
        {
          const paperGateResult = await paperGate.result(
            config.paperGateSkip
          );
          await service.activateLive(
            optionValue(argv, "--confirm"),
            paperGateResult.passed
          );
          process.stdout.write(
            "Live activado localmente con presencia del usuario.\n"
          );
          break;
        }
      case "adopt-existing-portfolio":
        {
          const paperGateResult = await paperGate.result(
            config.paperGateSkip
          );
          await service.adoptExistingPortfolio(
            optionValue(argv, "--confirm"),
            paperGateResult.passed
          );
          process.stdout.write(
            "Cartera existente adoptada localmente; live permanece desactivado.\n"
          );
          break;
        }
      case "deactivate-live":
        service.deactivateLive();
        process.stdout.write("Live desactivado localmente.\n");
        break;
      case "clear-emergency":
        await service.clearEmergencyStop(optionValue(argv, "--confirm"));
        process.stdout.write(
          "Bloqueo de emergencia revisado y limpiado; live permanece desactivado.\n"
        );
        break;
      case "resume-live": {
        if (optionValue(argv, "--confirm") !== RESUME_LIVE_CONFIRMATION) {
          throw new Error(
            `Exact ${RESUME_LIVE_CONFIRMATION} confirmation is required.`
          );
        }
        if (database.getEmergencyStop().active) {
          await service.clearEmergencyStop("CLEAR_EMERGENCY");
        }
        const paperGateResult = await paperGate.result(config.paperGateSkip);
        await service.activateLive("ACTIVATE_LIVE", paperGateResult.passed);
        process.stdout.write(
          "Bloqueo revisado y live reactivado localmente.\n"
        );
        break;
      }
      default:
        throw new Error(
          "Uso: onboard status|import-key|configure [--confirm-legacy-proxy]|adopt-existing-portfolio --confirm ADOPT_EXISTING_PORTFOLIO|activate-live --confirm ACTIVATE_LIVE|deactivate-live|clear-emergency --confirm CLEAR_EMERGENCY|resume-live --confirm RESUME_LIVE_AFTER_REVIEW"
        );
    }
  } finally {
    database.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `[onboard] La operación falló (${message}); no se imprimió material secreto.\n`
  );
  process.exitCode = 1;
});
