import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEurFxQuote } from "../accounting/valuation.js";
import { exportLedger } from "../audit/exporter.js";
import { loadConfig } from "../config.js";
import { TradingDatabase } from "../storage/database.js";

function defaultExportDirectory(): string {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  return path.resolve("exports", stamp);
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const config = loadConfig();
  const outputDirectory = argv[0] ?? defaultExportDirectory();
  const quotePath = argv[1];
  const eurFxQuote =
    quotePath === undefined
      ? undefined
      : parseEurFxQuote(
          JSON.parse(readFileSync(path.resolve(quotePath), "utf8")) as unknown
        );
  const database = new TradingDatabase(config.databasePath);
  try {
    const result = exportLedger(database, outputDirectory, Date.now(), eurFxQuote);
    process.stdout.write(
      `${JSON.stringify(
        {
          jsonPath: result.jsonPath,
          csvPath: result.csvPath,
          accountingCsvPath: result.accountingCsvPath,
          auditChainValid: result.auditChainValid,
          exportedAt: result.exportedAt
        },
        null,
        2
      )}\n`
    );
    if (!result.auditChainValid) {
      process.exitCode = 2;
    }
  } finally {
    database.close();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
