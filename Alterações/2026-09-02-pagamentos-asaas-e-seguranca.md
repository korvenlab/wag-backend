# Alterações — 02/09/2026

Registro das mudanças no fluxo de pagamentos (Asaas), painéis da Agenda Web e correções de segurança.

## Resumo

Migração do **Stripe Connect** para **Asaas MoR** (conta Wagoo): clube, sinal de agendamento e saque PIX passam pelo mesmo ledger. A aba **Pagamentos** concentra saldo/PIX/sinal; a aba **Clube** ficou só com configuração do plano e membros.

---

## Backend (`wag-backend`)

### Pagamentos Asaas (commit `09c545a`)

| Área | O que mudou |
|------|-------------|
| `/api/payments/*` | Novo router: saldo, chave PIX, saque, config de sinal, simulação de taxa |
| `bookingDepositCheckout` | Sinal via cobrança Asaas (`booking_deposit:{appointmentId}`) |
| `bookingPayments` | Após pagamento, credita ledger do salão |
| `clubMembership` webhook | Trata clube + sinal no mesmo handler Asaas |
| `booking.ts` / WhatsApp | Depósito exige Asaas configurado, não mais Connect |

### Segurança (commit `6e003a9`)

| Problema | Correção |
|----------|----------|
| **Double-spend no saque** | Débito atômico no Postgres *antes* do PIX (`club_ledger_try_debit` + advisory lock) |
| **Webhook forjado** | Pagamento sempre revalidado via `asaasGetPayment`; falha fechada se não existir no Asaas |
| **Token opcional** | `ASAAS_WEBHOOK_TOKEN` obrigatório; sem token → 503 |
| **Crédito duplicado** | Unique index em `asaas_payment_id` + tratamento de conflito 23505 |

### Migrations Supabase

1. `20260810120000_club_asaas_ledger.sql` — ledger, PIX payout, colunas Asaas no clube  
2. `20260810140000_booking_asaas_deposit.sql` — `asaas_payment_id` em agendamentos  
3. `20260810150000_club_ledger_atomic_payout.sql` — RPC `club_ledger_try_debit` / `club_ledger_release_debit`

### Variáveis de ambiente (Render)

- `ASAAS_API_KEY` — conta plataforma Wagoo  
- `ASAAS_WEBHOOK_TOKEN` — mesmo valor do header no painel Asaas  
- Webhook URL: `https://<api>/api/asaas/webhook`

### Regra de negócio

- Sem subcontas Asaas por salão.  
- Taxa Wagoo ~2% descontada no **crédito** do ledger.  
- Saque PIX usa chave cadastrada em `club_payout_pix_key`.

---

## Frontend (`wag-frontend`)

### Painéis (commit `5179c7f`)

| Aba | Antes | Depois |
|-----|-------|--------|
| **Pagamentos** | Stripe Connect (onboarding, conta bancária) | Saldo ledger, chave PIX, saque, sinal, simulação |
| **Clube** | Saldo + PIX + plano | Só plano, link e membros (pagamento → Pagamentos) |

### Dashboard Agenda Web

- Copy das seções atualizado (PIX, Asaas).  
- Redirect `?connect=` → aba Pagamentos (legado Stripe).

---

## Commits de referência

| Repo | Commit | Descrição |
|------|--------|-----------|
| wag-backend | `09c545a` | Sinal + wallet Asaas |
| wag-backend | `6e003a9` | Segurança double-spend / webhook |
| wag-frontend | `5179c7f` | UI Pagamentos + Clube config |

---

## Pendências operacionais

- [x] Migration `club_ledger_atomic_payout` aplicada no Supabase Wagoo  
- [ ] Confirmar `ASAAS_WEBHOOK_TOKEN` no Render = token do painel Asaas  
- [ ] Deploy backend + frontend após push  
