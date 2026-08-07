# Plan de acción — Polymarket Autonomous Trading AI

## Objetivo

Convertir el proyecto en un sistema de trading autónomo **operativamente completo y verificable**, capaz de:

1. pedir a la persona usuaria un presupuesto antes de cada sesión;
2. abrir posiciones únicamente dentro de ese presupuesto y de los límites duros;
3. reevaluar y cerrar posiciones según reglas conservadoras;
4. impedir duplicados, ventas descubiertas, ampliaciones de presupuesto y cambios de orden no autorizados;
5. fallar de forma segura ante errores de red, datos, firma, conciliación o investigación;
6. mantener una auditoría reproducible de cada decisión, fuente, orden, fill, comisión y salida.

> **Regla de despliegue:** mantener `POLYMARKET_LIVE_ENABLED=false` hasta completar todos los criterios de aceptación del apartado **Gate final para live**.

---

## Resumen de prioridades

| Prioridad | Trabajo | Resultado esperado |
|---|---|---|
| P0 | Congelar live y fijar baseline | Ninguna orden real durante el desarrollo |
| P1 | Corregir `ENTRY` / `EXIT` de extremo a extremo | Las salidas dejan de tratarse como entradas |
| P2 | Autorización humana de presupuesto por sesión | El agente no puede crear o ampliar presupuesto por sí solo |
| P3 | Vincular propuesta, sesión y presupuesto | Ninguna propuesta puede ejecutarse con otra sesión |
| P4 | Implementar salida real y reconciliada | Stop-loss, take-profit y vencimiento generan ventas reales seguras |
| P5 | Rehacer supervisor de posiciones | Probabilidad, precio y fuentes quedan separados y trazables |
| P6 | Verificación real de fuentes | No se aceptan URLs o fechas inventadas |
| P7 | Supervisor persistente de reducción de riesgo | Las salidas siguen funcionando con Antigravity cerrado |
| P8 | Importar posiciones heredadas | La posición de Macron queda reconstruida o bloqueada explícitamente |
| P9 | Eliminar arquitectura antigua | Sin aprobación local heredada ni estados ambiguos |
| P10 | Pruebas de integración y seguridad | CI representa el comportamiento real |
| P11 | Paper soak y canary live | Activación gradual y reversible |

---

# P0 — Congelación y baseline

## Tareas

- [x] Mantener `POLYMARKET_LIVE_ENABLED=false` en configuración local y versionada.
- [x] Mantener `PAPER_GATE_SKIP=false` durante el desarrollo normal.
- [x] Confirmar que no existe ningún `cron`, `launchd`, daemon o proceso MCP antiguo ejecutándose.
- [x] Mantener bloqueados:
  - `scripts/run-live-cycle.ts`
  - `scripts/stage-fresh-order.ts`
- [x] Crear una etiqueta Git antes de empezar:

```bash
git tag pre-autonomy-hardening
git push origin pre-autonomy-hardening
```

- [x] Exportar una copia privada del ledger actual.
- [x] Ejecutar y guardar el resultado de:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit
```

## Criterio de aceptación

- El repositorio compila y pasa las pruebas con live desactivado.
- No hay proceso capaz de enviar una orden real durante las siguientes fases.

## Evidencia de completado

- Configuración efectiva verificada: `liveEnabled=false` y `paperGateSkip=false`.
- No quedan procesos MCP de este repositorio, cron, launchd, LaunchAgent ni crontab activos. Las seis instancias encontradas antes de cerrar live fueron terminadas de forma explícita.
- `run-live-cycle.ts` y `stage-fresh-order.ts` fallan cerrados antes de construir un runtime, ambos con código de salida `1`.
- Ledger exportado en `exports/p0-baseline.yNobZF/`, ignorado por Git, con permisos privados (`600`) y `auditChainValid=true`.
- Baseline: `npm ci` correcto, `npm run typecheck` correcto, `npm test` correcto (`24` archivos, `226` tests), `npm run build` correcto.
- `npm audit` ejecutado: quedan `18` vulnerabilidades (`12` low, `4` moderate, `2` high); no se aplicó `npm audit fix --force`.
- Etiqueta creada y publicada: `pre-autonomy-hardening`.

---

# P1 — Propagar `intent: ENTRY | EXIT` correctamente

## Problema que se corrige

Actualmente `intent` puede existir en el esquema MCP, pero debe conservarse de forma inmutable en todo el recorrido. Si se pierde en algún punto, una venta de salida vuelve a evaluarse como una entrada y puede fallar por edge, presupuesto o límites de exposición.

## Cambios obligatorios

### `src/domain/types.ts`

- [x] Hacer `intent` obligatorio, no opcional:

```ts
export type OrderIntentType = "ENTRY" | "EXIT";

