-- Groupes de conversations avec l'assistant (Tickets, Questions, Santé…).
-- Déjà intégré à schema.sql.
alter table comptes.assistant_conversations add column if not exists groupe text;
