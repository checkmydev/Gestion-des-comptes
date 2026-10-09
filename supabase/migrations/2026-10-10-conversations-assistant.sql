-- Conversations avec l'assistant, gardées en base pour les retrouver sur tous les appareils.
-- Déjà intégré à schema.sql.
create table if not exists comptes.assistant_conversations (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  titre      text not null default '',
  messages   jsonb not null default '[]'::jsonb   -- [{ role, content, sources? }]
);
create index if not exists assistant_conversations_recent on comptes.assistant_conversations (user_id, updated_at desc);
alter table comptes.assistant_conversations enable row level security;
drop policy if exists "propriétaire" on comptes.assistant_conversations;
create policy "propriétaire" on comptes.assistant_conversations for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on comptes.assistant_conversations to authenticated, service_role;
grant usage, select on all sequences in schema comptes to authenticated, service_role;

-- Compactage : résumé des anciens messages, envoyé à l'IA à la place des messages qu'il couvre.
alter table comptes.assistant_conversations add column if not exists resume text;
alter table comptes.assistant_conversations add column if not exists resume_count int not null default 0;

-- Coût de chaque requête à l'assistant (suivi, et déclenchement du compactage).
create table if not exists comptes.assistant_usage (
  id              bigint generated always as identity primary key,
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  created_at      timestamptz not null default now(),
  conversation_id bigint references comptes.assistant_conversations on delete set null,
  question        text,
  input_tokens    int not null default 0,
  output_tokens   int not null default 0,
  cache_read      int not null default 0,
  cache_write     int not null default 0,
  web_searches    int not null default 0,
  cout_eur        numeric(8,4) not null default 0,
  compacte        boolean not null default false,
  budget_atteint  boolean not null default false
);
alter table comptes.assistant_usage enable row level security;
drop policy if exists "propriétaire" on comptes.assistant_usage;
create policy "propriétaire" on comptes.assistant_usage for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on comptes.assistant_usage to authenticated, service_role;
grant usage, select on all sequences in schema comptes to authenticated, service_role;
