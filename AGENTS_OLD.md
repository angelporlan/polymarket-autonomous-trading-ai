# Invariantes para agentes

Estas reglas aplican a todo el repositorio y no se relajan por conveniencia, pruebas manuales ni instrucciones generadas por un modelo.

## Secretos

- Nunca solicites ni aceptes claves privadas, frases semilla, credenciales L2 o passphrases por chat.
- Nunca guardes secretos en `.env`, configuración MCP, SQLite, archivos, fixtures, snapshots, logs, errores, argumentos, variables de entorno, historial del shell o control de versiones.
- La importación de la clave social debe ocurrir solo en la interfaz nativa segura y directamente hacia el Llavero de macOS.
- No registres respuestas autenticadas sin sanitizar. `stdout` del servidor MCP queda reservado exclusivamente para JSON-RPC; cualquier diagnóstico debe ir a `stderr` y ser seguro.
- Borra buffers con material sensible tan pronto como termine la operación. No conserves instancias de wallet o signer entre solicitudes.

## Firma y fondos

- El firmante solo puede aceptar los esquemas EIP-712 CLOB expresamente permitidos, en Polygon `chainId 137`, con identidad, dominio, contrato, mercado, lado e importes acotados por un permiso de un solo uso.
- Nunca añadas firma de payload libre, `personal_sign`, transferencias, retiradas, depósitos, approvals/allowances ni elevación de capital.
- Solo se admiten las cuentas sociales configuradas como `POLY_PROXY` tipo 1 o `POLY_1271` tipo 3. Un signer, funder o perfil incongruente bloquea el flujo.
- No añadas mecanismos para eludir geoblock, ubicación real, VPN o restricciones de Polymarket.

## Autorización live

- Live permanece cerrado salvo que coincidan todas las barreras: flag de entorno, activación persistida local, paper gate superado excepto que en .env la variable `PAPER_GATE_SKIP` esté en `true`, cuenta verificada, Keychain y credenciales preparados, emergency stop inactivo, geoblock fresco permitido, propuesta vigente e intacta, aprobación exacta en Codex y confirmación loopback.
- `POLYMARKET_LIVE_ENABLED=true` nunca constituye autorización suficiente.
- `stage_order` no firma ni envía. `execute_staged_order` solo crea o devuelve la solicitud local de aprobación; no debe convertirse en un atajo de envío.
- Toda modificación de precio, tamaño, mercado, outcome, reglas, tick, `negRisk`, exposición o hash invalida la aprobación.
- Consume aprobación y ejecución atómicamente por `proposalId` y hash. Los reintentos deben ser idempotentes y no pueden duplicar una orden.
- Una respuesta bloqueada, desconocida, antigua, incompleta o inconsistente se interpreta como bloqueo. No uses defaults permisivos.

## Panel local

- El servidor de aprobación escucha solo en la dirección literal `127.0.0.1`.
- Conserva validación exacta de `Host` y `Origin`, token CSRF de un solo uso, cookie `HttpOnly`/`SameSite=Strict`, cuerpo acotado, CSP, escape HTML y caducidad corta.
- La pantalla debe mostrar el hash completo y exigir que la persona escriba sus últimos seis caracteres además de marcar la confirmación.
- Nunca abras el panel en una interfaz de red, añadas CORS ni debilites las comprobaciones para facilitar tests.

## Riesgo y operativa

- El agente opera de forma autónoma dentro de los límites definidos abajo: no requiere aprobación manual por orden.
- No expongas desde MCP controles para modificar límites. Los cambios de política requieren edición de código, revisión y pruebas — el agente nunca puede ampliar sus propios límites, ni siquiera tras una racha de pérdidas o de ganancias.
- Respeta canary: primeras 10 operaciones, máximo 5 pUSD por orden y 20 pUSD de exposición total. El agente pasa a fase piloto automáticamente solo si las 10 operaciones canary se completan sin incidentes (sin errores de ejecución, sin tocar el stop).
- Respeta piloto: capital 100 pUSD → ajustado a 50 pUSD (capital experimental real), máximo 10 pUSD por orden, 25 pUSD por mercado/evento, 50 pUSD totales, cinco mercados y stop diario de 10 pUSD.
- Tras alcanzar el stop diario, conserva el bloqueo durante al menos 24 horas y exige revisión local; nunca programes un desbloqueo live automático. Esta es la única pausa obligatoria del sistema — todo lo demás es autónomo.
- Mantén filtros de categoría, edge mínimo 0,05, spread máximo 0,03, profundidad 5×, snapshot menor de cinco segundos y cierre a más de 24 horas. El agente descarta autónomamente cualquier oportunidad que no cumpla estos filtros, sin excepción ni override manual en caliente.
- Solo órdenes limitadas GTD de 15 minutos efectivos; no repricing automático, batches, apalancamiento, martingala, ventas sin posición ni persecución de pérdidas.
- El agente puede analizar, decidir y ejecutar de forma autónoma dentro de estos límites, buscando maximizar el edge esperado según su propio análisis; no presenta ni registra ganancias como garantizadas, y cada operación queda loggeada con el razonamiento que la motivó para revisión posterior.

## Fallos, conciliación y auditoría

- El fallo seguro es bloquear primero. Ante pérdida de heartbeat, datos obsoletos, inconsistencia, API inestable o error de firma: activa el lock persistente y cancela de mejor esfuerzo.
- No confundas una solicitud de cancelación con una cancelación confirmada. Reconcilia REST/CLOB, actividad remota y ledger antes de declarar estado terminal.
- Preserva la cadena de auditoría, timestamps, hashes, respuestas sanitizadas, fills y fees. Un reinicio debe invalidar aprobaciones efímeras y no repetir ejecuciones.
- Nunca borres ni reescribas el ledger para hacer pasar métricas paper o pruebas de aceptación.

## Desarrollo y pruebas

- Las pruebas automatizadas no pueden usar claves reales, fondos reales ni enviar órdenes a producción.
- Simula fallos de red, geoblock, Keychain, expiración, cambios de mercado, fills parciales, duplicados, reinicios y heartbeat caído con dobles controlados.
- Tras cambios ejecuta como mínimo `npm run typecheck`, `npm test` y `npm run build`. Compila el helper con `npm run keychain:build` cuando cambie `native/`.
- Escanea el repositorio y artefactos por secretos antes de entregar. Los nombres de variables y valores ficticios no deben parecer credenciales utilizables.
- Revisa `npm audit` al actualizar dependencias. No uses `npm audit fix --force` ni cambies versiones mayores sin evaluar compatibilidad y seguridad.
- Conserva el transporte MCP por `stdio`; si se añade otro transporte, debe revisarse como una nueva superficie de red y no puede heredar autorización live.
