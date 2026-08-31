-- Migration: Grace period de retard (08:30 au lieu de 08:00) + remise à zéro mensuelle du solde d'heures sup
-- Date: 2026-08-31

-- =============================================
-- 1. FIX: pointer_action - statut "retard" uniquement après 08:30 (grace period)
--    Le calcul de v_arrival_delta / bilan_jour_minutes reste ancré sur 08:00 (inchangé)
-- =============================================
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
    v_arrival_delta int;
    v_departure_delta int;
    v_pause_delta int;
    v_bilan int;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Non authentifié';
    END IF;

    -- Check if user is on approved leave
    SELECT EXISTS (
        SELECT 1 FROM public.demandes
        WHERE user_id = v_user AND statut = 'approuve'
            AND type = 'conge_annuel'
            AND date_debut <= v_date AND date_fin >= v_date
    ) INTO v_en_conge;

    IF v_en_conge THEN
        RAISE EXCEPTION 'Vous êtes en congé aujourd''hui, le pointage est désactivé';
    END IF;

    -- Get or create today's record
    SELECT * INTO v_row FROM public.pointages
    WHERE user_id = v_user AND date = v_date
    FOR UPDATE;

    CASE _action
        WHEN 'arrivee' THEN
            -- Check if already arrived today
            IF v_row.id IS NOT NULL AND v_row.heure_pointage IS NOT NULL THEN
                RAISE EXCEPTION 'Vous avez déjà pointé votre arrivée aujourd''hui';
            END IF;

            -- GPS verification
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

            -- FIX: grace period jusqu'à 08:30 pour le statut/retard (était 08:00)
            IF v_time <= TIME '08:30:00' THEN
                v_statut := 'present'::public.pointage_statut;
                v_retard := 0;
            ELSE
                v_statut := 'retard'::public.pointage_statut;
                v_retard := EXTRACT(EPOCH FROM (v_time - TIME '08:30:00'))::int / 60;
            END IF;

            -- Calculate arrival delta (positive if early, negative if late)
            -- Official arrival time is 08:00 (unchanged, no grace period here)
            IF v_time <= TIME '08:00:00' THEN
                v_arrival_delta := EXTRACT(EPOCH FROM (TIME '08:00:00' - v_time))::int / 60;
            ELSE
                v_arrival_delta := -EXTRACT(EPOCH FROM (v_time - TIME '08:00:00'))::int / 60;
            END IF;

            -- Insert or update pointage record
            IF v_row.id IS NULL THEN
                INSERT INTO public.pointages (
                    user_id, date, heure_pointage, statut,
                    retard_minutes, taches_realisees
                )
                VALUES (
                    v_user, v_date, v_time, v_statut,
                    v_retard, _taches
                )
                RETURNING * INTO v_row;
            ELSE
                UPDATE public.pointages
                SET heure_pointage = v_time,
                    statut = v_statut,
                    retard_minutes = v_retard,
                    taches_realisees = COALESCE(_taches, taches_realisees)
                WHERE id = v_row.id
                RETURNING * INTO v_row;
            END IF;

            -- Store the arrival delta in the record for later use
            UPDATE public.pointages
            SET bilan_jour_minutes = v_arrival_delta
            WHERE id = v_row.id;

        WHEN 'pause_debut' THEN
            IF v_row.id IS NULL THEN
                RAISE EXCEPTION 'Pointez votre arrivée d''abord';
            END IF;
            UPDATE public.pointages
            SET heure_debut_pause = v_time
            WHERE id = v_row.id
            RETURNING * INTO v_row;

        WHEN 'pause_fin' THEN
            IF v_row.id IS NULL THEN
                RAISE EXCEPTION 'Aucun pointage aujourd''hui';
            END IF;
            UPDATE public.pointages
            SET heure_fin_pause = v_time
            WHERE id = v_row.id
            RETURNING * INTO v_row;

        WHEN 'sortie' THEN
            IF v_row.id IS NULL THEN
                RAISE EXCEPTION 'Aucun pointage aujourd''hui';
            END IF;

            -- GPS verification for departure
            SELECT * INTO v_bureau FROM public.parametres_bureau WHERE id = 1;
            IF v_bureau.latitude IS NOT NULL AND v_bureau.longitude IS NOT NULL THEN
                IF _lat IS NULL OR _lng IS NULL THEN
                    RAISE EXCEPTION 'Localisation requise pour pointer votre sortie. Autorisez l''accès à la position.';
                END IF;
                v_distance := public.distance_metres(_lat, _lng, v_bureau.latitude, v_bureau.longitude);
                IF v_distance > v_bureau.rayon_metres THEN
                    RAISE EXCEPTION 'Vous devez être au bureau pour pointer votre sortie (à % m, autorisé % m)',
                        round(v_distance)::int, v_bureau.rayon_metres;
                END IF;
            END IF;

            -- Calculate overtime (existing logic - unchanged)
            v_temps_sup := 0;
            IF v_time > TIME '17:00:00' THEN
                v_temps_sup := round((EXTRACT(EPOCH FROM (v_time - TIME '17:00:00')) / 3600)::numeric * 2) / 2;
            END IF;

            -- Pause adjustment (existing logic for overtime - unchanged)
            IF v_row.heure_debut_pause IS NOT NULL AND v_row.heure_fin_pause IS NOT NULL THEN
                v_pause_minutes := EXTRACT(EPOCH FROM (v_row.heure_fin_pause - v_row.heure_debut_pause))::int / 60;
                IF v_pause_minutes >= 0 AND v_pause_minutes < 60 THEN
                    v_temps_sup := v_temps_sup + round(((60 - v_pause_minutes)::numeric / 60) * 2) / 2;
                END IF;
            END IF;

            -- Calculate departure delta (positive if after 17:00, negative if before)
            IF v_time >= TIME '17:00:00' THEN
                v_departure_delta := EXTRACT(EPOCH FROM (v_time - TIME '17:00:00'))::int / 60;
            ELSE
                v_departure_delta := -EXTRACT(EPOCH FROM (TIME '17:00:00' - v_time))::int / 60;
            END IF;

            -- Calculate pause delta (positive if pause < 60min, negative if > 60min)
            v_pause_delta := 0;
            IF v_row.heure_debut_pause IS NOT NULL AND v_row.heure_fin_pause IS NOT NULL THEN
                v_pause_minutes := EXTRACT(EPOCH FROM (v_row.heure_fin_pause - v_row.heure_debut_pause))::int / 60;
                v_pause_delta := 60 - v_pause_minutes;
            END IF;

            -- Calculate arrival delta (recalculate from heure_pointage) - unchanged, anchored on 08:00
            IF v_row.heure_pointage IS NOT NULL THEN
                IF v_row.heure_pointage <= TIME '08:00:00' THEN
                    v_arrival_delta := EXTRACT(EPOCH FROM (TIME '08:00:00' - v_row.heure_pointage))::int / 60;
                ELSE
                    v_arrival_delta := -EXTRACT(EPOCH FROM (v_row.heure_pointage - TIME '08:00:00'))::int / 60;
                END IF;
            ELSE
                v_arrival_delta := 0;
            END IF;

            -- Calculate final bilan_jour_minutes
            v_bilan := v_arrival_delta + v_pause_delta + v_departure_delta;

            -- Update pointage with departure time, tasks, overtime, and bilan
            UPDATE public.pointages
            SET heure_sortie = v_time,
                taches_realisees = COALESCE(NULLIF(_taches, ''), taches_realisees),
                temps_supplementaire = v_temps_sup,
                bilan_jour_minutes = v_bilan
            WHERE id = v_row.id
            RETURNING * INTO v_row;

        ELSE
            RAISE EXCEPTION 'Action inconnue: %', _action;
    END CASE;

    RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.pointer_action(text, double precision, double precision, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pointer_action(text, double precision, double precision, text) TO authenticated;


-- =============================================
-- 2. FIX: get_solde_heures_sup - limiter au mois calendaire en cours
--    (l'historique complet dans pointages / conversions_heures_sup reste intact,
--     seul ce calcul du solde "disponible" est désormais borné au mois courant)
-- =============================================
CREATE OR REPLACE FUNCTION public.get_solde_heures_sup(_user_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total_heures NUMERIC;
    v_converted_heures NUMERIC;
BEGIN
    -- Total overtime hours from pointages, mois calendaire en cours uniquement
    SELECT COALESCE(SUM(temps_supplementaire), 0)
    INTO v_total_heures
    FROM public.pointages
    WHERE user_id = _user_id
        AND date >= date_trunc('month', CURRENT_DATE)
        AND date < date_trunc('month', CURRENT_DATE) + interval '1 month';

    -- Already converted hours, mois calendaire en cours uniquement
    SELECT COALESCE(SUM(heures), 0)
    INTO v_converted_heures
    FROM public.conversions_heures_sup
    WHERE user_id = _user_id
        AND created_at >= date_trunc('month', CURRENT_DATE)
        AND created_at < date_trunc('month', CURRENT_DATE) + interval '1 month';

    RETURN v_total_heures - v_converted_heures;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_solde_heures_sup(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_solde_heures_sup(UUID) TO authenticated;