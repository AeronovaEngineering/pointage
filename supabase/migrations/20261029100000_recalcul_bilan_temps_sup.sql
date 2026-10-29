-- Migration: recalcul automatique de bilan_jour_minutes + temps_supplementaire
-- Date: 2026-10-29
--
-- Problème : quand l'admin corrige les heures (sortie, pause) à la main
-- (dashboard Supabase ou autre), bilan_jour_minutes et temps_supplementaire
-- restaient figés car seul pointer_action('sortie') les calculait.
--
-- Cette migration :
--   1. extrait la formule de pointer_action (version 20260902, paliers 30/40/50)
--      dans deux fonctions réutilisables ;
--   2. ajoute un trigger BEFORE INSERT/UPDATE sur pointages : dès qu'une des
--      heures (arrivée, début/fin pause, sortie) change et que heure_sortie
--      est renseignée, bilan + temps sup sont recalculés ;
--   3. ajoute recalculer_pointages() pour corriger tout l'historique
--      (aperçu par défaut, application avec _appliquer => true).

-- =============================================
-- 1. Fonctions de calcul (même logique que pointer_action)
-- =============================================
CREATE OR REPLACE FUNCTION public.calc_bilan_jour_minutes(
    _arrivee time,
    _debut_pause time,
    _fin_pause time,
    _sortie time
)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_arrival_delta int := 0;
    v_departure_delta int := 0;
    v_pause_delta int := 0;
    v_pause_minutes int;
BEGIN
    IF _sortie IS NULL THEN
        RETURN NULL;
    END IF;

    -- Arrivée : ancrée sur 08:00 (positif si en avance, négatif si en retard)
    IF _arrivee IS NOT NULL THEN
        IF _arrivee <= TIME '08:00:00' THEN
            v_arrival_delta := EXTRACT(EPOCH FROM (TIME '08:00:00' - _arrivee))::int / 60;
        ELSE
            v_arrival_delta := -EXTRACT(EPOCH FROM (_arrivee - TIME '08:00:00'))::int / 60;
        END IF;
    END IF;

    -- Sortie : ancrée sur 17:00
    IF _sortie >= TIME '17:00:00' THEN
        v_departure_delta := EXTRACT(EPOCH FROM (_sortie - TIME '17:00:00'))::int / 60;
    ELSE
        v_departure_delta := -EXTRACT(EPOCH FROM (TIME '17:00:00' - _sortie))::int / 60;
    END IF;

    -- Pause : 60 min de référence (positif si pause < 60 min)
    IF _debut_pause IS NOT NULL AND _fin_pause IS NOT NULL AND _fin_pause >= _debut_pause THEN
        v_pause_minutes := EXTRACT(EPOCH FROM (_fin_pause - _debut_pause))::int / 60;
        v_pause_delta := 60 - v_pause_minutes;
    END IF;

    RETURN v_arrival_delta + v_pause_delta + v_departure_delta;
END;
$$;

CREATE OR REPLACE FUNCTION public.calc_temps_sup_depuis_bilan(_bilan integer)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_floor int;
    v_hours int;
    v_remainder int;
    v_tier numeric;
BEGIN
    IF _bilan IS NULL THEN
        RETURN 0;
    END IF;

    v_floor := GREATEST(_bilan, 0);
    v_hours := v_floor / 60;
    v_remainder := v_floor % 60;

    IF v_remainder < 30 THEN
        v_tier := 0;
    ELSIF v_remainder < 40 THEN
        v_tier := 0.5;
    ELSIF v_remainder < 50 THEN
        v_tier := 0.75;
    ELSE
        v_tier := 1;
    END IF;

    RETURN v_hours + v_tier;
END;
$$;

