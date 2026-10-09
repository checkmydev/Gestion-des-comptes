-- Ajout du nombre d'unités achetées : le prix comparé (inflation, meilleurs prix)
-- devient le prix unitaire (« 2 Edam à 3,25 € » ne passe plus pour une hausse de 100 %).
-- Déjà intégré à schema.sql pour une nouvelle installation.
alter table comptes.purchases add column if not exists units numeric(8,2);
comment on column comptes.purchases.units is 'nombre d''unités achetées (vide = 1)';
