-- Migration: Add location verification to pause_fin and sortie branches
-- Date: 2026-07-21

CREATE OR REPLACE FUNCTION public.pointer_action(
    _action text,
    _lat double precision DEFAULT NULL,
    _lng double precision DEFAULT NULL,
    _taches text DEFAULT NULL
)
RETURNS public.pointages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.pointages;
    v_time timestamptz := now();
    v_retard interval;
    v_temps_sup interval;
    v_bureau record;
    v_distance double precision;
BEGIN
    -- Récupérer le pointage ouvert de l'utilisateur
    SELECT * INTO v_row
    FROM public.pointages
    WHERE user_id = auth.uid()
      AND date_pointage = CURRENT_DATE
      AND heure_fin IS NULL
    ORDER BY id DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Aucun pointage ouvert pour aujourd''hui';
    END IF;

    -- Récupérer les paramètres du bureau
    SELECT * INTO v_bureau
    FROM public.parametres_bureau
    LIMIT 1;

    CASE _action
        WHEN 'arrivee' THEN
            -- Vérification de localisation pour l'arrivée
            IF v_bureau.latitude IS NOT NULL AND v_bureau.longitude IS NOT NULL THEN
                IF _lat IS NULL OR _lng IS NULL THEN
                    RAISE EXCEPTION 'Localisation requise pour pointer votre arrivée. Autorisez l''accès à la position.';
                END IF;

                v_distance := public.distance_metres(_lat, _lng, v_bureau.latitude, v_bureau.longitude);

                IF v_distance > v_bureau.rayon_metres THEN
                    RAISE EXCEPTION 'Vous devez être au bureau pour pointer votre arrivée (à % m, autorisé % m)',
                        round(v_distance::numeric, 2), v_bureau.rayon_metres;
                END IF;
            END IF;

            -- Mise à jour heure_debut
            UPDATE public.pointages
            SET heure_debut = v_time
            WHERE id = v_row.id
            RETURNING * INTO v_row;

        WHEN 'pause_debut' THEN
            -- Mise à jour heure_debut_pause
            UPDATE public.pointages
            SET heure_debut_pause = v_time
            WHERE id = v_row.id
            RETURNING * INTO v_row;

        WHEN 'pause_fin' THEN
            -- Vérification de localisation pour la reprise
            IF v_bureau.latitude IS NOT NULL AND v_bureau.longitude IS NOT NULL THEN
                IF _lat IS NULL OR _lng IS NULL THEN
                    RAISE EXCEPTION 'Localisation requise pour reprendre le travail. Autorisez l''accès à la position.';
                END IF;

                v_distance := public.distance_metres(_lat, _lng, v_bureau.latitude, v_bureau.longitude);

                IF v_distance > v_bureau.rayon_metres THEN
                    RAISE EXCEPTION 'Vous devez être au bureau pour reprendre le travail (à % m, autorisé % m)',
                        round(v_distance::numeric, 2), v_bureau.rayon_metres;
                END IF;
            END IF;

            -- Mise à jour heure_fin_pause
            UPDATE public.pointages
            SET heure_fin_pause = v_time
            WHERE id = v_row.id
            RETURNING * INTO v_row;

        WHEN 'sortie' THEN
            -- Vérification de localisation pour la sortie
            IF v_bureau.latitude IS NOT NULL AND v_bureau.longitude IS NOT NULL THEN
                IF _lat IS NULL OR _lng IS NULL THEN
                    RAISE EXCEPTION 'Localisation requise pour pointer votre sortie. Autorisez l''accès à la position.';
                END IF;

                v_distance := public.distance_metres(_lat, _lng, v_bureau.latitude, v_bureau.longitude);

                IF v_distance > v_bureau.rayon_metres THEN
                    RAISE EXCEPTION 'Vous devez être au bureau pour pointer votre sortie (à % m, autorisé % m)',
                        round(v_distance::numeric, 2), v_bureau.rayon_metres;
                END IF;
            END IF;

            -- Calcul des heures travaillées et des retards
            v_retard := public.calculer_retard(v_row.heure_debut);
            v_temps_sup := public.calculer_temps_sup(v_row.heure_debut, v_time);

            -- Mise à jour de la sortie
            UPDATE public.pointages
            SET
                heure_fin = v_time,
                retard = v_retard,
                temps_sup = v_temps_sup,
                taches = COALESCE(_taches, taches)
            WHERE id = v_row.id
            RETURNING * INTO v_row;

        ELSE
            RAISE EXCEPTION 'Action non valide. Utilisez: arrivee, pause_debut, pause_fin, sortie';
    END CASE;

    RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.pointer_action(text, double precision, double precision, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pointer_action(text, double precision, double precision, text) TO authenticated;