# Codex + Polymarket con controles de ejecución

Servidor MCP local en TypeScript para consultar Polymarket, simular operaciones y, solo cuando se cumplen todas las barreras, enviar órdenes limitadas de forma autónoma dentro de un presupuesto de sesión autorizado.

Este proyecto no promete beneficios. Las estimaciones pueden ser erróneas, los mercados pueden moverse y se puede perder todo el capital asignado al piloto.

## Qué hace

El servidor expone por `stdio` estas herramientas MCP:

| Herramienta | Efecto |
| --- | --- |
| `get_account_status` | Estado de la cuenta, modo, Keychain, bloqueo de emergencia y progreso de paper trading. |
| `get_portfolio` | Posiciones y PnL de la dirección pública configurada. |
| `scan_candidates` | Mercados de política, economía y tecnología. No estima el edge por sí solo. |
| `get_market_snapshot` | Reglas, fuente de resolución, libro, tick, fees, liquidez y geoblock. |
| `get_risk_status` | Límites inmutables, exposición, PnL diario y estado del piloto. |
| `get_order_status` | Último estado, fills y fees validados y guardados en el ledger local. |
| `prepare_trading_session` | Calcula capacidad y prepara una autorización efímera; no activa una sesión ni expone un challenge. |
| `activate_trading_session` | Consume una autorización local única y activa su presupuesto exacto. |
| `get_trading_session` | Presupuesto autorizado, uso, restante, estado y expiración de la sesión. |
| `stage_order` | Valida y persiste una propuesta inmutable; no firma ni envía. |
| `execute_staged_order` | Ejecuta de forma autónoma una propuesta staged si cumple las reglas de riesgo, presupuesto de sesión y barreras live. |
| `cancel_order` | Solicita cancelar una orden concreta; no declara el estado terminal sin conciliación. |
| `emergency_stop` | Bloquea la operativa y solicita cancelar todas las órdenes conocidas. Exige `CANCEL_ALL_AND_LOCK`. |
| `prepare_market_evidence` | Captura CLOB/Gamma frescos como evidencia de dos orígenes y con hashes; no usa noticias. |
| `start_agent_run` | Adquiere el único lease corto `agent-supervised` tras autorizar live. |
| `heartbeat_agent_run` | Renueva el lease mientras la conversación sigue activa. |
| `get_agent_run` | Consulta el propietario y la caducidad del lease. |
| `stop_agent_run` | Detiene el lease, activa emergency stop y solicita cancelación de mejor esfuerzo. |

No hay herramientas MCP para leer secretos, firmar mensajes arbitrarios, depositar, retirar, cambiar allowances, subir capital o relajar límites.

## Flujo de seguridad

```text
Codex / Antigravity / Claude Code analiza la oportunidad y valida dos orígenes de datos de mercado independientes (CLOB y Gamma)
    ↓
Se verifica sesión activa de trading con presupuesto pUSD autorizado
    ↓
stage_order valida límites de riesgo y techos duros, y genera la propuesta inmutable + SHA-256
    ↓
execute_staged_order reclama la propuesta en una única transacción SQLite atómica, descuenta el presupuesto y valida el preflight
    ↓
Re-validación de geoblock, mercado, tick, negRisk, comisiones y hard ceilings
    ↓
Firmante restringido autoriza únicamente esa orden EIP-712 GTD
    ↓
PositionSupervisor monitoriza automáticamente posiciones abiertas (stop-loss 30 %, take-profit 50 %, 14 días máx). El supervisor local también ejecuta cada 10 segundos el escáner determinista de entradas: solo usa ResearchBundles verificados, historial de snapshots de 1/5/15 minutos y el libro actual; sin bundle vigente o sin historial suficiente la decisión es no operar.
```

El servidor local en `127.0.0.1` funciona como un dashboard de solo lectura para monitorización (estado, posiciones, PnL, presupuesto y ledger). No expone acciones de aprobación ni firma manual.

`POLYMARKET_LIVE_ENABLED=true` nunca basta para operar. La ejecución real también requiere activación persistida local de una sesión con presupuesto, superar la fase paper, correspondencia entre signer/funder/perfil, credenciales protegidas, ausencia de parada de emergencia, propuesta staged vigente y preflight final satisfactorio. Una respuesta de geoblock bloqueada, desconocida o antigua impide el envío.

## Fases

### 1. Lectura

Configura únicamente la dirección pública del perfil. Gamma API, Data API y CLOB aportan mercados, libro y posiciones públicas. No se necesita clave privada para esta fase.

