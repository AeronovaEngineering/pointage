-- Migration: Add mode_heures_sup to parametres_bureau
-- Date: 2026-08-27

-- Add column with default 'prime' and constraint
ALTER TABLE public.parametres_bureau
ADD COLUMN IF NOT EXISTS mode_heures_sup TEXT NOT NULL DEFAULT 'prime'
CHECK (mode_heures_sup IN ('prime', 'paie'));

COMMENT ON COLUMN public.parametres_bureau.mode_heures_sup IS 'Mode de gestion des heures supplémentaires: prime (conversion automatique en prime) ou paie (aucune conversion automatique, payé manuellement)';

-- Update traiter_temps_plus function to check mode_heures_sup
CREATE OR REPLACE FUNCTION public.traiter_temps_plus(_user_id UUID, _date DATE, _choix TEXT, _commentaire TEXT DEFAULT NULL)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _pointage_id UUID;
  _temps_sup DECIMAL;
  _admin_id UUID := auth.uid();
  _is_admin BOOLEAN;
  _prime_montant DECIMAL;
  _mode_heures_sup TEXT;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _admin_id AND role = 'admin') INTO _is_admin;
  IF NOT _is_admin THEN RETURN QUERY SELECT FALSE, 'Accès admin requis'; RETURN; END IF;

  -- Get the current mode from parametres_bureau
  SELECT mode_heures_sup INTO _mode_heures_sup
  FROM public.parametres_bureau
  WHERE id = 1;

  -- If mode is 'paie', no automatic conversion is performed
  IF _mode_heures_sup = 'paie' THEN
    RETURN QUERY SELECT FALSE, 'Les heures supplémentaires sont payées avec le salaire. Aucune conversion automatique effectuée.';
    RETURN;
  END IF;

  -- Mode 'prime' (default) - existing behavior
  SELECT id, temps_supplementaire INTO _pointage_id, _temps_sup
  FROM public.pointages
  WHERE user_id = _user_id AND date = _date AND temps_supplementaire IS NOT NULL AND temps_supplementaire > 0;

  IF _pointage_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Aucun temps supplémentaire trouvé pour cette date';
    RETURN;
  END IF;

  IF _choix <> 'bonus' THEN
    RETURN QUERY SELECT FALSE, 'Seul le choix "bonus" est disponible pour le temps supplémentaire';
    RETURN;
  END IF;

  _prime_montant := ROUND(_temps_sup * 10, 2);
  INSERT INTO public.notifications (user_id, titre, message, lien)
  VALUES (_user_id, '🎉 Prime pour temps supplémentaire',
    'Vous avez reçu une prime de ' || _prime_montant || ' DT pour ' || _temps_sup || 'h de travail supplémentaire le ' || _date || '.',
    '/dashboard');

  UPDATE public.pointages SET commentaire = COALESCE(commentaire, '') || ' | Temps sup traité: bonus' WHERE id = _pointage_id;
  RETURN QUERY SELECT TRUE, 'Temps supplémentaire traité avec succès en bonus';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.traiter_temps_plus(UUID, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.traiter_temps_plus(UUID, DATE, TEXT, TEXT) TO authenticated;