import { PolymarketRuntime } from "../src/runtime.js";

async function main() {
  const runtime = new PolymarketRuntime();
  const portfolio = await runtime.getPortfolio();
  console.log("Portfolio Balance Result:", JSON.stringify(portfolio, null, 2));
}

main().catch((err) => {
  console.error("Balance check error:", err);
});
