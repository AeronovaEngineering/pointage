-- Passage du crédit mensuel de congé de 1.75 à 2 jours
CREATE OR REPLACE FUNCTION public.crediter_soldes_mensuels()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_mois DATE := date_trunc('month', CURRENT_DATE)::date;
  v_count INT := 0;
BEGIN
  UPDATE public.solde_conges SET
    solde_actuel = solde_actuel + 2,
    dernier_credit_mois = v_mois,
    historique = historique || jsonb_build_object('type','credit_mensuel','jours',2,'date',now()),
    updated_at = now()
  WHERE (dernier_credit_mois IS NULL OR dernier_credit_mois < v_mois)
    AND user_id IN (SELECT id FROM public.profiles WHERE actif = true);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;

-- pointer_action n'avait jamais été explicitement verrouillée : par défaut Postgres
-- l'exécution est ouverte à PUBLIC. La fonction vérifie déjà auth.uid() en interne,
-- mais on referme quand même l'accès anonyme par cohérence avec les autres fonctions.
REVOKE EXECUTE ON FUNCTION public.pointer_action(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pointer_action(text, text) TO authenticated;
