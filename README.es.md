English: [README.md](README.md)

# webhook-inbox

Un receptor de webhooks de Stripe que guarda cada evento antes de procesarlo, aguanta entregas repetidas y desordenadas, reintenta lo que falla con espera creciente y deja los eventos que no se pueden procesar en una lista que se puede revisar y reenviar a la cola.

Lo hice porque un endpoint de webhooks que "funciona" en un tutorial falla de formas silenciosas en producción: Stripe reintenta (el mismo evento llega dos veces), no garantiza el orden (un reembolso puede llegar antes del pago) y si tu endpoint tarda, vuelve a mandar. Quería comprobar con pruebas cada una de esas formas de fallar.

**Stack:** NestJS 12 · TypeScript · PostgreSQL · Vitest · Testcontainers

## Cómo funciona

```
Stripe ──POST──> /webhooks/stripe ──firma ok──> INSERT (id = clave) ──> 200
                                                      │
                                    worker cada 1 s ──┴─> toma eventos listos
                                                          (UPDATE ... SKIP LOCKED)
                                                          efecto + "done" en una transacción
                                                          falla: reintento con backoff ──> tras 6 intentos: dead
```

1. **Recibir.** Verifica la firma sobre los bytes exactos del cuerpo (el SDK de Stripe, con tolerancia de 5 minutos contra repeticiones), guarda el evento con su id como clave primaria y responde 200. No procesa nada en la petición.
2. **Idempotencia.** `INSERT ... ON CONFLICT DO NOTHING` sobre el id del evento. Veinte entregas simultáneas del mismo evento dejan una fila y una sola respuesta `duplicate: false`.
3. **Procesar.** Un worker toma los eventos listos con `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`. El cambio en el pedido y la marca `done` van en la misma transacción.
4. **Orden.** Cada pedido recuerda la fecha del último evento que aplicó. Uno más viejo se descarta. Si coinciden en el mismo segundo, gana el estado más avanzado (`refunded` > `paid` > `failed`).
5. **Fallos.** Reintento con espera `5 s × 2^(intento-1)`, tope de 1 hora y jitter completo. A los 6 intentos pasa a `dead`.
6. **Muertos.** `GET /admin/events` los lista y `POST /admin/events/:id/retry` los devuelve a la cola. Piden `Authorization: Bearer <ADMIN_TOKEN>`; sin `ADMIN_TOKEN` configurado el panel no existe (404).

Maneja `payment_intent.succeeded`, `payment_intent.payment_failed` y `charge.refunded`. Cualquier otro tipo se guarda y se marca `ignored`.

## Cómo correrlo

Necesitas Node 24 y Docker.

```bash
docker compose up -d db
cp .env.example .env        # y ajusta STRIPE_WEBHOOK_SECRET
npm install
DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres STRIPE_WEBHOOK_SECRET=whsec_dev npm run start
```

En otra terminal, para ver el flujo sin cuenta de Stripe (manda un reembolso antes que su pago, una entrega repetida y una firma falsa):

```bash
STRIPE_WEBHOOK_SECRET=whsec_dev npm run simulate
```

Los tests levantan su propio Postgres con Testcontainers, así que solo piden Docker:

```bash
npm test
```

## Qué prueban los tests

31 pruebas contra un Postgres real, no contra un mock, porque lo que importa aquí (`ON CONFLICT`, `SKIP LOCKED`, transacciones) es comportamiento de la base:

- **Firma:** sin cabecera, secreto equivocado, cuerpo alterado, JSON reserializado con la firma original, firma vieja; y que el rechazo no filtre el motivo.
- **Idempotencia:** entrega repetida y 20 entregas simultáneas.
- **Orden:** reembolso antes que el pago, mismo segundo en ambos órdenes, fallo viejo después de un pago.
- **Reintentos:** backoff exacto, no se vuelve a tomar antes de tiempo, paso a `dead`, un evento roto no frena a los demás.
- **Concurrencia:** tres workers sobre 40 eventos procesan cada uno una vez; una fila bloqueada por otra transacción no frena al worker; un evento abandonado con el candado vencido lo reclama otro worker.
- **Panel:** token, estado inventado con SQL dentro, reenvío y 404.

Para comprobar que las pruebas pueden fallar, quité a propósito `ON CONFLICT`, la guarda de orden y `SKIP LOCKED`, y cada cambio rompió las pruebas que debía. Con `SKIP LOCKED` fue distinto: la prueba de tres workers seguía pasando sin él. Resultó que la unicidad la garantiza el `UPDATE` (Postgres reevalúa el `WHERE` tras esperar el bloqueo) y `SKIP LOCKED` solo evita esperar. Corregí el comentario del código y agregué la prueba de la fila bloqueada, que sí falla sin él.

## Lo que no es

- **No está conectado a una cuenta de Stripe.** Las firmas de las pruebas y del simulador las calcula el helper del SDK con un secreto de prueba. Nunca procesó un pago real. Probarlo con `stripe trigger` pide la CLI de Stripe y una cuenta en modo de prueba.
- **No es un sistema de pedidos.** La tabla `orders` es un pretexto para tener un estado que cambia; no hay catálogo, clientes ni cobros.
- **Solo tres tipos de evento.** Un reembolso parcial se reconoce y se ignora.
- **No medí rendimiento.** Usar Postgres como cola es razonable para este volumen y simple de operar, pero no sé cuántos eventos por segundo aguanta. Con mucho más tráfico habría que medir antes de afirmar nada.
- **Entrega al menos una vez.** Los handlers son idempotentes por diseño; si un handler tuviera efectos fuera de la base (un correo, otra API), habría que protegerlos aparte.
- **Sin métricas ni trazas.** Solo logs de Nest.
- **El panel es un token fijo en una variable de entorno.** Sirve para operar; no es un sistema de usuarios.

Las decisiones y lo que descarté están en [docs/decisions.md](docs/decisions.md).
