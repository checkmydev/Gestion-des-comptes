-- Signalements écrits par l'assistant quand une question révèle une incohérence
-- de l'application (calcul faux, donnée contradictoire, bug, manque).
-- Lus ensuite pour améliorer l'application. Déjà intégré à schema.sql.
create table if not exists comptes.app_reports (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  created_at  timestamptz not null default now(),
  type        text not null check (type in ('bug', 'donnees', 'incoherence', 'amelioration')),
  titre       text not null,
  description text not null,
  question    text,            -- la question posée à l'assistant
  contexte    jsonb,           -- données utiles (montants, périodes, articles…)
  suggestion  text,
  statut      text not null default 'nouveau' check (statut in ('nouveau', 'en_cours', 'corrige', 'ignore'))
);
alter table comptes.app_reports enable row level security;
drop policy if exists "propriétaire" on comptes.app_reports;
create policy "propriétaire" on comptes.app_reports for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on comptes.app_reports to authenticated, service_role;
grant usage, select on all sequences in schema comptes to authenticated, service_role;