### 2. Paper trading

Las propuestas paper consumen la liquidez visible del snapshot hasta el precio límite, incluyendo fills parciales, fees y slippage medido contra los niveles ejecutables. El modelo `paper-fill-v1` conserva el hash del snapshot, la probabilidad de fill, el draw determinista, el slippage y la semilla; no se presume un fill perfecto para órdenes que no cruzan el libro.

El `PaperSimulationRunner` permite reproducir lotes fechados sin modificar propuestas existentes. Cada frame debe incluir una propuesta paper intacta y exactamente el snapshot hasheado en ella. El runner exige orden temporal, rechaza duplicados, persiste una auditoría por frame y marca si se cubren al menos 50 operaciones durante 30 días. El resultado económico sigue dependiendo de la reconciliación fresca del ledger; el runner no puede inyectar PnL ni saltarse la puerta.

La puerta hacia live exige conjuntamente:

- al menos 30 días desde la primera operación simulada;
- al menos 50 operaciones simuladas;
- PnL neto positivo;
- drawdown máximo no superior a 10 pUSD;
- cero incumplimientos de riesgo;
- cero errores de reconciliación.

No habilites live basándote solo en el número de operaciones. Revisa también la calidad de los datos y la cadena de auditoría.

### 3. Live bloqueado

El alta local importa la clave social mediante una ventana nativa con campo oculto. La clave no se pasa como argumento, variable de entorno ni texto del terminal. El helper la guarda como elemento no sincronizable del Llavero de macOS, protegido por presencia del usuario y ligado al dispositivo. Las credenciales L2 también pertenecen al Llavero.

El proceso solo carga la clave de forma transitoria para una firma autorizada y borra el buffer después. El firmante restringido acepta únicamente autenticación CLOB y órdenes EIP-712 con `chainId 137`, identidad esperada, contrato permitido, importes máximos y permiso de un solo uso. Para cuentas sociales se admiten `POLY_PROXY` (tipo 1) y `POLY_1271` (tipo 3).

Antes del POST se comprueba que el hash EIP-712 visto por ese firmante coincide con el hash V2 preparado localmente y con el `orderID` devuelto por el CLOB. Tras el envío, la conciliación exige convergencia entre REST CLOB, User WebSocket autenticado, Data API, cartera pública y recibos finalizados y canónicos observados por dos orígenes RPC de Polygon distintos.

### 4. Canary y piloto

Las primeras 5 operaciones live usan como máximo 1 pUSD por orden y una sola posición simultánea. Después se mantienen los límites canary existentes; no hay promoción automática al piloto:

| Control | Canary | Piloto |
| --- | ---: | ---: |
| Capital asignado | 100 pUSD | 100 pUSD |
| Máximo por orden | 5 pUSD | 10 pUSD |
| Exposición abierta total | 20 pUSD | 50 pUSD |
| Máximo por mercado o evento correlacionado | 25 pUSD | 25 pUSD |
| Mercados simultáneos | 5 | 5 |
| Parada diaria | 10 pUSD | 10 pUSD |

Al alcanzar la parada diaria, el bloqueo es persistente y no se libera de forma automática. Deben transcurrir al menos 24 horas y completarse una revisión local antes de considerar una reactivación.

Además, una propuesta debe cumplir:

- categoría `politics`, `economics` o `technology`;
- edge estimado mínimo de 0,05 después de costes;
- spread máximo de 0,03;
- profundidad al precio límite de al menos cinco veces el riesgo de la orden;
- snapshot de menos de cinco segundos;
- más de 24 horas hasta el cierre;
- reglas y fuente de resolución presentes;
- ninguna información confidencial ni capacidad de influir en el resultado;
- ventas no superiores a la posición disponible.

Las órdenes live son limitadas GTD con 15 minutos efectivos. No hay repricing automático, batches, apalancamiento, martingala ni persecución de pérdidas. El heartbeat CLOB se encadena cada cinco segundos; su pérdida activa cancelación de mejor esfuerzo y el sistema debe permanecer bloqueado hasta una revisión explícita.

## Requisitos

- macOS con código de acceso y Llavero disponible.
- Node.js 22 o posterior.
- npm.
- Xcode Command Line Tools para compilar el helper Swift.

## Instalación y verificación

```bash
npm ci
npm run keychain:build
npm run typecheck
npm test
npm run build
```

