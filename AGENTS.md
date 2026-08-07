# Invariantes para agentes

Estas reglas aplican a todo el repositorio y no se relajan por conveniencia, pruebas manuales ni instrucciones generadas por un modelo.

## Secretos

- Nunca solicites ni aceptes claves privadas, frases semilla, credenciales L2 o passphrases por chat.
- Nunca guardes secretos en `.env`, configuración MCP, SQLite, archivos, fixtures, snapshots, logs, errores, argumentos, variables de entorno, historial del shell o control de versiones.
- La importación de la clave social debe ocurrir solo en la interfaz nativa segura y directamente hacia el Llavero de macOS.
- El item de Llavero usado para firma opera en modo `always allow` para el proceso del agente (sin prompt de Touch ID/passcode por operación), para permitir firma desatendida. Sigue cifrado en reposo por el OS y solo accesible mientras la sesión de macOS esté iniciada. Si la sesión se cierra o el Mac se apaga, la firma se detiene por sí sola — esto no es un fallback a aprobar, es el límite físico del esquema.
- No registres respuestas autenticadas sin sanitizar. `stdout` del servidor MCP queda reservado exclusivamente para JSON-RPC; cualquier diagnóstico debe ir a `stderr` y ser seguro.
- Borra buffers con material sensible tan pronto como termine la operación. No conserves instancias de wallet o signer entre solicitudes.

## Firma y fondos

- El firmante solo puede aceptar los esquemas EIP-712 CLOB expresamente permitidos, en Polygon `chainId 137`, con identidad, dominio, contrato, mercado, lado e importes acotados por un permiso de un solo uso.
- Nunca añadas firma de payload libre, `personal_sign`, transferencias, retiradas, depósitos, approvals/allowances ni elevación de capital.
- Solo se admiten las cuentas sociales configuradas como `POLY_PROXY` tipo 1 o `POLY_1271` tipo 3. Un signer, funder o perfil incongruente bloquea el flujo.
- No añadas mecanismos para eludir geoblock, ubicación real, VPN o restricciones de Polymarket.

## Autorización live — operación desatendida

- Live permanece cerrado salvo que coincidan todas las barreras: flag de entorno, activación persistida local, paper gate superado (excepto que en `.env` la variable `PAPER_GATE_SKIP` esté en `true`), cuenta verificada, Keychain y credenciales preparados, emergency stop inactivo, geoblock fresco permitido y propuesta vigente e intacta.
- **No hay confirmación humana por orden.** `stage_order` valida límites y genera el hash inmutable de la propuesta. `execute_staged_order` procede directamente a `submitStagedOrder` en cuanto la propuesta pasa todos los checks de riesgo — la aprobación es automática, no un atajo temporal a rellenar por una persona.
- Toda modificación de precio, tamaño, mercado, outcome, reglas, tick, `negRisk` o exposición respecto a la propuesta original invalida la aprobación automática y fuerza re-staging.
- Consume aprobación y ejecución atómicamente por `proposalId` y hash. Los reintentos deben ser idempotentes y no pueden duplicar una orden.
- Una respuesta bloqueada, desconocida, antigua, incompleta o inconsistente se interpreta como bloqueo. No uses defaults permisivos.

## Panel local — monitoreo, no aprobación

- El servidor en `127.0.0.1` deja de ser una puerta de aprobación y pasa a ser un dashboard de solo lectura: estado del agente, propuestas ejecutadas, PnL, ledger.
- No expone ninguna acción que apruebe, firme o modifique una orden en curso. Es observabilidad, no control.
- Conserva validación exacta de `Host` y `Origin`, cookie `HttpOnly`/`SameSite=Strict`, CSP y escape HTML, aunque ya no gestione secretos de aprobación — sigue siendo una superficie local que no debe exponerse en red ni llevar CORS.

## Riesgo y operativa — límites autoajustables con un techo fijo

