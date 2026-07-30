-- supabase/migrations/20260713010000_retirer_deduction_retard_et_conversion_conge.sql

-- 1) pointer_action : supprime totalement la déduction de solde de congé
--    pour cause de retard. Le retard reste enregistré (retard_minutes,
--    statut = 'retard') mais n'affecte plus jamais solde_conges.
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

    -- Retard enregistré uniquement à titre informatif : AUCUNE déduction
    -- de solde_conges n'est plus appliquée ici, quelle que soit la durée.

  ELSIF _action = 'pause_debut' THEN
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'Pointez votre arrivée d''abord'; END IF;
    UPDATE public.pointages SET heure_debut_pause = v_time WHERE id = v_row.id RETURNING * INTO v_row;
  ELSIF _action = 'pause_fin' THEN
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'Aucun pointage aujourd''hui'; END IF;
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


-- 2) traiter_temps_plus : supprime totalement le choix "conge" (conversion
--    d'heures sup en jours de congé). Seul le "bonus" (prime, notification
--    uniquement) reste possible — aucune écriture dans solde_conges.
CREATE OR REPLACE FUNCTION public.traiter_temps_plus(_user_id UUID, _date DATE, _choix TEXT, _commentaire TEXT DEFAULT NULL)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _pointage_id UUID;
  _temps_sup DECIMAL;
  _admin_id UUID := auth.uid();
  _is_admin BOOLEAN;
  _prime_montant DECIMAL;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _admin_id AND role = 'admin') INTO _is_admin;
  IF NOT _is_admin THEN RETURN QUERY SELECT FALSE, 'Accès admin requis'; RETURN; END IF;

  SELECT id, temps_supplementaire INTO _pointage_id, _temps_sup
  FROM public.pointages
  WHERE user_id = _user_id AND date = _date AND temps_supplementaire IS NOT NULL AND temps_supplementaire > 0;

  IF _pointage_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Aucun temps supplémentaire trouvé pour cette date'; RETURN;
  END IF;

  IF _choix <> 'bonus' THEN
    RETURN QUERY SELECT FALSE, 'Seul le choix "bonus" est disponible pour le temps supplémentaire'; RETURN;
  END IF;

  _prime_montant := ROUND(_temps_sup * 10, 2);
  INSERT INTO public.notifications (user_id, titre, message, lien)
  VALUES (_user_id, '🎉 Prime pour temps supplémentaire',
    'Vous avez reçu une prime de ' || _prime_montant || ' DT pour ' || _temps_sup || 'h de travail supplémentaire le ' || _date || '.',
    '/dashboard');

  UPDATE public.pointages SET commentaire = COALESCE(commentaire, '') || ' | Temps sup traité: bonus' WHERE id = _pointage_id;
  RETURN QUERY SELECT TRUE, 'Temps supplémentaire traité avec succès en bonus';
END; $$;
GRANT EXECUTE ON FUNCTION public.traiter_temps_plus(UUID, DATE, TEXT, TEXT) TO authenticated;