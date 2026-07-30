-- Colonne manquante référencée par pointer_action/traiter_temps_plus mais jamais créée
-- (c'est probablement pour ça que la migration précédente n'a pas pu s'appliquer).
ALTER TABLE public.pointages ADD COLUMN IF NOT EXISTS temps_supplementaire NUMERIC(5,2) NOT NULL DEFAULT 0;

-- Corrige pointer_action : noms d'action alignés sur le frontend (pause_debut/pause_fin),
-- vérification GPS restaurée, et signature unique (supprime toute ambiguïté d'overload).
DROP FUNCTION IF EXISTS public.pointer_action(TEXT, DECIMAL, DECIMAL, TEXT);
DROP FUNCTION IF EXISTS public.pointer_action(text, text, double precision, double precision);

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
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;
  SELECT * INTO v_row FROM public.pointages WHERE user_id = v_user AND date = v_date FOR UPDATE;
  CREATE OR REPLACE FUNCTION public.pointer_action(_action text, _lat double precision DEFAULT NULL, _lng double precision DEFAULT NULL, _taches text DEFAULT NULL)
  RETURNS public.pointages
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $$
  DECLARE
    v_user uuid := auth.uid();
    v_now timestamptz := now();
    v_date date := (v_now AT TIME ZONE 'Africa/Tunis')::date;
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

    IF v_retard >= 120 THEN
      UPDATE public.solde_conges SET
        solde_actuel = GREATEST(solde_actuel - 0.5, 0),
        historique = historique || jsonb_build_object('type','deduction','motif','Retard de ' || v_retard || ' minutes le ' || v_date, 'jours', -0.5, 'date', now()),
        updated_at = now()
      WHERE user_id = v_user;
    END IF;

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

-- Corrige traiter_temps_plus : utilise les vraies colonnes de notifications
-- (user_id, titre, message, lien) au lieu de destinataire_id/expediteur_id/type qui n'existent pas.
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

  IF _choix = 'conge' THEN
    UPDATE public.solde_conges SET
      solde_actuel = solde_actuel + (_temps_sup * 0.125),
      historique = historique || jsonb_build_object('type','credit','motif','Temps sup converti en congé (' || _temps_sup || 'h)', 'jours', _temps_sup * 0.125, 'date', now()),
      updated_at = now()
    WHERE user_id = _user_id;

    INSERT INTO public.notifications (user_id, titre, message, lien)
    VALUES (_user_id, '📈 Temps supplémentaire converti en congé',
      'Vos ' || _temps_sup || 'h de travail supplémentaire du ' || _date || ' ont été converties en ' || ROUND(_temps_sup * 0.125, 2) || ' jours de congé.',
      '/mes-demandes');

  ELSIF _choix = 'bonus' THEN
    _prime_montant := ROUND(_temps_sup * 10, 2);
    INSERT INTO public.notifications (user_id, titre, message, lien)
    VALUES (_user_id, '🎉 Prime pour temps supplémentaire',
      'Vous avez reçu une prime de ' || _prime_montant || '   pour ' || _temps_sup || 'h de travail supplémentaire le ' || _date || '.',
      '/dashboard');
  ELSE
    RETURN QUERY SELECT FALSE, 'Choix invalide. Utilisez "conge" ou "bonus"'; RETURN;
  END IF;

  UPDATE public.pointages SET commentaire = COALESCE(commentaire, '') || ' | Temps sup traité: ' || _choix WHERE id = _pointage_id;
  RETURN QUERY SELECT TRUE, 'Temps supplémentaire traité avec succès en ' || _choix;
END; $$;
GRANT EXECUTE ON FUNCTION public.traiter_temps_plus(UUID, DATE, TEXT, TEXT) TO authenticated;

-- Notifie tous les admins quand une nouvelle demande ou un justificatif arrive (manquant actuellement).
CREATE OR REPLACE FUNCTION public.notifier_admins_nouvelle_demande()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_nom text;
BEGIN
  SELECT COALESCE(prenom || ' ' || nom, email) INTO v_nom FROM public.profiles WHERE id = NEW.user_id;
  INSERT INTO public.notifications (user_id, titre, message, lien)
  SELECT ur.user_id, 'Nouvelle demande', v_nom || ' a soumis une demande à traiter.', '/admin/demandes'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS on_demande_created ON public.demandes;
CREATE TRIGGER on_demande_created AFTER INSERT ON public.demandes
  FOR EACH ROW EXECUTE FUNCTION public.notifier_admins_nouvelle_demande();

CREATE OR REPLACE FUNCTION public.notifier_admins_nouveau_justificatif()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_nom text;
BEGIN
  SELECT COALESCE(prenom || ' ' || nom, email) INTO v_nom FROM public.profiles WHERE id = NEW.user_id;
  INSERT INTO public.notifications (user_id, titre, message, lien)
  SELECT ur.user_id, 'Nouveau justificatif', v_nom || ' a envoyé un justificatif à traiter.', '/admin/demandes'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS on_justificatif_created ON public.justificatifs_maladie;
CREATE TRIGGER on_justificatif_created AFTER INSERT ON public.justificatifs_maladie
  FOR EACH ROW EXECUTE FUNCTION public.notifier_admins_nouveau_justificatif();
