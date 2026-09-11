-- Auditoria / dedupe de webhooks Mercado Pago
create table if not exists public.mp_webhook_events (
  id bigserial primary key,
  topic text not null,
  data_id text not null,
  action text,
  live_mode boolean,
  payload jsonb,
  processed_at timestamptz not null default now(),
  unique (topic, data_id)
);

create index if not exists mp_webhook_events_processed_at_idx
  on public.mp_webhook_events (processed_at desc);

-- Flag se a assinatura recorrente nasceu sem application_fee
alter table public.club_members
  add column if not exists mp_fee_applied boolean;

comment on column public.club_members.mp_fee_applied is
  'false se Preapproval foi criado sem taxa Wagoo (API MP rejeitou application_fee).';
