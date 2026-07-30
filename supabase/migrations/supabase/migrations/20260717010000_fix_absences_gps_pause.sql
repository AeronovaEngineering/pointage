-- 1) Restaure la protection week-end / jour férié dans marquer_absents_du_jour
--    (supprimée par erreur dans 20260709000000_rpc_conges_retards.sql), et gère
--    aussi les jours fériés récurrents (même mois/jour, année différente).
CREATE OR REPLACE FUNCTION public.marquer_absents_du_jour()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _today DATE := (now() AT TIME ZONE 'Africa/Tunis')::date;
  _absent_count INTEGER := 0;
  _user_record RECORD;
  _solde_actuel DECIMAL;
  _est_ferie BOOLEAN;
BEGIN
  IF EXTRACT(DOW FROM _today) IN (0, 6) THEN
    RETURN 0;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.jours_feries
    WHERE date = _today
       OR (recurrent AND to_char(date, 'MM-DD') = to_char(_today, 'MM-DD'))
  ) INTO _est_ferie;
  IF _est_ferie THEN
    RETURN 0;
  END IF;

  FOR _user_record IN (
    SELECT p.id, p.actif
    FROM profiles p
    LEFT JOIN pointages pt ON pt.user_id = p.id AND pt.date = _today
    WHERE p.actif = TRUE
      AND pt.id IS NULL
      AND p.id NOT IN (
        SELECT user_id FROM demandes
        WHERE date_debut <= _today AND date_fin >= _today
          AND statut = 'approuve'
      )
  ) LOOP
    INSERT INTO pointages (user_id, date, statut, retard_minutes)
    VALUES (_user_record.id, _today, 'absent', 0);

    SELECT solde_actuel INTO _solde_actuel
    FROM solde_conges
    WHERE user_id = _user_record.id;

    IF _solde_actuel IS NOT NULL AND _solde_actuel > 0 THEN
      UPDATE solde_conges
      SET solde_actuel = GREATEST(solde_actuel - 1, 0),
          historique = historique || jsonb_build_object(
            'date', NOW(),
            'type', 'deduction',
            'motif', 'Absence non justifiée le ' || _today,
            'jours', -1
          ),
          updated_at = NOW()
      WHERE user_id = _user_record.id;
    END IF;

    _absent_count := _absent_count + 1;
  END LOOP;

  RETURN _absent_count;
END;
$$;

