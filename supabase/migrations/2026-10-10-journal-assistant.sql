-- Journal des ajouts faits par l'assistant : permet d'annuler (« annule mon dernier ajout »)
-- sans dépendre de la mémoire de la conversation, et garde une trace de ce qu'il a écrit.
-- Déjà intégré à schema.sql.
create table if not exists comptes.assistant_actions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  table_name text not null check (table_name in ('purchases', 'monthly_lines', 'fuel_fills', 'annual_payments', 'savings_movements')),
  row_id     bigint not null,
  action     text not null default 'ajout' check (action in ('ajout', 'modification')),
  resume     text not null,
  annule     boolean not null default false
);
alter table comptes.assistant_actions enable row level security;
drop policy if exists "propriétaire" on comptes.assistant_actions;
create policy "propriétaire" on comptes.assistant_actions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on comptes.assistant_actions to authenticated, service_role;
grant usage, select on all sequences in schema comptes to authenticated, service_role;
alter table comptes.assistant_actions add column if not exists avant numeric(10,2);           -- ancien montant (modification)
alter table comptes.assistant_actions add column if not exists groupe text not null default gen_random_uuid()::text; -- lignes d'une même demande