-- =============================================
-- 2. Trigger : recalcul à chaque modification des heures
-- =============================================
CREATE OR REPLACE FUNCTION public.trg_recalcul_pointage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Pas de sortie => journée pas terminée, on ne touche à rien
    -- (pointer_action('arrivee') gère déjà le bilan partiel).
    IF NEW.heure_sortie IS NULL THEN
        RETURN NEW;
    END IF;

    -- UPDATE qui ne touche pas aux heures : on respecte les valeurs fournies
    -- (ex. correction manuelle directe de temps_supplementaire).
    IF TG_OP = 'UPDATE'
       AND NEW.heure_pointage    IS NOT DISTINCT FROM OLD.heure_pointage
       AND NEW.heure_debut_pause IS NOT DISTINCT FROM OLD.heure_debut_pause
       AND NEW.heure_fin_pause   IS NOT DISTINCT FROM OLD.heure_fin_pause
       AND NEW.heure_sortie      IS NOT DISTINCT FROM OLD.heure_sortie THEN
        RETURN NEW;
    END IF;

    NEW.bilan_jour_minutes := public.calc_bilan_jour_minutes(
        NEW.heure_pointage, NEW.heure_debut_pause, NEW.heure_fin_pause, NEW.heure_sortie
    );
    NEW.temps_supplementaire := public.calc_temps_sup_depuis_bilan(NEW.bilan_jour_minutes);

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pointages_recalcul ON public.pointages;
CREATE TRIGGER trg_pointages_recalcul
    BEFORE INSERT OR UPDATE ON public.pointages
    FOR EACH ROW EXECUTE FUNCTION public.trg_recalcul_pointage();

-- =============================================
-- 3. Rattrapage de l'historique
--    Aperçu : SELECT * FROM public.recalculer_pointages();
--    Appliquer : SELECT * FROM public.recalculer_pointages(_appliquer => true);
--    Filtres optionnels : _user_id, _depuis, _jusqua
--    Ne retourne / ne modifie que les lignes dont la valeur change.
-- =============================================
CREATE OR REPLACE FUNCTION public.recalculer_pointages(
    _user_id uuid DEFAULT NULL,
    _depuis date DEFAULT NULL,
    _jusqua date DEFAULT NULL,
    _appliquer boolean DEFAULT false
)
RETURNS TABLE (
    employe text,
    jour date,
    heure_arrivee time,
    debut_pause time,
    fin_pause time,
    heure_sortie time,
    bilan_avant integer,
    bilan_apres integer,
    temps_sup_avant numeric,
    temps_sup_apres numeric,
    applique boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Réservé aux admins (ou au rôle postgres/service_role : auth.uid() NULL)
    IF auth.uid() IS NOT NULL AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Accès admin requis';
    END IF;

    RETURN QUERY
    WITH calc AS (
        SELECT
            p.id,
            p.user_id AS uid,
            p.date AS d,
            p.heure_pointage AS h_arr,
            p.heure_debut_pause AS h_dp,
            p.heure_fin_pause AS h_fp,
            p.heure_sortie AS h_sortie,
            p.bilan_jour_minutes AS old_bilan,
            p.temps_supplementaire AS old_sup,
            public.calc_bilan_jour_minutes(p.heure_pointage, p.heure_debut_pause, p.heure_fin_pause, p.heure_sortie) AS new_bilan
        FROM public.pointages p
        WHERE p.heure_sortie IS NOT NULL
          AND (_user_id IS NULL OR p.user_id = _user_id)
          AND (_depuis  IS NULL OR p.date >= _depuis)
          AND (_jusqua  IS NULL OR p.date <= _jusqua)
    ),
    calc2 AS (
        SELECT c.*, public.calc_temps_sup_depuis_bilan(c.new_bilan) AS new_sup
        FROM calc c
    ),
    diff AS (
        SELECT * FROM calc2 c
        WHERE c.old_bilan IS DISTINCT FROM c.new_bilan
           OR c.old_sup   IS DISTINCT FROM c.new_sup
    ),
    upd AS (
        UPDATE public.pointages p
        SET bilan_jour_minutes = d.new_bilan,
            temps_supplementaire = d.new_sup
        FROM diff d
        WHERE _appliquer AND p.id = d.id
        RETURNING p.id
    )
    SELECT
        trim(coalesce(pr.prenom, '') || ' ' || coalesce(pr.nom, '')) AS employe,
        d.d, d.h_arr, d.h_dp, d.h_fp, d.h_sortie,
        d.old_bilan, d.new_bilan, d.old_sup, d.new_sup,
        _appliquer AS applique
    FROM diff d
    LEFT JOIN public.profiles pr ON pr.id = d.uid
    ORDER BY 1, 2;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.recalculer_pointages(uuid, date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculer_pointages(uuid, date, date, boolean) TO authenticated;
