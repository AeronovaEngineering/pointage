
-- 1. Ajouter colonnes de pointage multi-actions
ALTER TABLE public.pointages
  ADD COLUMN IF NOT EXISTS heure_debut_pause time,
  ADD COLUMN IF NOT EXISTS heure_fin_pause time,
  ADD COLUMN IF NOT EXISTS heure_sortie time,
  ADD COLUMN IF NOT EXISTS taches_realisees text;

-- 2. Ajouter FK vers profiles (pour permettre les joins PostgREST côté admin)
ALTER TABLE public.demandes
  DROP CONSTRAINT IF EXISTS demandes_user_profile_fk;
ALTER TABLE public.demandes
  ADD CONSTRAINT demandes_user_profile_fk
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.justificatifs_maladie
  DROP CONSTRAINT IF EXISTS justif_user_profile_fk;
ALTER TABLE public.justificatifs_maladie
  ADD CONSTRAINT justif_user_profile_fk
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- 3. Fonction pointage multi-actions
CREATE OR REPLACE FUNCTION public.pointer_action(_action text, _taches text DEFAULT NULL)
RETURNS public.pointages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_now timestamptz := now();
  v_date date := (v_now AT TIME ZONE 'Africa/Tunis')::date;
  v_time time := (v_now AT TIME ZONE 'Africa/Tunis')::time;
  v_row public.pointages;
  v_statut public.pointage_statut;
  v_retard int;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;
  SELECT * INTO v_row FROM public.pointages WHERE user_id = v_user AND date = v_date FOR UPDATE;

  IF _action = 'arrivee' THEN
    IF v_row.id IS NOT NULL AND v_row.heure_pointage IS NOT NULL THEN
      RAISE EXCEPTION 'Vous avez déjà pointé votre arrivée aujourd''hui';
    END IF;
    IF v_time <= TIME '09:00:00' THEN
      v_statut := 'present'::public.pointage_statut; v_retard := NULL;
    ELSE
      v_statut := 'retard'::public.pointage_statut;
      v_retard := EXTRACT(EPOCH FROM (v_time - TIME '09:00:00'))::int / 60;
    END IF;
    IF v_row.id IS NULL THEN
      INSERT INTO public.pointages (user_id, date, heure_pointage, statut, retard_minutes)
      VALUES (v_user, v_date, v_time, v_statut, v_retard) RETURNING * INTO v_row;
    ELSE
      UPDATE public.pointages SET heure_pointage = v_time, statut = v_statut, retard_minutes = v_retard
        WHERE id = v_row.id RETURNING * INTO v_row;
    END IF;
  ELSIF _action = 'pause_debut' THEN
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'Pointez votre arrivée d''abord'; END IF;
    UPDATE public.pointages SET heure_debut_pause = v_time WHERE id = v_row.id RETURNING * INTO v_row;
  ELSIF _action = 'pause_fin' THEN
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'Aucun pointage aujourd''hui'; END IF;
    UPDATE public.pointages SET heure_fin_pause = v_time WHERE id = v_row.id RETURNING * INTO v_row;
  ELSIF _action = 'sortie' THEN
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'Aucun pointage aujourd''hui'; END IF;
    UPDATE public.pointages
      SET heure_sortie = v_time,
          taches_realisees = COALESCE(NULLIF(_taches, ''), taches_realisees)
      WHERE id = v_row.id RETURNING * INTO v_row;
  ELSE
    RAISE EXCEPTION 'Action inconnue: %', _action;
  END IF;

  RETURN v_row;
END; $$;

-- 4. Fonction de seed pour données mock (admin uniquement, ne crée pas de auth.users)
-- Elle crée des pointages/demandes fictifs pour les employés existants
CREATE OR REPLACE FUNCTION public.seed_mock_data()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_emp record;
  v_day date;
  v_stat public.pointage_statut;
  v_h time;
  v_retard int;
  v_count_p int := 0;
  v_count_d int := 0;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'Accès refusé'; END IF;

  FOR v_emp IN SELECT id FROM public.profiles WHERE actif = true LOOP
    FOR i IN 1..30 LOOP
      v_day := CURRENT_DATE - i;
      IF EXTRACT(DOW FROM v_day) IN (0, 6) THEN CONTINUE; END IF;
      -- 70% présent, 15% retard, 10% absent, 5% congé
      CASE (random() * 100)::int % 20
        WHEN 0,1 THEN v_stat := 'absent'; v_h := NULL; v_retard := NULL;
        WHEN 2 THEN v_stat := 'conge'; v_h := NULL; v_retard := NULL;
        WHEN 3,4,5 THEN
          v_stat := 'retard'; v_retard := 5 + (random() * 45)::int;
          v_h := TIME '09:00:00' + (v_retard || ' minutes')::interval;
        ELSE
          v_stat := 'present';
          v_h := TIME '08:30:00' + ((random() * 25)::int || ' minutes')::interval;
          v_retard := NULL;
      END CASE;
      INSERT INTO public.pointages (user_id, date, heure_pointage, statut, retard_minutes,
        heure_debut_pause, heure_fin_pause, heure_sortie, taches_realisees)
      VALUES (v_emp.id, v_day, v_h, v_stat, v_retard,
        CASE WHEN v_stat IN ('present','retard') THEN TIME '12:00:00' + ((random()*30)::int||' minutes')::interval ELSE NULL END,
        CASE WHEN v_stat IN ('present','retard') THEN TIME '13:00:00' + ((random()*30)::int||' minutes')::interval ELSE NULL END,
        CASE WHEN v_stat IN ('present','retard') THEN TIME '17:30:00' + ((random()*60)::int||' minutes')::interval ELSE NULL END,
        CASE WHEN v_stat IN ('present','retard') THEN 'Développement, réunions équipe, revue de code' ELSE NULL END)
      ON CONFLICT (user_id, date) DO NOTHING;
      v_count_p := v_count_p + 1;
    END LOOP;

    -- Quelques demandes exemples
    INSERT INTO public.demandes (user_id, type, date_debut, date_fin, motif, statut)
    VALUES
      (v_emp.id, 'conge_annuel', CURRENT_DATE + 10, CURRENT_DATE + 12, 'Vacances familiales', 'en_attente'),
      (v_emp.id, 'sortie_anticipee', CURRENT_DATE + 2, CURRENT_DATE + 2, 'Rendez-vous médical', 'en_attente')
    ON CONFLICT DO NOTHING;
    v_count_d := v_count_d + 2;
  END LOOP;

  RETURN jsonb_build_object('pointages', v_count_p, 'demandes', v_count_d);
END; $$;
