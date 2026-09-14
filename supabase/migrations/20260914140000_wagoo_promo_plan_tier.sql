-- Plano concedido pelo link de cortesia (Agenda Web / Basic / Pro / Pro+).
alter table public.wagoo_promo_links
  add column if not exists plan_tier text not null default 'basic';

alter table public.wagoo_promo_links
  drop constraint if exists wagoo_promo_links_plan_tier_check;

alter table public.wagoo_promo_links
  add constraint wagoo_promo_links_plan_tier_check
  check (plan_tier in ('agenda_web', 'basic', 'pro', 'pro_plus'));

comment on column public.wagoo_promo_links.plan_tier is
  'Plano liberado no resgate do link de cortesia (subscription_tier do profiles).';
