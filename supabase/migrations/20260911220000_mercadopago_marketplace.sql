-- Mercado Pago Marketplace (Split 1:1) — sinal + clube
-- Mantém colunas Stripe legadas; cobranças novas usam MP.

alter table public.profiles
  add column if not exists mp_user_id text,
  add column if not exists mp_access_token text,
  add column if not exists mp_refresh_token text,
  add column if not exists mp_public_key text,
  add column if not exists mp_token_expires_at timestamptz,
  add column if not exists mp_linked_at timestamptz;

comment on column public.profiles.mp_user_id is 'collector_id / user_id do salão no Mercado Pago (OAuth marketplace)';
comment on column public.profiles.mp_access_token is 'Access token OAuth do vendedor (renovar com refresh)';

alter table public.booking_appointments
  add column if not exists mp_payment_id text,
  add column if not exists mp_preference_id text;

create index if not exists booking_appointments_mp_payment_id_idx
  on public.booking_appointments (mp_payment_id)
  where mp_payment_id is not null;

alter table public.club_members
  add column if not exists mp_payment_id text,
  add column if not exists mp_preapproval_id text;

alter table public.club_plans
  add column if not exists mp_plan_id text;

create index if not exists club_members_mp_payment_id_idx
  on public.club_members (mp_payment_id)
  where mp_payment_id is not null;
