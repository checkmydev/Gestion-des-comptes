-- ============================================================================
-- Comptes privés — schéma Supabase
-- À exécuter une fois dans Supabase : SQL Editor > New query > coller > Run.
-- Toutes les tables sont protégées par RLS : chaque utilisateur ne voit que
-- ses propres données (user_id = auth.uid()).
--
-- Le projet Supabase est partagé avec d'autres applications : tout est créé
-- dans le schéma dédié « comptes », qui doit être ajouté aux schémas exposés
-- (Project Settings > Data API > Exposed schemas).
-- ============================================================================

create schema comptes;
set search_path to comptes, public;

grant usage on schema comptes to anon, authenticated, service_role;
alter default privileges in schema comptes grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema comptes grant usage, select on sequences to authenticated, service_role;

-- Un « mois comptable » est représenté par le 1er jour du mois (ex. 2026-10-01).
create domain month_period as date check (value = date_trunc('month', value)::date);

-- ---------------------------------------------------------------------------
-- Référentiels : catégories (blocs du « détail »), articles, magasins
-- ---------------------------------------------------------------------------
create table categories (
  id              bigint generated always as identity primary key,
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  name            text not null,
  sort_order      int  not null default 0,
  weighed         boolean not null default false, -- colonnes Quantité / €/kg / Promo
  counted         boolean not null default false, -- colonne Nombre (1 par défaut)
  track_inflation boolean not null default false, -- inclus dans les statistiques d'inflation
  archived        boolean not null default false,
  monthly_budget  numeric(10,2),                  -- budget mensuel visé (facultatif)
  unique (user_id, name)
);

create table items (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  category_id bigint not null references categories on delete cascade,
  name        text not null,
  unique (category_id, name)
);

create table stores (
  id      bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name    text not null,
  unique (user_id, name)
);

-- ---------------------------------------------------------------------------
-- Achats (lignes du « détail mois »)
-- ---------------------------------------------------------------------------
create table purchases (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  period       month_period not null,          -- mois comptable choisi à la saisie
  item_id      bigint not null references items on delete restrict,
  store_id     bigint references stores on delete set null,
  purchased_on date,                           -- date réelle de l'achat
  quantity_g   numeric(10,1),                  -- catégories « pesées » uniquement
  price_per_kg numeric(10,2),
  promo_pct    numeric(5,2),
  units        numeric(8,2),                   -- nombre d'unités achetées (vide = 1)
  amount       numeric(10,2) not null,         -- montant payé
  note         text,
  created_at   timestamptz not null default now()
);
create index purchases_period_idx on purchases (user_id, period);
create index purchases_item_idx on purchases (item_id);

-- ---------------------------------------------------------------------------
-- Tableau « Global » : revenus et dépenses fixes mensuelles
-- ---------------------------------------------------------------------------
create table months (
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  period          month_period not null,
  -- Solde du compte en fin de mois précédent. NULL = calcul automatique à
  -- partir du mois précédent ; une valeur saisie force le montant.
  opening_balance numeric(10,2),
  notes           text,
  primary key (user_id, period)
);

create table monthly_lines (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  period     month_period not null,
  section    text not null check (section in ('revenu', 'fixe')),
  label      text not null,
  amount     numeric(10,2) not null default 0,
  note       text,
  carry_over boolean not null default true, -- montant recopié sur le mois suivant
  sort_order int not null default 0
);
create index monthly_lines_period_idx on monthly_lines (user_id, period);

-- ---------------------------------------------------------------------------
-- Provisions pour dépenses annuelles
-- ---------------------------------------------------------------------------
create table annual_provisions (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  year          int not null,
  label         text not null,
  annual_amount numeric(10,2) not null default 0, -- montant annuel estimé
  due_month     int check (due_month between 1 and 12), -- mois d'échéance habituel
  sort_order    int not null default 0
);

create table annual_payments (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  provision_id bigint not null references annual_provisions on delete cascade,
  paid_on      date not null,
  amount       numeric(10,2) not null,
  note         text
);

create table user_settings (
  user_id       uuid primary key default auth.uid() references auth.users on delete cascade,
  annual_budget    numeric(10,2) not null default 2000, -- plafond des dépenses annuelles
  emergency_target numeric(10,2) not null default 3000  -- réserve « imprévus » visée sur l'épargne
);

-- ---------------------------------------------------------------------------
-- Compte épargne (transferts épargne => compte courant, dépenses payées)
-- ---------------------------------------------------------------------------
create table savings_movements (
  id       bigint generated always as identity primary key,
  user_id  uuid not null default auth.uid() references auth.users on delete cascade,
  moved_on date not null,
  label    text not null,
  amount   numeric(10,2) not null, -- + apport, − dépense / transfert
  note     text
);