Tras completar los gates operativos, el proceso persistente se instala en la
sesión de macOS con `npm run supervisor:install`. `launchd` mantiene una sola
instancia, heartbeat y backoff; Codex/MCP solo consulta el dashboard local y
puede activar el emergency stop. La instalación no activa live ni crea una
sesión: ambas acciones siguen siendo una autorización local explícita.

La configuración MCP incluida espera el artefacto `dist/mcp/server.js`. No inicies el servidor desde una terminal que imprima datos de autenticación y no redirijas su `stdout`: en modo MCP se reserva exclusivamente para JSON-RPC.

El checklist operativo para paper soak, shadow live y canary está en [`RUNBOOK_PILOTO.md`](RUNBOOK_PILOTO.md). Sus casillas no se consideran completadas por ejecutar la suite automatizada.

Scripts declarados en `package.json`:

| Comando | Uso |
| --- | --- |
| `npm run dev` | Servidor MCP desde TypeScript. |
| `npm run clean` | Elimina únicamente el directorio generado `dist/`. |
| `npm run build` | Compilación TypeScript. |
| `npm start` | Servidor MCP compilado. |
| `npm run typecheck` | Comprobación de tipos sin emitir archivos. |
| `npm test` | Suite de pruebas una vez. |
| `npm run test:watch` | Pruebas en modo interactivo. |
| `npm run keychain:build` | Compila `bin/polymarket-keychain-helper`. |
| `npm run onboard` | Alta local y comprobación de identidad/Keychain. |
| `npm run session:authorize -- --pending [id]` | Abre el helper nativo macOS, solicita importe y presencia local, y registra la autorización única. |
| `npm run smoke` | Comprobaciones de conectividad sin enviar órdenes. |
| `npm run ledger:export -- [directorio] [quote.json]` | Exporta el ledger completo a JSON, los eventos a CSV y el resumen contable pUSD/EUR a `accounting.csv`. El quote EUR es opcional; sin él, EUR queda explícitamente no disponible. |
| `npm run audit:reconcile` | Diagnostica y registra una reparación append-only de una bifurcación histórica; nunca borra ni reescribe eventos. |

## Configuración sin secretos

Las únicas variables admitidas son de configuración no secreta:

| Variable | Valor inicial | Descripción |
| --- | --- | --- |
| `POLYMARKET_PROFILE_ADDRESS` | dirección cero | Dirección pública del perfil; hay que sustituirla. |
| `POLYMARKET_DB_PATH` | `./data/polymarket.sqlite` | Ledger SQLite local. |
| `POLYMARKET_APPROVAL_HOST` | `127.0.0.1` | Bind del dashboard local; literal fijo, no se admite una interfaz externa. |
| `POLYMARKET_APPROVAL_PORT` | `8787` | Puerto local del dashboard entre 1024 y 65535. |
| `POLYMARKET_LIVE_ENABLED` | `false` | Una de varias barreras de live; no es una autorización suficiente. |
| `PAPER_GATE_SKIP` | `false` | Override explícito y visible del gate de 30 días/50 operaciones. No relaja ninguna otra barrera ni la autorización de presupuesto. |
| `POLYMARKET_KEYCHAIN_SERVICE` | `codex-polymarket-guarded` | Mantén este valor con el helper nativo actual. |
| `POLYGON_RPC_URL` | `https://polygon-rpc.com` | RPC público de respaldo para modos sin live. Debe ser un origen HTTPS sin ruta, query ni credenciales. |
| `POLYGON_RPC_URLS` | vacío | En live: dos orígenes HTTPS públicos, sin credenciales y con hosts distintos, separados por coma. |

Puedes exportarlas en el entorno que inicia Codex o ajustar la tabla `env` de `.codex/config.toml`. El archivo `.env.example` es solo una plantilla; `loadConfig()` carga `.env` cuando recibe el entorno normal del proceso. Los comandos CLI (`onboard`, `smoke`, `ledger:export` y `session:authorize`) leen ese mismo entorno del shell y no la tabla del TOML, por lo que deben recibir exactamente la misma dirección, ruta de SQLite y configuración RPC no secreta que el servidor MCP. La dirección de perfil es pública; aun así, no pongas en esos lugares una clave privada, secret, passphrase ni credencial L2.

La clave social nunca debe aparecer en:

- el chat;
- `.env` o `.codex/config.toml`;
- argumentos de procesos;
- scripts del shell o historial;
- SQLite, CSV/JSON, logs, fixtures o mensajes de error;
- commits, incidencias o capturas de pantalla.

## Conexión con Codex

El archivo [`.codex/config.toml`](.codex/config.toml) registra el servidor `polymarket` por `stdio`:

