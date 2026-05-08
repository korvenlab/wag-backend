-- Mensagens de suporte / feedback (app Wagoo → Korven via wag-backend + mesma API key que rotas admin).
-- Aplicar no projeto Supabase do Wagoo (SQL Editor ou CLI). Sem FK em organizations caso a base não tenha essa tabela.

create table if not exists public.feedback_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid null,
  user_email text,
  user_full_name text,
  body text not null,
  constraint feedback_messages_body_len check (
    char_length(trim(body)) >= 5
    and char_length(body) <= 8000
  )
);

create index if not exists idx_feedback_messages_created_at on public.feedback_messages (created_at desc);

comment on table public.feedback_messages is
  'Feedback autenticado; leitura/apagar via service_role / wag-backend com API key (GET|DELETE /feedback/messages).';

alter table public.feedback_messages enable row level security;

revoke all on table public.feedback_messages from public;
grant insert on table public.feedback_messages to authenticated;
grant select, insert, update, delete on table public.feedback_messages to service_role;

drop policy if exists "authenticated_insert_own_feedback" on public.feedback_messages;

create policy "authenticated_insert_own_feedback"
on public.feedback_messages
for insert
to authenticated
with check (
  user_id = auth.uid()
);

-- Frontend Waggo: espelhar insert autenticado de `2AVendas/frontend/src/components/feedback-fab.tsx`
-- (`user_full_name` pode vir de `profiles.store_name`; `organization_id` opcional).
