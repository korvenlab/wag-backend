# Integração Wagoo → Korven control plane

## Configuração

Aplicar a migration `20260909100000_control_plane_outbox.sql` e configurar:

- `DASHBOARD_INGEST_URL`
- `WAGOO_DASHBOARD_INGEST_SECRET`
- opcionais: `DASHBOARD_INGEST_TIMEOUT_MS`, `DASHBOARD_INGEST_MAX_ATTEMPTS` e
  `DASHBOARD_INGEST_DRAIN_INTERVAL_MS`

O backend persiste eventos em `wagoo_control_plane_outbox`, entrega em segundo plano e
mantém retry com backoff. Se a migration ainda não estiver aplicada, tenta entrega HTTP
direta e registra falha estruturada.

## Protocolo de eventos

Envelope:

`{ event_id, event_type, occurred_at, product: "wagoo", external_user_id, organization_id?, email?, payload }`

Headers:

- `x-korven-product: wagoo`
- `x-korven-timestamp: <epoch em segundos>`
- `x-korven-signature: HMAC_SHA256(secret, timestamp + "." + rawBody)` em hexadecimal

Eventos emitidos:

- `user.created`: primeira passagem autenticada por `POST /api/auth/sync`, deduplicada por usuário.
- `user.first_login`: primeira passagem autenticada por `POST /api/auth/sync`, deduplicada por usuário.
- `session.started`: cada `POST /api/auth/sync` autenticado concluído.
- `payment.succeeded`: Checkout/Invoice Stripe confirmado.
- `payment.failed`: falha assíncrona de Checkout ou Invoice Stripe.
- `subscription.changed`: criação, atualização ou remoção de assinatura Stripe.
- `admin.event`: espelho do buffer legado `adminEvents`; o buffer continua ativo na transição.

Eventos Stripe incluem IDs aplicáveis (`stripe_event_id`, `checkout_session_id`,
`payment_intent_id`, `invoice_id`, `subscription_id`, `customer_id`) e metadata normalizada
`product`, `external_user_id`, `organization_id` e `plan`.

## Administração e sincronização

Todas as rotas usam o segredo admin já existente (Bearer, `X-API-Key` ou
`x-admin-secret`).

`POST /api/admin/commands/:command` exige `Idempotency-Key` e aceita:

- `role.set`: `{ "external_user_id": "...", "role": "..." }`
- `status.set`: `{ "external_user_id": "...", "active": true }`
- `plan.set`: `{ "external_user_id": "...", "plan": "agenda_web|basic|pro|pro_plus|none" }`
- `access.grant`: `{ "external_user_id": "...", "days": 60 }` — cortesia/promo; não é trial.
- `user.delete`: `{ "external_user_id": "..." }`

Uma repetição concluída retorna a resposta persistida com `Idempotency-Replayed: true`.

`GET /api/admin/sync/users?page=1&per_page=100` lista usuários de forma paginada e
devolve `next_page`.
