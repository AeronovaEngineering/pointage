-- Migration: Fiche de paie — ajustements
-- Date: 2026-09-10
--
-- Adds to generer_fiche_paie():
--   1. Overtime pay: heures_supplementaires paid at 1.5x the hourly rate
--      (daily rate / 8h).
--   2. Congé: displayed as a count-only line (0 DT) since it's already
--      covered by the base salary — no deduction, no addition.
--   3. Jours fériés / weekends worked: any pointage with statut
--      'present'/'retard' falling on a Sat/Sun or a jour_ferie is paid at
--      double the daily rate, since those are normally rest days and were
--      never part of jours_ouvres_mois to begin with.
--
-- No schema changes: heures_supplementaires and jours_conge columns already
-- exist and are populated the same way as before; this only changes what
-- goes into `details` and `net_a_payer`.

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
    v_jours_ouvres NUMERIC := 0;
    v_retard_minutes INT := 0;
    v_heures_sup NUMERIC := 0;
    v_montant_primes NUMERIC := 0;
    v_taux_journalier NUMERIC := 0;
    v_montant_deductions NUMERIC := 0;
    v_net NUMERIC := 0;
    v_details JSONB := '[]'::jsonb;
    v_existing public.fiches_paie;
    v_row public.fiches_paie;
    v_jour DATE;
    -- new for this migration
    v_heures_par_jour NUMERIC := 8;
    v_majoration_heures_sup NUMERIC := 1.5;
    v_montant_heures_sup NUMERIC := 0;
    v_jours_repos_travailles NUMERIC := 0;
    v_montant_repos NUMERIC := 0;
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

    -- Working days in the month (Mon-Fri, minus jours_feries), used as the
    -- basis for the daily rate applied to unjustified absences.
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
        COALESCE(SUM(temps_supplementaire), 0)
    INTO v_jours_travailles, v_jours_absence, v_jours_absence_justifiee, v_jours_conge, v_retard_minutes, v_heures_sup
    FROM public.pointages
    WHERE user_id = _user_id AND date BETWEEN v_mois_debut AND v_mois_fin;

    -- Days worked on a normal rest day (Sat/Sun or jour_ferie) — paid double.
    SELECT COUNT(*) INTO v_jours_repos_travailles
    FROM public.pointages p
    WHERE p.user_id = _user_id
      AND p.date BETWEEN v_mois_debut AND v_mois_fin
      AND p.statut IN ('present', 'retard')
      AND (
        EXTRACT(DOW FROM p.date) IN (0, 6)
        OR EXISTS (
          SELECT 1 FROM public.jours_feries jf
          WHERE jf.date = p.date
             OR (jf.recurrent AND to_char(jf.date, 'MM-DD') = to_char(p.date, 'MM-DD'))
        )
      );

    SELECT COALESCE(SUM(montant), 0) INTO v_montant_primes
    FROM public.primes
    WHERE user_id = _user_id AND created_at::date BETWEEN v_mois_debut AND v_mois_fin;

    v_taux_journalier := CASE WHEN v_jours_ouvres > 0 THEN ROUND(v_salaire_base / v_jours_ouvres, 3) ELSE 0 END;
    v_montant_deductions := ROUND(v_jours_absence * v_taux_journalier, 2);

    v_montant_heures_sup := ROUND(v_heures_sup * (v_taux_journalier / v_heures_par_jour) * v_majoration_heures_sup, 2);
    v_montant_repos := ROUND(v_jours_repos_travailles * v_taux_journalier * 2, 2);

    v_net := ROUND(v_salaire_base + v_montant_primes + v_montant_heures_sup + v_montant_repos - v_montant_deductions, 2);

    v_details := jsonb_build_array(
        jsonb_build_object('label', 'Salaire de base', 'montant', v_salaire_base, 'type', 'gain'),
        jsonb_build_object('label', 'Primes du mois', 'montant', v_montant_primes, 'type', 'gain'),
        jsonb_build_object(
            'label',
            'Heures supplémentaires (' || v_heures_sup || 'h × ' || ROUND((v_taux_journalier / v_heures_par_jour) * v_majoration_heures_sup, 3) || ' DT)',
            'montant', v_montant_heures_sup,
            'type', 'gain'
        ),
        jsonb_build_object(
            'label',
            'Jours fériés/repos travaillés (' || v_jours_repos_travailles || ' j × ' || ROUND(v_taux_journalier * 2, 3) || ' DT)',
            'montant', v_montant_repos,
            'type', 'gain'
        ),
        jsonb_build_object(
            'label', 'Congés pris (' || v_jours_conge || ' j)',
            'montant', 0,
            'type', 'gain'
        ),
        jsonb_build_object(
            'label',
            'Absences non justifiées (' || v_jours_absence || ' j × ' || v_taux_journalier || ' DT)',
            'montant', -v_montant_deductions,
            'type', 'deduction'
        )
    );

    IF v_existing.id IS NOT NULL THEN
        UPDATE public.fiches_paie SET
            salaire_base = v_salaire_base,
            jours_travailles = v_jours_travailles,
            jours_absence = v_jours_absence,
            jours_absence_justifiee = v_jours_absence_justifiee,
            jours_conge = v_jours_conge,
            jours_ouvres_mois = v_jours_ouvres,
            retard_minutes = v_retard_minutes,
            heures_supplementaires = v_heures_sup,
            montant_primes = v_montant_primes,
            montant_deductions = v_montant_deductions,
            net_a_payer = v_net,
            details = v_details,
            genere_par = v_admin
        WHERE id = v_existing.id
        RETURNING * INTO v_row;
    ELSE
        INSERT INTO public.fiches_paie (
            user_id, mois, statut, salaire_base, jours_travailles, jours_absence,
            jours_absence_justifiee, jours_conge, jours_ouvres_mois, retard_minutes,
            heures_supplementaires, montant_primes, montant_deductions, net_a_payer,
            details, genere_par
        ) VALUES (
            _user_id, v_mois_debut, 'brouillon', v_salaire_base, v_jours_travailles, v_jours_absence,
            v_jours_absence_justifiee, v_jours_conge, v_jours_ouvres, v_retard_minutes,
            v_heures_sup, v_montant_primes, v_montant_deductions, v_net,
            v_details, v_admin
        )
        RETURNING * INTO v_row;
    END IF;

    RETURN v_row;
END;
$$;