```toml
[mcp_servers.polymarket]
enabled = true
required = false
command = "node"
args = ["dist/mcp/server.js"]
cwd = "/Users/angel/devp/polymarket"
startup_timeout_sec = 15
tool_timeout_sec = 60
```

Tras compilar, reinicia Codex o recarga la configuración MCP y consulta primero `get_account_status`. Mantén `POLYMARKET_LIVE_ENABLED=false` durante lectura y paper trading.

`PAPER_GATE_SKIP=true` solo omite la evaluación de duración, número de operaciones,
PnL y drawdown del PaperGate. El estado se muestra como `skipped` y siguen siendo
obligatorios la cuenta verificada, Keychain, la activación local, geoblock, límites,
reconciliación, propuesta staged intacta y comprobaciones loopback. Es un override explícito
de configuración no secreta, no una autorización de live.

## Alta local

Para iniciar una sesión de trading, el agente debe preparar primero la capacidad y la persona debe autorizarla localmente:

```text
prepare_trading_session
    ↓
npm run session:authorize -- --pending <id>
  (ventana nativa macOS: importe + LocalAuthentication)
    ↓
activate_trading_session
```

La activación consume la autorización una sola vez. No existe una herramienta MCP que permita al agente elegir, renovar o ampliar el presupuesto directamente.

Ejecuta los pasos desde un shell con la misma configuración no secreta que usará MCP:

```bash
npm run onboard -- status
npm run onboard -- import-key
npm run onboard -- configure
npm run onboard -- adopt-existing-portfolio --confirm ADOPT_EXISTING_PORTFOLIO
npm run onboard -- activate-live --confirm ACTIVATE_LIVE
npm run autonomous:start
```

`import-key` abre la interfaz nativa oculta y escribe directamente en el Llavero. `configure` comprueba signer, funder, perfil y tipo de wallet; usa `--confirm-legacy-proxy` solo cuando la comprobación explícita determine que la cuenta existente es el proxy legado tipo 1. `activate-live` seguirá fallando hasta que la puerta paper y el resto de controles estén satisfechos.

Si la cuenta ya tiene posiciones abiertas, `adopt-existing-portfolio` permite establecer un baseline diario verificable sin introducir un saldo manual ni mover fondos. Exige cartera pública consistente, cero actividad desde medianoche de `Europe/Madrid`, cuenta autenticada en modo que permita órdenes, auditoría válida, cooldown inactivo y exposición por debajo del techo fijo. Guarda únicamente un hash de identidad de las posiciones; cualquier cambio externo invalida la adopción. Las posiciones adoptadas sin procedencia local siguen bloqueadas para salidas automáticas hasta que se reconcilien.

### Arranque autónomo persistente

`autonomous:start` es el comando recomendado para iniciar el daemon local. Ejecuta, en una sola operación, estas tareas:

1. Comprueba que live está preparado y calcula la capacidad real disponible.
2. Reutiliza una sesión o autorización live pendiente que siga vigente; no crea un segundo presupuesto.
3. Si hace falta, muestra una única ventana nativa para autorizar el importe exacto de la sesión.
4. Activa la sesión y registra el supervisor `launchd` con lock de instancia única.

```bash
npm run autonomous:start
```

Después de `npm run build` también puede ejecutarse directamente:

```bash
node dist/cli/autonomous-start.js
```

La duración por defecto es de 8 horas y puede ajustarse entre 1 y 24 horas:

```bash
npm run autonomous:start -- --ttl-hours 12
```

El comando imprime la sesión activa, el presupuesto autorizado, el vencimiento y el estado del supervisor. Una sesión activa se reutiliza en ejecuciones posteriores; al caducar, la renovación exige una nueva autorización nativa. No hay confirmaciones por orden. El daemon se detiene de forma segura al expirar la sesión o ante un bloqueo de emergencia.

El supervisor evalúa entradas aproximadamente cada 10 segundos y supervisa las posiciones en el mismo ciclo. No opera por momentum puro: necesita un `ResearchBundle` vigente, verificable y con dos dominios independientes. `autonomous:start` no inventa probabilidades ni acepta saldo manual; si faltan investigación, snapshots o capacidad de riesgo, el ciclo termina sin enviar una orden.

