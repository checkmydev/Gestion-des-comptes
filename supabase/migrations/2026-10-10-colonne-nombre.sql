-- Colonne « Nombre » (1 par défaut) dans la saisie et le détail, catégorie par catégorie.
-- Activée pour Divers, à la demande de Papa. Déjà intégré à schema.sql.
alter table comptes.categories add column if not exists counted boolean not null default false;
comment on column comptes.categories.counted is 'colonne Nombre (1 par défaut) dans la saisie et le détail';
update comptes.categories set counted = true where name = 'Divers';