export interface OrderIntent {
  intent: OrderIntentType;
  // ...
}

export interface OrderProposal {
  intent: OrderIntentType;
  // ...
}
```

### `src/mcp/schemas.ts`

- [x] Mantener `intent` obligatorio en `stageOrderInputSchema`.
- [x] Añadir `intent` a `orderProposalSchema` y a la salida de `stage_order`.
- [x] Rechazar combinaciones incoherentes:
  - `ENTRY + SELL` sin una posición explícita que se esté reduciendo;
  - `EXIT + BUY` para posiciones largas de outcomes;
  - `EXIT` sin `exitReason`.

### `src/runtime.ts`

- [x] Pasar `input.intent` a `TradingService.stageOrder`.
- [x] Incluir `intent` en `proposalOutput`.

### `src/application/ports.ts`

- [x] Hacer obligatorio `intent` en `StageOrderInput`.
- [x] Añadir `exitReason` cuando `intent === "EXIT"`.

### `src/application/trading-service.ts`

- [x] Incluir `intent` al crear `OrderIntent`.
- [x] Incluir `intent` durante la revalidación previa a firma.
- [x] Prohibir cualquier cambio de `intent` tras staging.

### `src/domain/proposals.ts`

- [x] Guardar `intent` en `OrderProposal`.
- [x] Incluirlo en el material canónico del hash.

## Pruebas mínimas

- [x] Una propuesta `ENTRY` conserva `ENTRY` desde MCP hasta el payload firmado.
- [x] Una propuesta `EXIT` conserva `EXIT` desde MCP hasta el payload firmado.
- [x] Modificar `intent` después de staging invalida el hash.
- [x] Una salida no se bloquea por `EDGE_TOO_SMALL`.
- [x] Una entrada sí sigue requiriendo edge mínimo.

## Evidencia de completado

- `intent` es obligatorio en los tipos de dominio, el puerto de aplicación y el esquema MCP.
- `ENTRY` solo acepta `BUY`; `EXIT` solo acepta `SELL` y exige una razón explícita.
- `intent` y `exitReason` se conservan en la propuesta y forman parte del hash canónico.
- La revalidación previa a firma rechaza hashes inválidos y vuelve a evaluar el mismo `intent` y `exitReason`.
- Cobertura añadida en los tests de dominio y contrato MCP para entradas, salidas, incoherencias, salida sin edge y mutación del hash.
- Verificación: `npm run typecheck` correcto, `npm test` correcto (`24` archivos, `230` tests), `npm run build` correcto.

## Criterio de aceptación

No existe ninguna ruta que convierta implícitamente una salida en una entrada.

---

# P2 — Autorización humana de presupuesto por sesión

## Diseño recomendado

Usar un flujo de dos pasos. El agente puede preparar la sesión, pero **no puede activarla solo**.

```text
prepare_trading_session
        ↓
agente pregunta: “¿Cuántos pUSD autorizas para esta sesión?”
        ↓
persona responde con una cantidad
        ↓
confirmación local de una sola vez
        ↓
activate_trading_session
```

La confirmación es **una vez por sesión**, no por orden.

## Nuevas herramientas MCP

### `prepare_trading_session`

Debe ser de solo lectura y devolver:

```ts
{
  pendingSessionId: string;
  executionMode: "paper" | "live";
  cashAvailablePusd: string | null;
  openExposurePusd: string;
  hardCeilingRemainingPusd: string;
  dailyStopRemainingPusd: string;
  maximumAuthorizablePusd: string;
  challenge: string;
  expiresAt: string;
}
```

Reglas:

- [x] En live, si el efectivo real es desconocido, responder con bloqueo.
- [x] No usar un fallback de 100 pUSD.
- [x] El challenge debe ser aleatorio, de un solo uso y de corta duración.
- [x] No debe existir todavía una sesión activa.

### Confirmación local de una sola vez

Opciones admitidas:

- CLI local:

```bash
npm run session:authorize -- \
  --pending <id> \
  --amount 25 \
  --challenge ABC123