-- ---------------------------------------------------------------------------
-- Essence : pleins et trajets extra
-- ---------------------------------------------------------------------------
create table fuel_fills (
  id              bigint generated always as identity primary key,
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  period          month_period not null,
  station         text not null,
  filled_on       date,
  price_per_litre numeric(6,3),
  km              numeric(10,0), -- compteur kilométrique
  total           numeric(10,2) not null
);

create table trips (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  period        month_period not null,
  label         text not null,   -- où & quoi ?
  trip_date     date,
  km_round_trip numeric(10,0) not null default 0
);

-- ---------------------------------------------------------------------------
-- Prix relevés (recherches de prix poussées depuis le PC via scripts/push-prices.mjs)
-- ---------------------------------------------------------------------------
create table price_references (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  item_id     bigint not null references items on delete cascade,
  store_name  text not null,                 -- enseigne (Delhaize, Lidl, Colruyt…)
  price       numeric(10,2) not null,
  unit        text not null default 'piece' check (unit in ('piece', 'kg', 'l')),
  label       text,                          -- libellé exact du produit trouvé
  is_promo    boolean not null default false,
  observed_on date not null default current_date,
  source      text,                          -- URL ou origine de l'information
  created_at  timestamptz not null default now()
);
create index price_references_item_idx on price_references (item_id, observed_on);

-- ---------------------------------------------------------------------------
-- Pages privées (points sur les dépenses…) affichées à l'adresse #/doc/<slug>,
-- uniquement pour leur propriétaire connecté. Jamais dans le dépôt public.
-- ---------------------------------------------------------------------------
create table documents (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  slug       text not null check (slug ~ '^[a-z0-9-]+$'),
  title      text not null,
  html       text not null,
  updated_at timestamptz not null default now(),
  unique (user_id, slug)
);

-- ---------------------------------------------------------------------------
-- Signalements de l'assistant (incohérences de l'application, à corriger)
-- ---------------------------------------------------------------------------
create table app_reports (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  created_at  timestamptz not null default now(),
  type        text not null check (type in ('bug', 'donnees', 'incoherence', 'amelioration')),
  titre       text not null,
  description text not null,
  question    text,
  contexte    jsonb,
  suggestion  text,
  statut      text not null default 'nouveau' check (statut in ('nouveau', 'en_cours', 'corrige', 'ignore'))
);

-- ---------------------------------------------------------------------------
-- Mémoire de l'assistant (préférences et remarques durables de l'utilisateur)
-- ---------------------------------------------------------------------------
create table assistant_memory (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  note       text not null
);

-- ---------------------------------------------------------------------------
-- Vue : total par catégorie et par mois (alimente le Global et les stats)
-- security_invoker => les règles RLS des tables sous-jacentes s'appliquent.
-- ---------------------------------------------------------------------------
create view category_month_totals with (security_invoker = true) as
select p.user_id, p.period, i.category_id, sum(p.amount)::numeric(10,2) as total
from purchases p
join items i on i.id = p.item_id
group by p.user_id, p.period, i.category_id;

-- ---------------------------------------------------------------------------
-- Keep-alive : un projet Supabase gratuit est mis en pause après 7 jours sans
-- activité. L'application (à chaque ouverture) et un workflow GitHub planifié
-- appellent keep_alive(), qui écrit une ligne ici. Aucun lien avec le budget.
-- La table n'est accessible qu'au travers de la fonction (RLS sans règle).
-- ---------------------------------------------------------------------------
create table keep_alive (
  id        bigint generated always as identity primary key,
  pinged_at timestamptz not null default now(),
  source    text not null
);
alter table keep_alive enable row level security;

create function keep_alive(source text default 'app') returns timestamptz
language plpgsql security definer set search_path = comptes as $$
declare t timestamptz;
begin
  insert into keep_alive (source) values (left(coalesce(source, '?'), 20)) returning pinged_at into t;
  -- On ne garde que les 200 derniers passages : la table reste minuscule.
  delete from keep_alive where id <= (select max(id) - 200 from keep_alive);
  return t;
end $$;
revoke all on function keep_alive(text) from public;
grant execute on function keep_alive(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'categories', 'items', 'stores', 'purchases', 'months', 'monthly_lines',
    'annual_provisions', 'annual_payments', 'user_settings', 'savings_movements',
    'fuel_fills', 'trips', 'price_references', 'documents', 'app_reports', 'assistant_memory'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy "propriétaire" on %I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- Droits d'accès via l'API (les règles RLS ci-dessus filtrent les lignes).
grant select, insert, update, delete on all tables in schema comptes to authenticated, service_role;
grant usage, select on all sequences in schema comptes to authenticated, service_role;
