-- Icône choisie à la main pour un article (sinon : émoji déduit du nom). Déjà intégré à schema.sql.
alter table comptes.items add column if not exists icon text;
