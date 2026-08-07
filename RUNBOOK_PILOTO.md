# Runbook de paper soak, shadow live y canary

Este documento es una checklist operativa. No activa live, no solicita secretos y no sustituye las barreras del runtime.

## 0. Preflight reproducible

- [ ] Confirmar que `POLYMARKET_LIVE_ENABLED=false` y `PAPER_GATE_SKIP=false`.
- [ ] Confirmar que `POLYMARKET_PROFILE_ADDRESS` es una dirección pública correcta.
- [ ] Confirmar que el proceso MCP usa `stdio` y que su `stdout` no se redirige a logs.
- [ ] Ejecutar `npm ci`.
- [ ] Ejecutar `npm run typecheck`.
- [ ] Ejecutar `npm test`.
- [ ] Ejecutar `npm run build`.
- [ ] Ejecutar `npm audit --audit-level=high` y registrar los hallazgos moderados/bajos pendientes.
- [ ] Ejecutar el escaneo de secretos disponible en CI; no usar claves reales, fondos reales ni endpoints de producción en pruebas.
- [ ] Verificar que el dashboard escucha solo en `127.0.0.1` y que `POST` devuelve `405`.

## 1. Paper soak — mínimo 14 días

Registrar una fila por día en el ledger de revisión local:

| Día | Operaciones | PnL neto | Drawdown | Violaciones | Errores de reconciliación | Supervisor | Reinicio probado | Incidentes |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| 1–14 |  |  |  |  |  |  |  |  |

Durante el periodo:

- [ ] Ejecutar entradas y salidas paper con snapshots frescos.
- [ ] Cubrir fills completos, parciales, órdenes resting y expiraciones GTD.
- [ ] Cubrir stop-loss, take-profit, duración máxima, resolución próxima y edge desaparecido.
- [ ] Verificar que las salidas no consumen presupuesto de entrada ni venden más acciones que las disponibles.
- [ ] Reiniciar el runtime con una ejecución reclamada y verificar lock persistente antes de cualquier reenvío.
- [ ] Verificar heartbeat, backoff, lock de instancia única y recuperación del supervisor.
- [ ] Verificar que el dashboard sigue siendo solo lectura y no contiene respuestas autenticadas.
- [ ] No pasar a shadow si existe una violación de riesgo, error de reconciliación o cadena de auditoría inválida.

Gate de salida: al menos 14 días, al menos 50 operaciones paper, PnL neto positivo, drawdown dentro del límite, cero violaciones de riesgo y cero errores de reconciliación.

## 2. Shadow live — mínimo 7 días

El shadow live puede leer datos públicos y simular decisiones, pero no puede firmar ni hacer POST al CLOB.

- [ ] Mantener `POLYMARKET_LIVE_ENABLED=false`.
- [ ] Mantener la firma y el POST deshabilitados en el harness de shadow.
- [ ] Registrar cada decisión hipotética: mercado, edge, tamaño, motivo de entrada/salida y datos de snapshot.
- [ ] Comparar decisiones hipotéticas con movimientos y fills públicos observados.
- [ ] Revisar falsos positivos, falsas salidas, latencia, datos obsoletos y geoblock.
- [ ] Confirmar que ningún secreto aparece en logs, SQLite, exportaciones o errores.

Gate de salida: 7 días sin incidentes de seguridad o conciliación y revisión local documentada.

## 3. Canary live controlado

Solo después de completar los gates anteriores y de que las barreras de onboarding permitan la activación:

- [ ] Usar una cuenta social compatible tipo `POLY_PROXY` o `POLY_1271` y capital experimental limitado.
- [ ] Activar una sesión con presupuesto explícito y mínimo; no ampliar ni renovar el presupuesto durante la sesión.
- [ ] Limitar las primeras 5 operaciones a 1 pUSD por orden y una posición simultánea.
- [ ] Mantener `PAPER_GATE_SKIP=false`.
- [ ] Revisar el ledger, fills, fees, hashes y reconciliación después de cada ciclo operativo; no se requiere aprobación por orden.
- [ ] Detener y dejar el lock persistente ante cualquier respuesta ambigua, pérdida de heartbeat, geoblock desconocido o divergencia de ledger.

Gate de salida: cero incidentes y revisión diaria del ledger antes de considerar el canary normal.

## 4. Recuperación

- [ ] Para una incidencia, ejecutar `emergency_stop` con su frase exacta y conservar el lock.
- [ ] Desactivar live desde onboarding.
- [ ] Reconciliar REST/CLOB, actividad remota, cartera pública, recibos y ledger local.
- [ ] No declarar una cancelación como terminal solo porque la solicitud fue aceptada.
- [ ] No limpiar el lock hasta que todas las ejecuciones sean terminales y coherentes con su propuesta.
- [ ] Registrar el incidente sin reescribir ni borrar el ledger.

## Estado actual

El repositorio contiene pruebas automatizadas y este runbook, pero el paper soak de 14 días, el shadow live de 7 días y el canary no están declarados como completados.