-- 2) Vérification GPS aussi pour "fin de pause" (retour de pause), même règle
--    de distance/rayon que pour l'arrivée, uniquement si le bureau est configuré.
CREATE OR REPLACE FUNCTION public.pointer_action(_action text, _lat double precision DEFAULT NULL, _lng double precision DEFAULT NULL, _taches text DEFAULT NULL)
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
  v_bureau public.parametres_bureau;
  v_distance double precision;
  v_temps_sup numeric;
  v_pause_minutes int;
  v_en_conge boolean;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.demandes
    WHERE user_id = v_user AND statut = 'approuve'
      AND type = 'conge_annuel'
      AND date_debut <= v_date AND date_fin >= v_date
  ) INTO v_en_conge;
  IF v_en_conge THEN
    RAISE EXCEPTION 'Vous êtes en congé aujourd''hui, le pointage est désactivé';
  END IF;

  SELECT * INTO v_row FROM public.pointages WHERE user_id = v_user AND date = v_date FOR UPDATE;

  IF _action = 'arrivee' THEN
    IF v_row.id IS NOT NULL AND v_row.heure_pointage IS NOT NULL THEN
      RAISE EXCEPTION 'Vous avez déjà pointé votre arrivée aujourd''hui';
    END IF;

    SELECT * INTO v_bureau FROM public.parametres_bureau WHERE id = 1;
    IF v_bureau.latitude IS NOT NULL AND v_bureau.longitude IS NOT NULL THEN
      IF _lat IS NULL OR _lng IS NULL THEN
        RAISE EXCEPTION 'Localisation requise pour pointer votre arrivée. Autorisez l''accès à la position.';
      END IF;
      v_distance := public.distance_metres(_lat, _lng, v_bureau.latitude, v_bureau.longitude);
      IF v_distance > v_bureau.rayon_metres THEN
        RAISE EXCEPTION 'Vous devez être au bureau pour pointer votre arrivée (à % m, autorisé % m)',
          round(v_distance)::int, v_bureau.rayon_metres;
      END IF;
    END IF;

    IF v_time <= TIME '09:00:00' THEN
      v_statut := 'present'::public.pointage_statut; v_retard := 0;
    ELSE
      v_statut := 'retard'::public.pointage_statut;
      v_retard := EXTRACT(EPOCH FROM (v_time - TIME '09:00:00'))::int / 60;
    END IF;
    IF v_row.id IS NULL THEN
      INSERT INTO public.pointages (user_id, date, heure_pointage, statut, retard_minutes, taches_realisees)
      VALUES (v_user, v_date, v_time, v_statut, v_retard, _taches) RETURNING * INTO v_row;
    ELSE
      UPDATE public.pointages SET heure_pointage = v_time, statut = v_statut, retard_minutes = v_retard,
        taches_realisees = COALESCE(_taches, taches_realisees)
        WHERE id = v_row.id RETURNING * INTO v_row;
    END IF;

  ELSIF _action = 'pause_debut' THEN
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'Pointez votre arrivée d''abord'; END IF;
    UPDATE public.pointages SET heure_debut_pause = v_time WHERE id = v_row.id RETURNING * INTO v_row;

  ELSIF _action = 'pause_fin' THEN
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'Aucun pointage aujourd''hui'; END IF;

    SELECT * INTO v_bureau FROM public.parametres_bureau WHERE id = 1;
    IF v_bureau.latitude IS NOT NULL AND v_bureau.longitude IS NOT NULL THEN
      IF _lat IS NULL OR _lng IS NULL THEN
        RAISE EXCEPTION 'Localisation requise pour pointer la fin de votre pause. Autorisez l''accès à la position.';
      END IF;
      v_distance := public.distance_metres(_lat, _lng, v_bureau.latitude, v_bureau.longitude);
      IF v_distance > v_bureau.rayon_metres THEN
        RAISE EXCEPTION 'Vous devez être au bureau pour reprendre le travail (à % m, autorisé % m)',
          round(v_distance)::int, v_bureau.rayon_metres;
      END IF;
    END IF;

    UPDATE public.pointages SET heure_fin_pause = v_time WHERE id = v_row.id RETURNING * INTO v_row;

  ELSIF _action = 'sortie' THEN
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'Aucun pointage aujourd''hui'; END IF;

    v_temps_sup := 0;
    IF v_time > TIME '17:00:00' THEN
      v_temps_sup := round((EXTRACT(EPOCH FROM (v_time - TIME '17:00:00')) / 3600)::numeric * 2) / 2;
    END IF;
    IF v_row.heure_debut_pause IS NOT NULL AND v_row.heure_fin_pause IS NOT NULL THEN
      v_pause_minutes := EXTRACT(EPOCH FROM (v_row.heure_fin_pause - v_row.heure_debut_pause))::int / 60;
      IF v_pause_minutes >= 0 AND v_pause_minutes < 60 THEN
        v_temps_sup := v_temps_sup + round(((60 - v_pause_minutes)::numeric / 60) * 2) / 2;
      END IF;
    END IF;

    UPDATE public.pointages
      SET heure_sortie = v_time,
          taches_realisees = COALESCE(NULLIF(_taches, ''), taches_realisees),
          temps_supplementaire = v_temps_sup
      WHERE id = v_row.id RETURNING * INTO v_row;
  ELSE
    RAISE EXCEPTION 'Action inconnue: %', _action;
  END IF;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.pointer_action(text, double precision, double precision, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pointer_action(text, double precision, double precision, text) TO authenticated;