-- Pages privées (rapports, points sur les dépenses…) affichées par l'application
-- à l'adresse #/doc/<slug>, uniquement pour leur propriétaire connecté.
-- Le contenu n'est jamais dans le dépôt GitHub (public).
-- Déjà intégré à schema.sql pour une nouvelle installation.
create table if not exists comptes.documents (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  slug       text not null check (slug ~ '^[a-z0-9-]+$'),
  title      text not null,
  html       text not null,
  updated_at timestamptz not null default now(),
  unique (user_id, slug)
);
alter table comptes.documents enable row level security;
drop policy if exists "propriétaire" on comptes.documents;
create policy "propriétaire" on comptes.documents for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on comptes.documents to authenticated, service_role;
