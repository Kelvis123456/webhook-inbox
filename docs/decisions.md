# Decisiones

Cada entrada dice qué elegí, qué descarté y por qué.

## 2026-11-03 · Guardar primero, procesar después

**Elegí:** el endpoint solo verifica la firma, inserta el evento y responde 200. Un worker lo procesa aparte.

**Descarté:** procesar dentro de la petición. Stripe espera una respuesta rápida y reintenta si tarda o falla, así que un handler lento produce justo las entregas repetidas que hay que aguantar. Guardar es una sola inserción y deja el evento a salvo aunque el procesamiento falle después.

## 2026-11-03 · El id del evento es la clave de idempotencia

`webhook_events.id` es la clave primaria y el insert usa `ON CONFLICT DO NOTHING`. Así la base decide, no la aplicación: con 20 entregas simultáneas no hay una ventana entre "¿ya existe?" y "insertar" en la que se cuelen dos. Lo comprobé con 20 peticiones en paralelo, y quitando el `ON CONFLICT` fallan las dos pruebas de duplicados.

## 2026-11-03 · Firma sobre el cuerpo crudo, con el SDK

Uso `Stripe.webhooks.constructEvent` sobre los bytes originales (`rawBody: true` en Nest). Un JSON que ya pasó por el parser y se vuelve a serializar no firma igual, y hay una prueba con el mismo contenido en otro formato que debe rechazarse. Descarté escribir yo el HMAC: es fácil equivocarse en la comparación en tiempo constante y en la tolerancia de la marca de tiempo, y el SDK ya lo hace bien. La respuesta de rechazo es un 400 genérico, sin decir qué comprobación falló.

## 2026-11-03 · Orden por fecha del evento, con desempate

Stripe no garantiza el orden. Un reembolso puede procesarse antes que el pago. Cada pedido guarda `last_event_at` y el `UPDATE ... WHERE orders.last_event_at < EXCLUDED.last_event_at` descarta lo viejo. Como la fecha de un evento tiene resolución de segundos, el mismo segundo se desempata por el estado más avanzado (`refunded` > `paid` > `failed`) para que el resultado no dependa del orden de llegada; hay una prueba que lo recorre en ambos órdenes. Descarté ordenar por fecha de recepción: dice cuándo llegó, no cuándo ocurrió.

**Lo que no cubre:** si dos eventos distintos del mismo segundo no tienen un orden natural (no es el caso con estos tres tipos), el desempate por estado sería una suposición.

## 2026-11-03 · El efecto y la marca "done" en una transacción

Si el worker aplicara el cambio al pedido y luego marcara el evento como hecho en dos pasos, un fallo entre ambos dejaría el pedido cambiado con el evento todavía pendiente, y se reprocesaría. En una sola transacción pasan las dos cosas o ninguna. Aun así el efecto es idempotente (la guarda de orden lo hace), así que procesar dos veces el mismo evento no cambia el resultado, y hay una prueba de eso.

## 2026-11-03 · SKIP LOCKED no es lo que yo creía

Escribí en un comentario que `FOR UPDATE SKIP LOCKED` garantiza que dos workers no toman el mismo evento. Al quitarlo para comprobar mis pruebas, la prueba de tres workers siguió pasando. La unicidad la da el `UPDATE ... WHERE id IN (...)`: si un segundo worker espera el bloqueo, Postgres vuelve a evaluar el `WHERE` y el evento ya está en `processing`. Lo que aporta `SKIP LOCKED` es que el segundo no espere y siga con otras filas. Corregí el comentario y escribí la prueba que sí lo distingue: una fila retenida por otra transacción no debe frenar al worker (sin `SKIP LOCKED` se cuelga 5 segundos y falla).

## 2026-11-03 · Reintentos con jitter completo y cola de muertos

La espera es `random() × min(1 h, 5 s × 2^(intento-1))`. El jitter completo reparte los reintentos para que un fallo de una dependencia no vuelva a golpear todo al mismo instante. A los 6 intentos el evento pasa a `dead` y deja de tomarse; un panel con token lo lista y lo reenvía a la cola con los intentos en cero. Descarté reintentar para siempre: un evento que falla siempre (datos que el handler no entiende) taparía los demás y nadie se enteraría.

Un worker que muere con un evento tomado lo deja en `processing`. A los 60 s el candado vence y otro worker lo reclama.

## 2026-11-03 · Postgres como cola, sin Redis

Una tabla con un índice parcial sobre los eventos listos, en la misma base que los pedidos. Descarté BullMQ o SQS: añaden otra pieza que operar y, sobre todo, partirían en dos la atomicidad entre "efecto en el pedido" y "marcar el evento". No medí cuántos eventos por segundo aguanta y no lo afirmo.

## 2026-11-03 · Pruebas contra un Postgres real

Con Testcontainers. Un mock no puede probar `ON CONFLICT`, `SKIP LOCKED` ni el comportamiento de una transacción, y esas tres cosas son el diseño. Cuesta unos 10 segundos de arranque del contenedor y exige Docker, y lo acepté.

## 2026-11-03 · Sin cuenta de Stripe

No usé una cuenta de Stripe: el helper del SDK firma eventos de prueba con el mismo algoritmo que Stripe, y el simulador y los tests lo usan. A cambio, no puedo decir que el receptor procesó un evento real de Stripe, y el README lo dice. Los tipos de evento de Stripe cambian entre versiones de la API; los campos que leo (`id`, `amount`, `currency`, `payment_intent`, `amount_refunded`) los tomé de la forma de `PaymentIntent` y `Charge` del SDK, no de eventos reales capturados.
