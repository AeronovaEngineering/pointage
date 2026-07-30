-- Localisation du bureau, configurable par l'admin. Une seule ligne (id = 1).
-- Tant que latitude/longitude ne sont pas renseignées, la vérification GPS est
-- simplement ignorée (comportement actuel inchangé) — pas de rupture avant configuration.
CREATE TABLE IF NOT EXISTS public.parametres_bureau (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  latitude double precision,
  longitude double precision,
  rayon_metres int NOT NULL DEFAULT 150,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.parametres_bureau (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.parametres_bureau ENABLE ROW LEVEL SECURITY;
CREATE POLICY "parametres_bureau_select_authenticated" ON public.parametres_bureau
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "parametres_bureau_update_admin" ON public.parametres_bureau
  FOR UPDATE TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- Distance en mètres entre deux points GPS (formule haversine, pas besoin de PostGIS)
CREATE OR REPLACE FUNCTION public.distance_metres(_lat1 double precision, _lng1 double precision, _lat2 double precision, _lng2 double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  SELECT 6371000 * 2 * asin(sqrt(
    sin(radians(_lat2 - _lat1) / 2) ^ 2 +
    cos(radians(_lat1)) * cos(radians(_lat2)) * sin(radians(_lng2 - _lng1) / 2) ^ 2
  ));
$$;

-- L'ancienne signature à 2 arguments devient un overload distinct en SQL (CREATE OR REPLACE
-- avec une liste d'arguments différente ne la remplace pas) : on la supprime explicitement.
DROP FUNCTION IF EXISTS public.pointer_action(text, text);

-- pointer_action : ajoute _lat/_lng optionnels, vérifiés uniquement pour l'action 'arrivee'
-- et uniquement si le bureau a été configuré (parametres_bureau.latitude/longitude non nulles).
CREATE OR REPLACE FUNCTION public.pointer_action(_action text, _taches text DEFAULT NULL, _lat double precision DEFAULT NULL, _lng double precision DEFAULT NULL)
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
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;
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

REVOKE EXECUTE ON FUNCTION public.pointer_action(text, text, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pointer_action(text, text, double precision, double precision) TO authenticated;
