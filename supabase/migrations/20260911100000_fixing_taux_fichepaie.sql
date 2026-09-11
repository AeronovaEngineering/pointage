-- Migration: Fiche de paie — correct pay-rate calculations
-- Date: 2026-09-11
--
-- Fixes, per HR review of the generated bulletin:
--   * Heure normale = taux_journalier / heures_par_jour (600/20/8 = 3.750 DT/h)
--   * Heure supplémentaire = heure normale × 4/3 (≈ 5.000 DT/h), not × 1.5
--   * Heures sup. payées = heures sup. brutes − heures de retard (floored at 0),
--     e.g. 16h sup − 2h retard = 14h payées
--   * Jour férié travaillé = +1× taux_journalier (the base day's pay is
--     already inside salaire_base, so the "double pay" bonus is the single
--     extra day, not a second full day added on top)
--   * Solde congé now pulled from the real public.solde_conges balance
--     instead of being left blank; droit_conge (24) stored on the row too
--     so the PDF doesn't need a hardcoded constant

ALTER TABLE public.fiches_paie
ADD COLUMN IF NOT EXISTS jours_feries_travailles NUMERIC(6,2) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS solde_conge NUMERIC(6,2) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS droit_conge NUMERIC(6,2) NOT NULL DEFAULT 24;

ALTER TABLE public.parametres_bureau
ADD COLUMN IF NOT EXISTS heures_par_jour NUMERIC(4,2) NOT NULL DEFAULT 8;

COMMENT ON COLUMN public.parametres_bureau.heures_par_jour IS
  'Standard working hours per day, used to derive the hourly rate (taux_journalier / heures_par_jour) for overtime and holiday-worked calculations.';

CREATE OR REPLACE FUNCTION public.estJourFerie_sql(_jour DATE)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.jours_feries
    WHERE date = _jour OR (recurrent AND to_char(date, 'MM-DD') = to_char(_jour, 'MM-DD'))
  );
$$;

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
    v_salaire_base NUMERIC;
    v_jours_travailles NUMERIC := 0;
    v_jours_absence NUMERIC := 0;
    v_jours_absence_justifiee NUMERIC := 0;
    v_jours_conge NUMERIC := 0;
    v_jours_ouvres NUMERIC := 0; -- informational only, shown on the payslip
    v_jours_feries_travailles NUMERIC := 0;
    v_diviseur NUMERIC := 20;    -- fixed reference days/month for the daily rate
    v_heures_par_jour NUMERIC := 8;
    v_retard_minutes INT := 0;
    v_heures_sup_brutes NUMERIC := 0;
    v_heures_sup_nettes NUMERIC := 0;
    v_montant_primes NUMERIC := 0;
    v_taux_journalier NUMERIC := 0;
    v_taux_horaire NUMERIC := 0;
    v_taux_horaire_sup NUMERIC := 0;
    v_montant_heures_sup NUMERIC := 0;
    v_montant_feries NUMERIC := 0;
    v_montant_deductions NUMERIC := 0;
    v_net NUMERIC := 0;
    v_solde_conge NUMERIC := 0;
    v_details JSONB := '[]'::jsonb;
    v_existing public.fiches_paie;
    v_row public.fiches_paie;
    v_jour DATE;
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

    -- Actual working days in the month (Mon-Fri, minus jours_feries) — display only.
    v_jour := v_mois_debut;
    WHILE v_jour <= v_mois_fin LOOP
        IF public.estJourOuvre_sql(v_jour) THEN
            v_jours_ouvres := v_jours_ouvres + 1;
        END IF;
        v_jour := v_jour + 1;
    END LOOP;

    SELECT
        COUNT(*) FILTER (WHERE statut IN ('present', 'retard')),
        COUNT(*) FILTER (WHERE statut = 'absent'),
        COUNT(*) FILTER (WHERE statut = 'absent_justifie'),
        COUNT(*) FILTER (WHERE statut = 'conge'),
        COALESCE(SUM(retard_minutes) FILTER (WHERE statut = 'retard'), 0),
        COALESCE(SUM(temps_supplementaire), 0),
        COUNT(*) FILTER (WHERE statut IN ('present', 'retard') AND public.estJourFerie_sql(date))
    INTO v_jours_travailles, v_jours_absence, v_jours_absence_justifiee, v_jours_conge,
         v_retard_minutes, v_heures_sup_brutes, v_jours_feries_travailles
    FROM public.pointages
    WHERE user_id = _user_id AND date BETWEEN v_mois_debut AND v_mois_fin;

    SELECT COALESCE(SUM(montant), 0) INTO v_montant_primes
    FROM public.primes
    WHERE user_id = _user_id AND created_at::date BETWEEN v_mois_debut AND v_mois_fin;

    -- Rates
    v_taux_journalier := CASE WHEN v_diviseur > 0 THEN ROUND(v_salaire_base / v_diviseur, 3) ELSE 0 END;
    v_taux_horaire := CASE WHEN v_heures_par_jour > 0 THEN ROUND(v_taux_journalier / v_heures_par_jour, 3) ELSE 0 END;
    v_taux_horaire_sup := ROUND(v_taux_horaire * 4.0 / 3.0, 3);

    -- Retard hours offset the overtime hours before they're paid.
    v_heures_sup_nettes := GREATEST(v_heures_sup_brutes - (v_retard_minutes / 60.0), 0);

    v_montant_heures_sup := ROUND(v_heures_sup_nettes * v_taux_horaire_sup, 2);
    v_montant_feries := ROUND(v_jours_feries_travailles * v_taux_journalier, 2);
    v_montant_deductions := ROUND(v_jours_absence * v_taux_journalier, 2);

    v_net := ROUND(
        v_salaire_base + v_montant_primes + v_montant_heures_sup + v_montant_feries - v_montant_deductions,
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
    IF v_jours_feries_travailles > 0 THEN
        v_details := v_details || jsonb_build_array(
            jsonb_build_object(
                'label', 'Jours fériés travaillés majorés (' || v_jours_feries_travailles || ' j × ' || v_taux_journalier || ' DT)',
                'montant', v_montant_feries, 'type', 'gain'
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
            jours_feries_travailles = v_jours_feries_travailles,
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
            v_jours_absence_justifiee, v_jours_conge, v_jours_ouvres, v_jours_feries_travailles,
            v_retard_minutes, v_heures_sup_nettes, v_montant_primes, v_montant_deductions, v_net,
            v_solde_conge, 24, v_details, v_admin
        )
        RETURNING * INTO v_row;
    END IF;

    RETURN v_row;
END;
$$;