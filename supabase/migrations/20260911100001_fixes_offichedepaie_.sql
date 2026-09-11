-- Migration: Fiche de paie — fix crash + restore the congé/absence fix
-- Date: 2026-09-11
--
-- Two problems found in the currently-applied migrations:
--
-- 1. CRASH: 20260911100000_fixing_taux_fichepaie.sql reads
--    parametres_bureau.jours_reference_paie, but the migration that was
--    supposed to create that column (20260910130000_fiche_paie_taux_fixe.sql)
--    was never applied — the column genuinely doesn't exist yet. Hence
--    "column jours_reference_paie does not exist".
--
-- 2. SILENT REGRESSION: 20260911100000 did a CREATE OR REPLACE FUNCTION,
--    which replaces the *whole* function body — including the fix from
--    20260910150600_fiche_paie_conge.sql that made jours_absence / jours_conge
--    read from the real source of truth (demandes / "no pointage row at all"
--    detection) instead of stale pointages.statut rows. Applying the rate fix
--    alone silently threw that correctness fix away.
--
-- This migration adds the missing column and merges both fixes into one
-- function: correct absence/congé accounting (from 150600) + correct pay
-- rates (heure = 3.750 DT, heure sup = heure × 4/3 ≈ 5.000 DT, retard hours
-- offset overtime hours, jour férié/repos travaillé = ×1 taux journalier not
-- ×2, solde congé read live from solde_conges).

ALTER TABLE public.parametres_bureau
ADD COLUMN IF NOT EXISTS jours_reference_paie NUMERIC(4,1) NOT NULL DEFAULT 20;

COMMENT ON COLUMN public.parametres_bureau.jours_reference_paie IS
  'Standard number of working days per month used as the divisor for the payslip daily rate (salaire_base / jours_reference_paie), independent of the actual number of working days in a given month.';

CREATE OR REPLACE FUNCTION public.generer_fiche_paie(_user_id UUID, _mois DATE)
RETURNS public.fiches_paie
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin UUID := auth.uid();
    v_mois_debut DATE := date_trunc('month', _mois)::date;
    v_mois_fin DATE := (date_trunc('month', _mois) + interval '1 month - 1 day')::date;
    v_today DATE := (now() AT TIME ZONE 'Africa/Tunis')::date;
    v_salaire_base NUMERIC;
    v_jours_travailles NUMERIC := 0;
    v_jours_absence NUMERIC := 0;
    v_jours_absence_justifiee NUMERIC := 0;
    v_jours_conge NUMERIC := 0;
    v_jours_ouvres NUMERIC := 0; -- informational only, shown on the payslip
    v_jours_repos_travailles NUMERIC := 0; -- weekends/holidays worked, paid ×1 bonus
    v_diviseur NUMERIC := 20;
    v_heures_par_jour NUMERIC := 8;
    v_retard_minutes INT := 0;
    v_heures_sup_brutes NUMERIC := 0;
    v_heures_sup_nettes NUMERIC := 0;
    v_montant_primes NUMERIC := 0;
    v_taux_journalier NUMERIC := 0;
    v_taux_horaire NUMERIC := 0;
    v_taux_horaire_sup NUMERIC := 0;
    v_montant_heures_sup NUMERIC := 0;
    v_montant_repos NUMERIC := 0;
    v_montant_deductions NUMERIC := 0;
    v_net NUMERIC := 0;
    v_solde_conge NUMERIC := 0;
    v_details JSONB := '[]'::jsonb;
    v_existing public.fiches_paie;
    v_row public.fiches_paie;
    v_jour DATE;
    v_absent_sans_pointage NUMERIC := 0;
    v_absent_avec_ligne NUMERIC := 0;
    v_en_conge BOOLEAN;
    v_a_pointage BOOLEAN;
