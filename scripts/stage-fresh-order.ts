import { PolymarketRuntime } from "../src/runtime.js";

async function main() {
  const runtime = new PolymarketRuntime();
  const status = await runtime.getAccountStatus();
  console.log("Account status:", JSON.stringify(status, null, 2));

  const staged = await runtime.stageOrder({
    executionMode: "live",
    conditionId: "0xa9cebe2b15436ca65edfdcd7d447a0b7028ae5bc5f70ab8860609cf931ff536c",
    tokenId: "53107233019936818776932537419928255013820188991890096631827301058948809573990",
    outcome: "Yes",
    side: "BUY",
    shares: "5.000000",
    limitPricePusd: "0.026000",
    estimatedProbability: "0.080000",
    thesis: "Análisis del panorama político en España y potenciales presiones parlamentarias sobre el Ejecutivo antes de finales de agosto.",
    counterThesis: "Estabilidad parlamentaria en el bloque de investidura y baja probabilidad de adelanto estival por el calendario legislativo.",
    sources: [
      {
        url: "https://www.boe.es",
        title: "Boletín Oficial del Estado - Convocatorias de elecciones",
        publishedAt: "2026-08-01T00:00:00Z",
        retrievedAt: "2026-08-05T10:20:00Z",
        primary: true
      }
    ],
    confirmsNoConfidentialInformation: true,
    confirmsNoOutcomeInfluence: true
  });

  const approval = await runtime.createApprovalRequest({
    proposalId: staged.proposalId,
    proposalHash: staged.proposalHash
  });

  const lastSix = staged.proposalHash.slice(-6);

  process.stdout.write(`\n=========================================\n`);
  process.stdout.write(`NUEVA PROPUESTA LISTA PARA CONFIRMAR\n`);
  process.stdout.write(`=========================================\n`);
  process.stdout.write(`Proposal ID:   ${staged.proposalId}\n`);
  process.stdout.write(`Proposal Hash: ${staged.proposalHash}\n`);
  process.stdout.write(`Mercado:       ${staged.market.question}\n`);
  process.stdout.write(`Operación:     BUY 5 acciones @ $0.026 (Total: $0.13 pUSD)\n`);
  process.stdout.write(`Últimos 6 caracteres a escribir: [ ${lastSix} ]\n`);
  process.stdout.write(`=========================================\n`);
  process.stdout.write(`URL DE CONFIRMACIÓN:\n${approval.approvalUrl}\n`);
  process.stdout.write(`=========================================\n\n`);

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Error al preparar la orden:", err);
  process.exit(1);
});
