-- Employee record: family situation & number of children, used on the
-- fiche de paie PDF (informations employé block).
alter table public.profiles
  add column if not exists nombre_enfants integer,
  add column if not exists situation_familiale text;

-- Fiche de paie: mode / type de virement is chosen per payslip from the
-- admin's Fiche de paie page, not stored on the employee profile.
alter table public.fiches_paie
  add column if not exists mode_paiement text;