Para que una IA anfitriona decida las entradas durante una conversación activa existe el contrato portable [`docs/AI_AUTONOMOUS_TRADING.md`](docs/AI_AUTONOMOUS_TRADING.md). La IA adquiere `start_agent_run`, renueva el heartbeat y usa evidencia de mercado seguida exactamente de `stage_order → execute_staged_order`. Mientras el lease está activo el daemon no abre entradas, aunque sigue conciliando y supervisando salidas. Stop, `SIGTERM`, cierre de conversación o caducidad del lease bloquean live y dejan la sesión reconciliable.

Para calcular el presupuesto live, el proceso usa la cartera pública cuando incluye saldo y, si no lo incluye, consulta de forma autenticada y solo lectura el saldo de garantía del CLOB. Si esa verificación falla, el arranque se bloquea; nunca acepta un saldo introducido manualmente.

Para cerrar live o revisar un incidente:

```bash
npm run onboard -- deactivate-live
npm run onboard -- clear-emergency --confirm CLEAR_EMERGENCY
```

La limpieza del bloqueo exige que no quede ninguna ejecución local ambigua, que no existan órdenes remotas abiertas y que cada ejecución terminal coincida con su propuesta. Live permanece desactivado después de la revisión.

## Datos, auditoría y recuperación

SQLite guarda propuestas, sesiones, ejecuciones, operaciones paper, estados persistentes y una cadena de eventos enlazada por hash. La base y su directorio se crean con permisos locales restrictivos; están excluidos de Git junto con WAL, logs, binarios y `.env`.

La exportación contable conserva pUSD como unidad primaria. Para añadir una conversión EUR reproducible, pasa un JSON de cotización pública con `baseCurrency: "pUSD"`, `quoteCurrency: "EUR"`, `rateEurPerPusd`, `observedAt`, `validUntil`, `sourceName` y una `sourceUrl` HTTPS. Las cotizaciones ausentes, caducadas o inválidas dejan EUR como `UNAVAILABLE`; nunca se sustituye silenciosamente por una tasa aproximada.

La idempotencia se apoya en `proposalId`, hash exacto y reclamación autónoma atómica de la ejecución. Un POST incierto queda como `SUBMISSION_UNKNOWN`, conserva claim, hash y reserva, activa el lock y exige reconciliación antes de cualquier reintento; un reinicio no lo convierte en una propuesta nueva. `emergency_stop` se persiste antes de intentar cancelaciones: si la API falla, el bloqueo sigue activo.

Con `POLYMARKET_LIVE_ENABLED=false`, `supervisePositions` funciona como shadow: lee la cartera pública y registra `SHADOW_EXIT_RECOMMENDED`, pero no crea paper exits ni muta `PositionRecord` live. Las salidas live son reduce-only: no requieren sesión ni paper gate, aunque mantienen identidad, geoblock, snapshot, posición liquidada y bloqueo de emergencia.

Antes de confiar en el ledger:

```bash
npm test
npm run smoke
```

Exporta una copia privada del ledger reconciliado con:

```bash
npm run ledger:export -- ./exports/revision
```

`ledger.json` contiene propuestas, ejecuciones, paper trades y auditoría; `ledger.csv` contiene los eventos de auditoría. Los archivos se crean con permisos restrictivos y `exports/` está excluido de Git.

## Riesgos residuales

- El resultado económico depende de probabilidades inciertas, liquidez, fees, slippage, latencia, fills parciales y resolución del mercado.
- Un heartbeat o una cancelación son comunicaciones de red; “cancelación de mejor esfuerzo” no demuestra por sí misma que no quede una orden abierta. Confirma el estado remoto.
- El Llavero reduce el riesgo de persistencia y extracción, pero el material de firma existe brevemente en memoria durante una operación autorizada.
- Las dependencias transitivas cambian con el tiempo. Ejecuta `npm audit` en cada actualización, revisa cada hallazgo y no apliques `npm audit fix --force` sin comprobar compatibilidad y superficie realmente usada.
- El SDK MCP incluye transporte HTTP aunque este proyecto usa `stdio`; el runtime CLOB incluye componentes de firma heredados aunque el firmante local limita esquema, dominio e importes. Esas reducciones de superficie no eliminan el riesgo de la cadena de suministro.
- Conserva una wallet aislada y un saldo limitado para el piloto. Depósitos, retiradas y allowances se realizan manualmente fuera de MCP.

## Principio operativo

Codex puede investigar y preparar una propuesta. El agente ejecuta de forma autónoma únicamente dentro de una sesión y presupuesto previamente autorizados, con hash exacto, límites y reconciliación. Si algún dato crítico es ambiguo, obsoleto o inconsistente, el comportamiento esperado es bloquear.