BEGIN
    IF NOT public.is_admin(v_admin) THEN
        RAISE EXCEPTION 'Accès admin requis';
    END IF;

    SELECT * INTO v_existing FROM public.fiches_paie
    WHERE user_id = _user_id AND mois = v_mois_debut;

    IF v_existing.id IS NOT NULL AND v_existing.statut = 'validee' THEN
        RAISE EXCEPTION 'Cette fiche de paie est déjà validée pour ce mois. Dévalidez-la d''abord si vous devez la corriger.';
    END IF;

    SELECT salaire_base INTO v_salaire_base FROM public.profiles WHERE id = _user_id;
    v_salaire_base := COALESCE(v_salaire_base, 0);

    SELECT COALESCE(jours_reference_paie, 20), COALESCE(heures_par_jour, 8)
    INTO v_diviseur, v_heures_par_jour
    FROM public.parametres_bureau LIMIT 1;
    v_diviseur := COALESCE(v_diviseur, 20);
    v_heures_par_jour := COALESCE(v_heures_par_jour, 8);

    SELECT COALESCE(solde_actuel, 0) INTO v_solde_conge FROM public.solde_conges WHERE user_id = _user_id;
    v_solde_conge := COALESCE(v_solde_conge, 0);

    -- Working days in the month, and — for days up to today — whether the
    -- employee has any pointage row and whether they're covered by an
    -- approved congé. This is what jours_absence is built from below (the
    -- fix from 20260910150600, since a day with zero pointage rows never
    -- got a 'absent' status row unless the daily cron ran).
    v_jour := v_mois_debut;
    WHILE v_jour <= v_mois_fin LOOP
        IF public.estJourOuvre_sql(v_jour) THEN
            v_jours_ouvres := v_jours_ouvres + 1;

            IF v_jour <= v_today THEN
                SELECT EXISTS (
                    SELECT 1 FROM public.demandes
                    WHERE user_id = _user_id AND type = 'conge_annuel' AND statut = 'approuve'
                      AND date_debut <= v_jour AND date_fin >= v_jour
                ) INTO v_en_conge;

                IF NOT v_en_conge THEN
                    SELECT EXISTS (
                        SELECT 1 FROM public.pointages WHERE user_id = _user_id AND date = v_jour
                    ) INTO v_a_pointage;

                    IF NOT v_a_pointage THEN
                        v_absent_sans_pointage := v_absent_sans_pointage + 1;
                    END IF;
                END IF;
            END IF;
        END IF;
        v_jour := v_jour + 1;
    END LOOP;

    SELECT
        COUNT(*) FILTER (WHERE statut IN ('present', 'retard')),
        COUNT(*) FILTER (WHERE statut = 'absent'),
        COUNT(*) FILTER (WHERE statut = 'absent_justifie'),
        COALESCE(SUM(retard_minutes) FILTER (WHERE statut = 'retard'), 0),
        COALESCE(SUM(temps_supplementaire), 0)
    INTO v_jours_travailles, v_absent_avec_ligne, v_jours_absence_justifiee, v_retard_minutes, v_heures_sup_brutes
    FROM public.pointages
    WHERE user_id = _user_id AND date BETWEEN v_mois_debut AND v_mois_fin;

    -- Absences = explicit 'absent' rows (e.g. from the daily cron) + working
    -- days up to today with no pointage row at all and no approved congé.
    v_jours_absence := v_absent_avec_ligne + v_absent_sans_pointage;

    -- Congé = jours (bornés au mois) des demandes de congé annuel approuvées
    -- qui chevauchent le mois — lue directement depuis `demandes`, la seule
    -- source tenue à jour.
    SELECT COALESCE(SUM(
        LEAST(date_fin, v_mois_fin) - GREATEST(date_debut, v_mois_debut) + 1
    ), 0)
    INTO v_jours_conge
    FROM public.demandes
    WHERE user_id = _user_id AND type = 'conge_annuel' AND statut = 'approuve'
      AND date_debut <= v_mois_fin AND date_fin >= v_mois_debut;

    -- Days worked on a normal rest day (Sat/Sun or jour_ferie).
    SELECT COUNT(*) INTO v_jours_repos_travailles
    FROM public.pointages p
    WHERE p.user_id = _user_id
      AND p.date BETWEEN v_mois_debut AND v_mois_fin
      AND p.statut IN ('present', 'retard')
      AND (
        EXTRACT(DOW FROM p.date) IN (0, 6)
        OR public.estJourFerie_sql(p.date)
      );

    SELECT COALESCE(SUM(montant), 0) INTO v_montant_primes
    FROM public.primes
    WHERE user_id = _user_id AND created_at::date BETWEEN v_mois_debut AND v_mois_fin;

    -- Rates
    v_taux_journalier := CASE WHEN v_diviseur > 0 THEN ROUND(v_salaire_base / v_diviseur, 3) ELSE 0 END;
    v_taux_horaire := CASE WHEN v_heures_par_jour > 0 THEN ROUND(v_taux_journalier / v_heures_par_jour, 3) ELSE 0 END;
    v_taux_horaire_sup := ROUND(v_taux_horaire * 4.0 / 3.0, 3);

    -- Retard hours offset the overtime hours before they're paid
    -- (e.g. 16h sup − 2h retard = 14h paid).
    v_heures_sup_nettes := GREATEST(v_heures_sup_brutes - (v_retard_minutes / 60.0), 0);

    v_montant_heures_sup := ROUND(v_heures_sup_nettes * v_taux_horaire_sup, 2);
    -- Worked rest day = +1× taux journalier (the base day's pay is already
    -- inside salaire_base — this bonus IS the "double pay", not a second
    -- full day added on top).
    v_montant_repos := ROUND(v_jours_repos_travailles * v_taux_journalier, 2);
    v_montant_deductions := ROUND(v_jours_absence * v_taux_journalier, 2);

    v_net := ROUND(
        v_salaire_base + v_montant_primes + v_montant_heures_sup + v_montant_repos - v_montant_deductions,
        2
    );

    v_details := '[]'::jsonb;
    v_details := v_details || jsonb_build_array(
        jsonb_build_object('label', 'Salaire de base', 'montant', v_salaire_base, 'type', 'gain')
    );
    IF v_montant_primes <> 0 THEN
        v_details := v_details || jsonb_build_array(
            jsonb_build_object('label', 'Primes du mois', 'montant', v_montant_primes, 'type', 'gain')
        );
    END IF;
    IF v_heures_sup_nettes > 0 THEN
        v_details := v_details || jsonb_build_array(
            jsonb_build_object(
                'label', 'Heures supplémentaires (' || v_heures_sup_nettes || ' h × ' || v_taux_horaire_sup || ' DT)',
                'montant', v_montant_heures_sup, 'type', 'gain'
            )
        );
    END IF;
    IF v_jours_repos_travailles > 0 THEN
        v_details := v_details || jsonb_build_array(
            jsonb_build_object(
                'label', 'Jours fériés/repos travaillés (' || v_jours_repos_travailles || ' j × ' || v_taux_journalier || ' DT)',
                'montant', v_montant_repos, 'type', 'gain'
            )
        );
    END IF;
    IF v_jours_absence > 0 THEN
        v_details := v_details || jsonb_build_array(
            jsonb_build_object(
                'label', 'Absences non justifiées (' || v_jours_absence || ' j × ' || v_taux_journalier || ' DT)',
                'montant', -v_montant_deductions, 'type', 'deduction'
            )
        );
    END IF;

    IF v_existing.id IS NOT NULL THEN
        UPDATE public.fiches_paie SET
            salaire_base = v_salaire_base,
            jours_travailles = v_jours_travailles,
            jours_absence = v_jours_absence,
            jours_absence_justifiee = v_jours_absence_justifiee,
            jours_conge = v_jours_conge,
            jours_ouvres_mois = v_jours_ouvres,
            jours_feries_travailles = v_jours_repos_travailles,
            retard_minutes = v_retard_minutes,
            heures_supplementaires = v_heures_sup_nettes,
            montant_primes = v_montant_primes,
            montant_deductions = v_montant_deductions,
            net_a_payer = v_net,
            solde_conge = v_solde_conge,
            droit_conge = 24,
            details = v_details,
            genere_par = v_admin
        WHERE id = v_existing.id
        RETURNING * INTO v_row;
    ELSE
        INSERT INTO public.fiches_paie (
            user_id, mois, statut, salaire_base, jours_travailles, jours_absence,
            jours_absence_justifiee, jours_conge, jours_ouvres_mois, jours_feries_travailles,
            retard_minutes, heures_supplementaires, montant_primes, montant_deductions, net_a_payer,
            solde_conge, droit_conge, details, genere_par
        ) VALUES (
            _user_id, v_mois_debut, 'brouillon', v_salaire_base, v_jours_travailles, v_jours_absence,
            v_jours_absence_justifiee, v_jours_conge, v_jours_ouvres, v_jours_repos_travailles,
            v_retard_minutes, v_heures_sup_nettes, v_montant_primes, v_montant_deductions, v_net,
            v_solde_conge, 24, v_details, v_admin
        )
        RETURNING * INTO v_row;
    END IF;

    RETURN v_row;
END;
$$;