-- Retours de Papa (10/10/2026). Déjà intégré à schema.sql.
-- Litres de chaque plein (consommation aux 100 km sans devoir connaître le prix au litre).
alter table comptes.fuel_fills add column if not exists litres numeric(7,2);
-- Début des statistiques : les mois antérieurs (ancien Excel) restent consultables mais ne
-- comptent plus dans les moyennes, tendances, inflation et liste de courses.
alter table comptes.user_settings add column if not exists stats_from text;
-- Identifiant du ticket scanné (toutes ses lignes le partagent) : revoir ou supprimer un ticket entier.
alter table comptes.purchases add column if not exists ticket_id uuid;
create index if not exists purchases_ticket on comptes.purchases (ticket_id) where ticket_id is not null;
-- Tickets déjà scannés : regroupés d'après leur enregistrement (même instant).
update comptes.purchases p set ticket_id = md5(p.created_at::text)::uuid
where p.note = 'ticket scanné' and p.ticket_id is null;
-- Papa : statistiques à partir d'octobre 2026.
update comptes.user_settings set stats_from = '2026-10-01' where stats_from is null;