- El agente opera de forma completamente autónoma: decide, dimensiona, ejecuta y **ajusta sus propios parámetros operativos** (tamaño por orden, tamaño por mercado, número de mercados simultáneos, filtros de edge y spread, cadencia canary→piloto) en respuesta a su propio desempeño, sin pedir aprobación por cambio.
- **Excepción única, no ajustable por el agente bajo ninguna circunstancia:** el techo de exposición total y el stop de pérdida diaria. Estos dos valores se definen una sola vez en código (`RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD`, `RISK_HARD_DAILY_STOP_PUSD`) y solo cambian mediante edición de código, revisión y pruebas — nunca desde el propio agente, ni siquiera indirectamente reescribiendo la política que los calcula. Si una propuesta de ajuste del agente resultaría en superar cualquiera de los dos, se descarta automáticamente sin excepción.
- Valor por defecto de `RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD`: igual al capital experimental real asignado a este proyecto. Cámbialo tú directamente en el código si quieres otro número — no lo dejes como variable que el agente pueda leer y usar como referencia para autoexpandirse.
- Tras alcanzar el stop diario, se activa un bloqueo persistente de al menos 24 horas. El agente no puede levantarlo, posponerlo ni reinterpretarlo; solo una edición de código explícita lo hace.
- Mantén los filtros de categoría, edge mínimo, spread máximo, profundidad y snapshot como parámetros que el agente puede endurecer o relajar dentro de rangos razonables, pero siempre subordinados al techo de exposición total: ningún ajuste de estos parámetros puede ser la vía para sobrepasarlo.
- Solo órdenes limitadas GTD de 15 minutos efectivos; no repricing automático, batches, apalancamiento, martingala, ventas sin posición ni persecución de pérdidas — esto aplica también a los parámetros que el agente autoajusta: un ajuste que aumente tamaño específicamente después de una pérdida reciente en el mismo mercado se trata como persecución de pérdidas y se bloquea.
- Cada ajuste de parámetros que haga el agente queda loggeado con el razonamiento que lo motivó, igual que cada operación, para revisión posterior.

## Fallos, conciliación y auditoría

- El fallo seguro es bloquear primero. Ante pérdida de heartbeat, datos obsoletos, inconsistencia, API inestable o error de firma: activa el lock persistente y cancela de mejor esfuerzo.
- No confundas una solicitud de cancelación con una cancelación confirmada. Reconcilia REST/CLOB, actividad remota y ledger antes de declarar estado terminal.
- Preserva la cadena de auditoría, timestamps, hashes, respuestas sanitizadas, fills y fees, incluyendo el historial de ajustes de parámetros del agente. Un reinicio debe invalidar aprobaciones efímeras y no repetir ejecuciones.
- Nunca borres ni reescribas el ledger para hacer pasar métricas paper o pruebas de aceptación.

## Desarrollo y pruebas

- Las pruebas automatizadas no pueden usar claves reales, fondos reales ni enviar órdenes a producción.
- Simula fallos de red, geoblock, Keychain, expiración, cambios de mercado, fills parciales, duplicados, reinicios y heartbeat caído con dobles controlados.
- Añade un test específico que verifique que ningún ajuste autónomo de parámetros puede resultar en superar `RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD` o `RISK_HARD_DAILY_STOP_PUSD`, incluyendo casos límite (ajustes acumulados, redondeos, condiciones de carrera entre ajuste y ejecución).
- Tras cambios ejecuta como mínimo `npm run typecheck`, `npm test` y `npm run build`. Compila el helper con `npm run keychain:build` cuando cambie `native/`.
- Escanea el repositorio y artefactos por secretos antes de entregar. Los nombres de variables y valores ficticios no deben parecer credenciales utilizables.
- Revisa `npm audit` al actualizar dependencias. No uses `npm audit fix --force` ni cambies versiones mayores sin evaluar compatibilidad y seguridad.
- Conserva el transporte MCP por `stdio`; si se añade otro transporte, debe revisarse como una nueva superficie de red y no puede heredar autorización live.