```

- O formulario loopback dedicado exclusivamente a **activar la sesión**, nunca a aprobar órdenes.

La confirmación debe persistir:

```ts
{
  pendingSessionId,
  amountMicros,
  challengeHash,
  confirmedAtMs,
  consumedAtMs: null
}
```

### `activate_trading_session`

- [x] Consume atómicamente la confirmación local.
- [x] Crea la sesión activa.
- [x] No acepta una cantidad diferente de la confirmada.
- [x] No permite ampliar una sesión activa.
- [x] Una nueva sesión requiere una nueva confirmación humana.

### `get_trading_session`

Devuelve presupuesto, restante, uso, expiración y estado.

### `end_trading_session`

Cierra la sesión y no devuelve presupuesto al agente para crear otra automáticamente.

## Límite efectivo

El presupuesto autorizado debe ser:

```text
min(
  cantidad confirmada por la persona,
  efectivo real disponible,
  capacidad bajo el techo duro,
  capacidad bajo el límite canary/piloto,
  capacidad restante bajo el stop diario
)
```

## Duración

- [x] Valor inicial recomendado: 8 horas.
- [x] Máximo permitido en esquema: 24 horas.
- [x] No aceptar duración arbitrariamente grande.

## Criterio de aceptación

El agente no puede iniciar, renovar ni ampliar una sesión sin una nueva acción humana local verificable.

## Evidencia de completado

- Se eliminaron `start_trading_session` y `get_session_status` del contrato MCP. La ruta paper auxiliar tampoco crea sesiones automáticamente.
- `prepare_trading_session` calcula la capacidad con efectivo real, exposición abierta, techo duro, stop diario y límite canary/piloto; live se bloquea si el efectivo es desconocido.
- El challenge se genera aleatoriamente, caduca en 10 minutos y solo se persiste como SHA-256.
- `session:authorize` valida challenge, importe máximo y ausencia de sesión activa; `activate_trading_session` consume la autorización y crea la sesión en una transacción SQLite atómica.
- La activación revalida la capacidad actual y rechaza cualquier importe confirmado que ya no sea seguro; no existe ampliación automática.
- Verificación: `npm run typecheck` correcto, `npm test` correcto (`24` archivos, `232` tests), `npm run build` correcto.

---

# P3 — Vincular propuesta y sesión de forma inmutable

## Cambios de dominio

Añadir a `OrderProposal`:

```ts
sessionId: string | null;
```

Reglas:

- `ENTRY` live: `sessionId` obligatorio.
- `EXIT` live: puede usar `sessionId = null`, porque reduce riesgo y no consume presupuesto de entrada.
- `sessionId` debe formar parte del hash de la propuesta.

## Staging

Al crear una entrada:

- [x] recuperar la sesión activa;
- [x] copiar su ID a la propuesta;
- [x] validar que sigue activa;
- [x] reservar `maxLossMicros`, no solo `maxCostMicros`;
- [x] no descontar todavía el presupuesto si el staging falla.

## Ejecución atómica

`claimAutonomousExecution` debe comprobar, dentro de `BEGIN IMMEDIATE`:

```text
proposal existe
proposal.status === STAGED
proposal.hash coincide
verifyProposalHash(proposal) === true
proposal.executionMode === live
proposal no ha caducado
policyVersion sigue vigente
ENTRY → proposal.sessionId coincide con sesión activa
ENTRY → sesión activa, no expirada y con saldo suficiente
EXIT → no aumenta exposición y no necesita presupuesto de entrada
```

Después, dentro de la misma transacción:

```text
reservar presupuesto ENTRY
crear execution record
cambiar propuesta a EXECUTING
commit
```

## Reintentos

- [x] Repetir `execute_staged_order` con el mismo ID/hash no crea otra orden.
- [x] Una propuesta `EXECUTING` o `SUBMITTED` no puede reclamarse de nuevo.
- [x] Una propuesta creada bajo una sesión no puede ejecutarse bajo una sesión posterior.

## Pruebas

- [x] Sesión A prepara propuesta; se cierra A; se crea B; la propuesta de A queda bloqueada.
- [x] Dos procesos reclaman simultáneamente la misma propuesta; solo uno gana.
- [x] La comisión hace que `maxLoss` supere el presupuesto; la orden queda bloqueada.
- [x] Una salida no descuenta presupuesto de entrada.

## Evidencia de completado

- `OrderProposal.sessionId` es obligatorio, nullable y forma parte del hash inmutable; las salidas live pueden usar `null` y las entradas live copian la sesión activa. La política rechaza cualquier `ENTRY` live sin sesión.
- El staging valida el presupuesto contra `maxLossMicros` sin descontarlo hasta el claim; si falla, no persiste ninguna reserva.
- `claimAutonomousExecution` valida hash, estado, expiración, versión de política, sesión exacta, saldo y coherencia de salida dentro de `BEGIN IMMEDIATE`; reserva presupuesto y crea el execution record en la misma transacción.
- La ruta heredada de ejecución local aplica las mismas comprobaciones de hash, versión y sesión para entradas live; las salidas no consumen presupuesto de entrada.
- Se añadieron pruebas de sesión cruzada tras reinicio, claim one-shot, comisión sobre `maxLoss` y salida sin sesión activa.
- Verificación: `npm run typecheck` correcto, `npm test` correcto (`25` archivos, `236` tests), `npm run build` correcto.

---

# P4 — Ruta de salida real y segura

## Modelo de salida

Añadir a la propuesta:

```ts
exitReason?:
  | "STOP_LOSS_TRIGGERED"
  | "TAKE_PROFIT_TRIGGERED"
  | "MAX_DURATION_EXPIRED"
  | "EDGE_DISAPPEARED";
