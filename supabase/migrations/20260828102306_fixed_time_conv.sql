-- Migration: Fix pointer_action threshold and implement manual overtime conversion
-- Date: 2026-08-28

-- =============================================
-- 1. FIX: pointer_action - replace 09:00 with 08:00 for status/retard calculation
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

            -- FIX: Use 08:00 for status and delay calculation (was 09:00)
            IF v_time <= TIME '08:00:00' THEN
                v_statut := 'present'::public.pointage_statut;
                v_retard := 0;
            ELSE
                v_statut := 'retard'::public.pointage_statut;
                v_retard := EXTRACT(EPOCH FROM (v_time - TIME '08:00:00'))::int / 60;
            END IF;

            -- Calculate arrival delta (positive if early, negative if late)
            -- Official arrival time is 08:00
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

            -- Calculate arrival delta (recalculate from heure_pointage)
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
-- 2. Remove mode_heures_sup column and traiter_temps_plus function
-- =============================================

-- Drop the column from parametres_bureau
ALTER TABLE public.parametres_bureau
DROP COLUMN IF EXISTS mode_heures_sup;

-- Drop the obsolete function
DROP FUNCTION IF EXISTS public.traiter_temps_plus(UUID, DATE, TEXT, TEXT) CASCADE;


-- =============================================
-- 3. Create conversions_heures_sup table
-- =============================================
CREATE TABLE IF NOT EXISTS public.conversions_heures_sup (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    heures NUMERIC(6,2) NOT NULL CHECK (heures > 0),
    type TEXT NOT NULL CHECK (type IN ('conge', 'prime')),
    jours_conge NUMERIC(6,2),
    montant NUMERIC(10,2),
    commentaire TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.conversions_heures_sup IS 'Tracks conversions of overtime hours to leave days or bonuses';

ALTER TABLE public.conversions_heures_sup ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.conversions_heures_sup TO authenticated;
GRANT ALL ON public.conversions_heures_sup TO service_role;

-- RLS Policy: users can see their own conversions, admins can see all
CREATE POLICY "conversions_heures_sup_select_own_or_admin" ON public.conversions_heures_sup
    FOR SELECT
    TO authenticated
    USING (
        user_id = auth.uid()
        OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
    );

-- No INSERT/UPDATE/DELETE policies - only via the function below


-- =============================================
-- 4. Function: get_solde_heures_sup
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
    -- Total overtime hours from pointages
    SELECT COALESCE(SUM(temps_supplementaire), 0)
    INTO v_total_heures
    FROM public.pointages
    WHERE user_id = _user_id;

    -- Already converted hours
    SELECT COALESCE(SUM(heures), 0)
    INTO v_converted_heures
    FROM public.conversions_heures_sup
    WHERE user_id = _user_id;

    RETURN v_total_heures - v_converted_heures;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_solde_heures_sup(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_solde_heures_sup(UUID) TO authenticated;


-- =============================================
-- 5. Function: convertir_heures_sup
-- =============================================
CREATE OR REPLACE FUNCTION public.convertir_heures_sup(
    _user_id UUID,
    _heures NUMERIC,
    _type TEXT,
    _commentaire TEXT DEFAULT NULL
)
RETURNS public.conversions_heures_sup
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin UUID := auth.uid();
    v_is_admin BOOLEAN;
    v_solde NUMERIC;
    v_jours_conge NUMERIC;
    v_montant NUMERIC;
    v_row public.conversions_heures_sup;
BEGIN
    -- Check if caller is admin
    SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_admin AND role = 'admin')
    INTO v_is_admin;

    IF NOT v_is_admin THEN
        RAISE EXCEPTION 'Accès refusé';
    END IF;

    -- Validate type
    IF _type NOT IN ('conge', 'prime') THEN
        RAISE EXCEPTION 'Type invalide. Utilisez "conge" ou "prime"';
    END IF;

    -- Validate hours
    IF _heures IS NULL OR _heures <= 0 THEN
        RAISE EXCEPTION 'Les heures doivent être un nombre positif';
    END IF;

    -- Check available balance
    v_solde := public.get_solde_heures_sup(_user_id);

    IF _heures > v_solde THEN
        RAISE EXCEPTION 'Solde d''heures supplémentaires insuffisant (solde: % h, demandé: % h)', v_solde, _heures;
    END IF;

    -- Handle conversion based on type
    IF _type = 'conge' THEN
        -- Convert to days off (1h = 0.125 jour = 1/8 de jour)
        v_jours_conge := ROUND(_heures * 0.125, 2);

        -- Update solde_conges
        UPDATE public.solde_conges
        SET solde_actuel = solde_actuel + v_jours_conge,
            historique = historique || jsonb_build_object(
                'date', NOW(),
                'type', 'credit',
                'motif', 'Heures supplémentaires converties en congé',
                'jours', v_jours_conge,
                'admin_id', v_admin,
                'heures_sup', _heures
            ),
            updated_at = NOW()
        WHERE user_id = _user_id;

        -- Insert notification
        INSERT INTO public.notifications (user_id, titre, message, lien)
        VALUES (
            _user_id,
            '📈 Heures supplémentaires converties en congé',
            'Vos ' || _heures || 'h de travail supplémentaire ont été converties en ' || v_jours_conge || ' jours de congé.',
            '/dashboard'
        );

    ELSIF _type = 'prime' THEN
        -- Calculate bonus (10 DT per hour)
        v_montant := ROUND(_heures * 10, 2);

        -- Insert into primes table (using existing pattern)
        INSERT INTO public.primes (user_id, admin_id, montant, commentaire)
        VALUES (
            _user_id,
            v_admin,
            v_montant,
            COALESCE(_commentaire, 'Conversion de ' || _heures || 'h supplémentaires')
        );

        -- Insert notification
        INSERT INTO public.notifications (user_id, titre, message, lien)
        VALUES (
            _user_id,
            '🎉 Heures supplémentaires converties en prime',
            'Vos ' || _heures || 'h de travail supplémentaire ont été converties en une prime de ' || v_montant || ' DT.',
            '/dashboard'
        );
    END IF;

    -- Record the conversion
    INSERT INTO public.conversions_heures_sup (
        user_id,
        admin_id,
        heures,
        type,
        jours_conge,
        montant,
        commentaire
    )
    VALUES (
        _user_id,
        v_admin,
        _heures,
        _type,
        v_jours_conge,
        v_montant,
        _commentaire
    )
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.convertir_heures_sup(UUID, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convertir_heures_sup(UUID, NUMERIC, TEXT, TEXT) TO authenticated;