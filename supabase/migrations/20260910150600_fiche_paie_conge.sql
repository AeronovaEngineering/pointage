-- Migration: Fiche de paie — congé et absences calculés depuis la source de vérité
-- Date: 2026-09-10
--
-- Bug corrigé : generer_fiche_paie() comptait jours_conge en filtrant les
-- pointages sur statut = 'conge'. Or depuis 20260717090000_fix_conge_et_primes.sql,
-- approuver_demande() ne crée plus de ligne pointages pour un congé approuvé
-- (seule public.demandes / solde_conges est mise à jour) — donc jours_conge
-- valait quasiment toujours 0 sur la fiche.
--
-- De même, jours_absence ne comptait que les lignes pointages avec
-- statut = 'absent', qui ne sont insérées que par le cron
-- marquer_absents_du_jour() (ajouté le 2026-08-27). Les mois antérieurs, ou
-- les jours où le cron n'a pas tourné (pg_cron absent, etc.), n'avaient donc
-- aucune ligne 'absent' et disparaissaient silencieusement de la fiche.
--
-- Fix :
--   * jours_conge = somme des jours (bornés au mois) des demandes de type
--     'conge_annuel' approuvées qui chevauchent le mois — la même source que
--     solde_conges, interrogée en direct plutôt que via une copie dans
--     pointages qui n'est plus tenue à jour.
--   * jours_absence = (lignes pointages statut = 'absent' déjà présentes)
--     + (jours ouvrés du mois, jusqu'à aujourd'hui inclus, sans AUCUNE ligne
--     pointages ET non couverts par un congé approuvé). Un jour ouvré passé
--     sans pointage et sans congé est une absence, qu'une ligne 'absent' ait
--     été créée par le cron ou non. Les jours futurs ne sont jamais comptés.
--
-- Rien d'autre ne change : heures sup., majoration jours de repos travaillés,
-- retard_minutes, etc. restent identiques à 20260910145000.

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
    v_today DATE := (now() AT TIME ZONE 'Africa/Tunis')::date;
    v_heures_par_jour NUMERIC := 8;
    v_majoration_heures_sup NUMERIC := 1.5;
    v_montant_heures_sup NUMERIC := 0;
    v_jours_repos_travailles NUMERIC := 0;
    v_montant_repos NUMERIC := 0;
    -- new for this migration
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

    -- Working days in the month (Mon-Fri, minus jours_feries), used as the
    -- basis for the daily rate applied to unjustified absences. Also counts,
    -- for days up to and including today, whether the employee has ANY
    -- pointage row and whether they're covered by an approved congé — this
    -- is what jours_absence is built from below.
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
    INTO v_jours_travailles, v_absent_avec_ligne, v_jours_absence_justifiee, v_retard_minutes, v_heures_sup
    FROM public.pointages
    WHERE user_id = _user_id AND date BETWEEN v_mois_debut AND v_mois_fin;

    -- Absences = explicit 'absent' rows (e.g. from the daily cron) + working
    -- days up to today with no pointage row at all and no approved congé
    -- covering them (the two sets are disjoint: an explicit row means the
    -- day was already excluded from the "no pointage" loop above).
    v_jours_absence := v_absent_avec_ligne + v_absent_sans_pointage;

    -- Congé = jours (bornés au mois en cours) des demandes de congé annuel
    -- approuvées qui chevauchent le mois. Lue directement depuis `demandes`,
    -- qui est la seule source tenue à jour (pointages.statut = 'conge' ne
    -- l'est plus depuis le fix du 2026-07-17).
    SELECT COALESCE(SUM(
        LEAST(date_fin, v_mois_fin) - GREATEST(date_debut, v_mois_debut) + 1
    ), 0)
    INTO v_jours_conge
    FROM public.demandes
    WHERE user_id = _user_id AND type = 'conge_annuel' AND statut = 'approuve'
      AND date_debut <= v_mois_fin AND date_fin >= v_mois_debut;

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