```

## Reglas de `EXIT`

Una salida debe:

- [x] ser `SELL`;
- [x] reducir una posición real y liquidada;
- [x] no superar `heldSharesMicros`;
- [x] tener snapshot fresco;
- [x] usar un precio límite igual o mejor que el bid aprobado;
- [x] respetar tick, fees, geoblock, identidad y contrato;
- [x] no exigir edge positivo;
- [x] no exigir profundidad 5× como una entrada;
- [x] no consumir presupuesto de entrada;
- [x] no permitir ventas descubiertas;
- [x] no permitir vender acciones ya reservadas en otra salida pendiente.

## Reservas de acciones

Añadir una reserva transaccional:

```ts
reservedExitSharesMicros
```

La reserva live se guarda en SQLite junto con el staging, dentro de `BEGIN IMMEDIATE`, y se libera o reduce al reconciliar el execution record.

La disponibilidad debe calcularse como:

```text
acciones liquidadas
- acciones ya reservadas en órdenes de salida abiertas
```

## Ejecución del supervisor

Cuando se dispara una salida:

1. obtener snapshot fresco;
2. comprobar mejor bid;
3. crear propuesta `EXIT`;
4. reclamarla atómicamente;
5. enviar GTD limitada;
6. guardar `proposalId`, `orderId` y estado;
7. marcar `CLOSING` solo cuando `accepted === true` y exista execution record;
8. reconciliar fills parciales;
9. mantener como posición únicamente la cantidad realmente llenada o restante.

## Criterio de aceptación

Una posición que alcanza un stop genera una venta limitada real con tamaño máximo igual a las acciones liquidadas disponibles, y el ledger refleja el resultado exacto.

## Evidencia de completado

- `stageOrder` vuelve a consultar la posición liquidada antes de reservar una salida live; `TradingDatabase.stageProposal` impide carreras y rechaza reservas que superen las acciones disponibles.
- El precio de una salida live no puede superar el `bestBidMicros` del snapshot fresco; tick, tamaño mínimo, fees, reglas, contrato, geoblock e identidad siguen pasando por las validaciones normales de riesgo y preflight.
- `updateExecutionStatus` reduce la reserva con fills parciales y la libera en estados terminales; un fallo de submission también libera la reserva.
- El supervisor solo marca `CLOSING` si la ejecución fue aceptada y existe el execution record; una ejecución bloqueada conserva la posición en su estado anterior.
- Verificación parcial: `npm run typecheck` correcto y las pruebas P4 de reservas, fills parciales y supervisor rechazado pasan (`3` tests nuevos).

---

# P5 — Rehacer el supervisor de posiciones

## Campos que deben separarse

Modificar `PositionRecord`:

```ts
openedAtMs: number;
lastEvaluatedAtMs: number;
lastMarketPriceMicros: bigint;
lastEstimatedProbabilityMicros: bigint | null;
lastResearchBundleId: string | null;
entryProbabilityMicros: bigint | null;
entryEdgeMicros: bigint | null;
exitState: ExitState;
activeExitProposalId: string | null;
activeExitOrderId: string | null;
```

Nunca usar el precio del mercado como sustituto silencioso de una probabilidad estimada.

## Política conservadora

### Stop-loss

```text
precio actual <= 70 % del precio medio de entrada
→ salida completa
```

### Take-profit

```text
precio actual >= 150 % del precio medio de entrada
→ salida completa
```

### Tiempo máximo

```text
posición abierta >= 14 días
→ salida completa
```

### Pérdida de edge

```text
edge actual < 50 % del edge mínimo vigente
O edge actual < 0
→ salida completa
```

Esta regla solo puede ejecutarse con una probabilidad nueva y un research bundle válido.

### Movimiento del 20 %

```text
abs(precio actual - último precio evaluado) / último precio evaluado >= 20 %
→ RESEARCH_REQUIRED inmediato
```

No vender únicamente por el movimiento del 20 %, salvo que también se active stop-loss, take-profit o tiempo máximo.

### Menos de 24 horas para resolver

```text
bloquear salidas por edge y tiempo
permitir únicamente la política definida explícitamente para emergencia
por defecto: HOLD_UNTIL_RESOLUTION
```

### GTD no llenada

- caduca a los 15 minutos;
- se concilia antes de declarar final;
- no se reprecifica;
- el siguiente ciclo debe crear una oportunidad nueva desde cero.

## Orden de evaluación

```text
1. reconciliar órdenes y fills
2. actualizar tamaño real
3. comprobar <24h hasta resolución
4. comprobar stop-loss
5. comprobar take-profit
6. comprobar 14 días
7. comprobar movimiento del 20 %
8. comprobar research bundle reciente
9. comprobar pérdida de edge
10. persistir resultado
```

## Evidencia de completado

- `PositionRecord` separa `lastMarketPriceMicros`, `lastEstimatedProbabilityMicros`, `lastResearchBundleId`, probabilidades/edge de entrada y los IDs de la salida activa; los registros antiguos se normalizan sin convertir silenciosamente el precio en probabilidad.
- El supervisor aplica stop-loss al 70%, take-profit al 150%, duración máxima de 14 días y conserva `HOLD_UNTIL_RESOLUTION` durante la ventana de 24 horas.
- Un movimiento de precio del 20% produce `RESEARCH_REQUIRED` sin vender; la pérdida de edge queda bloqueada hasta recibir probabilidad y bundle de research válidos.
- La salida usa probabilidad `0` cuando aún no existe estimación, únicamente como valor neutro de transporte para `EXIT`; nunca reutiliza el precio de mercado como probabilidad.
- Verificación: `npm run typecheck` correcto y `test/position-supervisor.test.ts` pasa con cobertura de thresholds, ausencia de fallback, bundle requerido y shock del 20%.

---

# P6 — Verificación real de investigación y fuentes

## Principio

Una URL declarada por el modelo no es evidencia. El servidor debe recuperar y validar la fuente.

## Nuevo `ResearchBundle`

```ts
interface ResearchBundle {
  id: string;
  marketConditionId: string;
  tokenId: string;
  estimatedProbabilityMicros: bigint;
  eventVolatilityClass: "SLOW" | "FAST";
  createdAtMs: number;
  expiresAtMs: number;
  sources: VerifiedSource[];
  rationale: string;
  counterRationale: string;
  contentHash: string;
}
```

```ts
interface VerifiedSource {
  requestedUrl: string;
  finalUrl: string;
  registrableDomain: string;
  publisher: string;
  title: string;
  publishedAtMs: number;
  retrievedAtMs: number;
  httpStatus: number;
  contentType: string;
  excerptHash: string;
  responseBodyHash: string;
}
```

## Verificación del servidor

- [x] HTTPS obligatorio.
- [x] Resolver redirects con límite pequeño.
- [x] Bloquear IPs privadas, loopback, link-local y metadata endpoints.
- [x] Limitar tamaño de respuesta y tiempo de descarga.
- [x] Exigir `2xx` y contenido HTML/texto admitido.
- [x] Extraer título y fecha desde la respuesta, no confiar solo en el input.
- [x] Exigir dos dominios registrables independientes.
- [x] Rechazar Polymarket como evidencia de probabilidad.
- [x] Permitir Polymarket únicamente para reglas del mercado.
- [x] Ventana máxima:
  - `SLOW`: 7 días;
  - `FAST`: 48 horas.
- [x] Guardar hashes, no el artículo completo.
- [x] Rechazar fuentes que no puedan recuperarse o verificarse.

## Relación con la probabilidad

El bundle debe guardar:

- probabilidad final;
- metodología resumida;
- factores a favor;
- factores en contra;
- cambio respecto al bundle anterior;
- causa cuantitativa del cambio.

No se permite que el supervisor cree URLs sintéticas para aprobarse a sí mismo.

## Criterio de aceptación

Dos URLs inexistentes con dominios de Reuters/AP no superan la validación.

## Evidencia de completado

- `prepare_research_bundle` recupera fuentes con HTTPS, límite de redirects, DNS/IP público, timeout, límite de 2 MB, `2xx` y content types HTML/texto; extrae título, publisher y fecha de la respuesta.
- Se persisten únicamente metadatos y hashes en `research_bundles`; el cuerpo del artículo no entra en SQLite ni en la respuesta MCP.
- Las fuentes Polymarket están bloqueadas como evidencia, se exigen dos dominios registrables distintos y las ventanas son 7 días (`SLOW`) o 48 horas (`FAST`).
- Una `ENTRY` live requiere un bundle vigente que coincida con mercado y probabilidad; el supervisor consume el último bundle no expirado y no genera URLs sintéticas para las salidas.
- Verificación: `npm run typecheck` correcto y `test/research-verifier.test.ts` cubre fuentes válidas, páginas inexistentes, HTTPS, SSRF, redirects, content type, antigüedad, hashes y persistencia.

---

# P7 — Supervisor persistente de reducción de riesgo

## Arquitectura

Separar dos procesos:

### MCP del agente

Puede:

- analizar;
- preparar investigación;
- abrir entradas con sesión autorizada;
- consultar cartera;
- solicitar supervisión.

### `position-supervisor`

Proceso persistente iniciado por `launchd` que puede:

- consultar cartera;
- reconciliar órdenes;
- cancelar órdenes;
- ejecutar únicamente propuestas `EXIT`;
- activar emergency stop.

Nunca puede:

- crear sesiones de entrada;
- abrir posiciones;
- aumentar exposición;
- modificar límites;
- obtener firma para otro tipo de payload.

## Comandos

Añadir a `package.json`:

```json
{
  "supervisor:start": "node dist/supervisor/main.js",
  "supervisor:dev": "tsx src/supervisor/main.ts",
  "supervisor:install": "tsx src/cli/install-supervisor.ts"
}
```

## Cadencia

- ciclo normal: cada 60 segundos;
- reconciliación activa: cada 5–15 segundos mientras haya órdenes abiertas;
- evento de precio ≥20 %: reevaluación prioritaria;
- backoff con jitter ante fallos;
- heartbeat local persistente;
- lock de proceso para impedir dos supervisores simultáneos.

## Criterio de aceptación

Cerrar Antigravity no detiene stop-loss, take-profit, reconciliación ni cancelación de riesgo.

## Evidencia de completado

- [x] `src/supervisor/main.ts` ejecuta el ciclo de reconciliación y reducción de riesgo en un proceso separado del MCP.
- [x] El supervisor no crea sesiones, no prepara entradas y no expone una ruta de firma; solo invoca la reconciliación live y `EXIT` de `supervisePositions`.
- [x] `SupervisorProcessLock` impide dos instancias y recupera locks cuyo PID ya no existe.
- [x] El heartbeat se persiste en `system_state` con estado, PID, ciclo, fallos y próxima ejecución; no registra mensajes externos ni secretos.
- [x] La cadencia es de 60 segundos en reposo, 5–15 segundos durante reconciliación activa o tras un movimiento que exige nueva investigación, y usa backoff con jitter ante fallos.
- [x] `supervisor:install` genera un LaunchAgent sin variables de entorno ni credenciales y lo registra con `launchctl` en la sesión del usuario.
- [x] Verificación: `npm run typecheck`, `npm run build` y `npm test` correctos (`28` archivos, `248` tests); `test/supervisor.test.ts` cubre lock, recuperación, cadencia, heartbeat y plist.

---

# P8 — Importar posiciones heredadas

## Herramienta

Añadir:

```text
import_legacy_position
```

## Proceso

Para cada posición no conocida:

1. consultar actividad pública;
2. consultar ledger local;
3. consultar órdenes y fills reconciliados;
4. reconstruir:
   - fecha de entrada;
   - precio medio;
   - acciones liquidadas;
   - fees;
   - transaction hashes;
5. marcar la calidad de evidencia.

## Estados

```ts
"VERIFIED"
"PARTIALLY_VERIFIED"
"LEGACY_UNVERIFIED"
```

Reglas:

- `VERIFIED`: entra en la política automática completa.
- `PARTIALLY_VERIFIED`: admite stop-loss/take-profit basados en precio medio verificable, pero no salida por edge.
- `LEGACY_UNVERIFIED`: no se vende automáticamente; requiere decisión local explícita.

## Posición de Macron

- [ ] Reconstruir el fill real y la fecha.
- [ ] No inventar edge, fuentes ni fecha.
- [ ] Emitir un informe de importación.
- [ ] Tras la importación, aplicar la política correspondiente a la calidad de evidencia.

---

# P9 — Eliminar arquitectura heredada

## Eliminar o retirar

- [ ] `beginExecution` basado en `AWAITING_LOCAL`.
- [ ] `executeLocallyApproved`.
- [ ] `ApprovalUrlPort`.
- [ ] tabla y modelo `LocalApproval` si ya no se usa para autorización de sesión.
- [ ] estados de propuesta:
  - `AWAITING_LOCAL`
  - `LOCALLY_APPROVED`
- [ ] alias `ApprovalHttpServer`.
- [ ] textos que hablen de confirmación manual por orden.

## Dashboard

- [ ] Iniciar `DashboardHttpServer` en el arranque normal del runtime.
- [ ] Mantenerlo solo en `127.0.0.1`.
- [ ] Permitir solo `GET`.
- [ ] Mostrar:
  - estado;
  - sesiones;
  - posiciones;
  - research bundles;
  - órdenes;
  - PnL;
  - locks;
  - última reconciliación.
- [ ] No exponer acciones financieras.

## Documentación

Actualizar:

- `README.md`
- `AGENTS.md`
- `.env.example`
- `.codex/config.toml`
- documentación de Antigravity

La documentación debe describir exactamente el código vigente.

---

# P10 — Pruebas de integración y seguridad

## Pruebas obligatorias

### Sesiones

- [ ] El agente no puede activar una sesión sin confirmación local.
- [ ] Un challenge se consume una sola vez.
- [ ] Una sesión no puede ampliarse.
- [ ] Una sesión caducada bloquea entradas.
- [ ] Balance desconocido bloquea live.
- [ ] La propuesta está ligada a la sesión que la creó.

### Entradas

- [ ] `ENTRY` exige sesión, edge, profundidad, spread y límites.
- [ ] `maxLossMicros` incluye fees.
- [ ] Cambio de fee invalida la propuesta.
- [ ] Cambio de precio/tamaño/mercado/outcome invalida el hash.

### Salidas

- [ ] `EXIT` no consume presupuesto de entrada.
- [ ] `EXIT` solo reduce posición.
- [ ] No permite vender más de lo poseído.
- [ ] Dos salidas concurrentes no reservan las mismas acciones.
- [ ] Stop-loss crea y envía una venta con doble control.
- [ ] Take-profit crea y envía una venta con doble control.
- [ ] 14 días crea salida.
- [ ] <24h mantiene hasta resolución.
- [ ] Fill parcial actualiza la posición restante.
- [ ] Una ejecución fallida no marca `CLOSING`.

### Supervisor

- [ ] Antigravity cerrado no detiene el supervisor.
- [ ] Dos instancias no pueden ejecutarse a la vez.
- [ ] Movimiento del 20 % genera `RESEARCH_REQUIRED`.
- [ ] No confunde precio con probabilidad.

### Fuentes

- [ ] URL inexistente se rechaza.
- [ ] Redirect a IP privada se rechaza.
- [ ] Fuente antigua se rechaza.
- [ ] Fecha futura se rechaza.
- [ ] Dos subdominios del mismo editor no cuentan como independientes.
- [ ] Polymarket no cuenta como fuente de probabilidad.
- [ ] Research bundle modificado invalida su hash.

### Concurrencia e idempotencia

- [ ] Dos claims concurrentes → una única ejecución.
- [ ] Reinicio durante `EXECUTING` → lock persistente.
- [ ] Timeout tras POST incierto → no reenvía; primero reconcilia.
- [ ] La misma propuesta nunca produce dos órdenes CLOB.

## CI

Añadir etapas:

```text
npm ci
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
secret scan
integration tests
```

No usar claves reales ni endpoints de producción en CI.

---

# P11 — Despliegue gradual

## Fase A — Paper completo

Duración mínima recomendada: 14 días adicionales después de implementar el nuevo motor.

Validar:

- entradas;
- salidas;
- fills parciales;
- sesiones;
- supervisor persistente;
- reinicios;
- research bundles;
- stops;
- conciliación.

## Fase B — Shadow live

- datos live;
- firma y POST deshabilitados;
- registrar qué habría hecho;
- comparar contra movimientos reales;
- revisar falsos positivos y falsas salidas.

Duración recomendada: 7 días.

## Fase C — Canary real

- presupuesto de sesión inicial: 5 pUSD;
- máximo por orden: 1 pUSD durante las primeras 5 operaciones del código nuevo;
- una sola posición simultánea;
- sin `PAPER_GATE_SKIP`;
- revisión manual diaria del ledger.

## Fase D — Canary normal

Solo tras cero incidentes:

- máximo 5 pUSD por orden;
- máximo 20 pUSD de exposición;
- límites duros sin cambios.

---

# Gate final para live

No activar live hasta que todas estas casillas estén completas:

- [ ] `intent` es obligatorio, persistido, hasheado y revalidado.
- [ ] `sessionId` está ligado a la propuesta y a su hash.
- [ ] La sesión requiere confirmación humana local una vez por sesión.
- [ ] El agente no puede ampliar o renovar presupuesto autónomamente.
- [ ] El balance desconocido bloquea live.
- [ ] El presupuesto reserva `maxLossMicros`, incluidas las fees.
- [ ] `EXIT` no consume presupuesto de entrada.
- [ ] `EXIT` solo reduce acciones reales disponibles.
- [ ] Stop-loss, take-profit y 14 días envían ventas limitadas reales.
- [ ] <24h mantiene hasta resolución según política.
- [ ] El supervisor no confunde precio con probabilidad.
- [ ] No existen fuentes inventadas o URLs decorativas en código.
- [ ] Las fuentes se recuperan y verifican desde el servidor.
- [ ] Existe supervisor persistente que solo reduce riesgo.
- [ ] La posición de Macron está importada o explícitamente excluida.
- [ ] No queda arquitectura de aprobación por orden heredada.
- [ ] Dashboard iniciado y estrictamente de solo lectura.
- [ ] Pruebas de integración de entrada y salida pasan.
- [ ] CI completa en verde.
- [ ] `npm audit` no presenta vulnerabilidades altas sin evaluar.
- [ ] Escaneo de secretos limpio.
- [ ] Paper soak y shadow live completados sin incidentes.

---

# Orden recomendado de commits

```text
1. fix(domain): make ENTRY/EXIT mandatory and hash-bound
2. feat(session): add prepare/confirm/activate session authorization
3. feat(storage): bind proposal to session and reserve maxLoss atomically
4. feat(exit): implement position-reducing EXIT execution path
5. refactor(supervisor): separate market price from estimated probability
6. feat(research): fetch and verify source evidence bundles
7. feat(supervisor): add persistent risk-reduction daemon
8. feat(legacy): reconcile and import existing positions
9. refactor(core): remove local per-order approval architecture
10. test(integration): cover autonomous entry, exit, restart and concurrency
11. docs: align README, AGENTS and MCP contracts
12. chore(release): paper soak and canary deployment checklist
```

---

# Definición de terminado

El proyecto estará listo para una prueba live controlada cuando:

1. ninguna entrada pueda ocurrir sin un presupuesto humano vigente;
2. ninguna salida necesite ese presupuesto para reducir riesgo;
3. cada decisión de edge tenga fuentes recuperadas y verificables;
4. cada propuesta esté ligada a una sesión, hash y política concretos;
5. cada posición tenga una estrategia de salida ejecutable y reconciliada;
6. un reinicio, timeout o respuesta ambigua bloquee antes de reenviar;
7. Antigravity pueda cerrarse sin desactivar la protección de posiciones;
8. la CI pruebe los flujos completos y no solo funciones aisladas.

> Este plan mejora la seguridad y la corrección operativa, pero no garantiza rentabilidad. La calidad económica seguirá dependiendo de la estimación de probabilidades, la liquidez, las comisiones, la latencia y la resolución de cada mercado.
