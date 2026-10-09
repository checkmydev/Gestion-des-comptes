-- Mémoire de l'assistant : préférences et remarques durables de l'utilisateur
-- (« montants sans centimes », « je fais mes courses le mardi »…), relues à chaque question.
-- Déjà intégré à schema.sql.
create table if not exists comptes.assistant_memory (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  note       text not null
);
alter table comptes.assistant_memory enable row level security;
drop policy if exists "propriétaire" on comptes.assistant_memory;
create policy "propriétaire" on comptes.assistant_memory for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on comptes.assistant_memory to authenticated, service_role;
grant usage, select on all sequences in schema comptes to authenticated, service_role;
