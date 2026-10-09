-- L'assistant peut supprimer (achats, articles) à la demande, après confirmation.
-- La ligne supprimée est gardée dans le journal pour pouvoir l'annuler.
-- Déjà intégré à schema.sql.
alter table comptes.assistant_actions drop constraint if exists assistant_actions_table_name_check;
alter table comptes.assistant_actions add constraint assistant_actions_table_name_check
  check (table_name in ('purchases', 'monthly_lines', 'fuel_fills', 'annual_payments', 'savings_movements', 'items'));
alter table comptes.assistant_actions drop constraint if exists assistant_actions_action_check;
alter table comptes.assistant_actions add constraint assistant_actions_action_check
  check (action in ('ajout', 'modification', 'suppression'));
alter table comptes.assistant_actions add column if not exists ligne jsonb;

-- L'assistant gère aussi trajets, postes annuels, catégories, objectifs et soldes de mois.
alter table comptes.assistant_actions drop constraint if exists assistant_actions_table_name_check;
alter table comptes.assistant_actions add constraint assistant_actions_table_name_check
  check (table_name in ('purchases', 'monthly_lines', 'fuel_fills', 'annual_payments', 'savings_movements', 'items',
                        'trips', 'annual_provisions', 'categories', 'user_settings', 'months'));
