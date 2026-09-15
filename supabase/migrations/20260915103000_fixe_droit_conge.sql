-- Migration: droit_conge = solde annuel de l'année civile de la fiche
-- Date: 2026-09-15
--
-- Jusqu'ici, droit_conge était toujours figé à 24, y compris pour un
-- employé recruté en cours d'année (ex : embauché en juillet, sa fiche de
-- paie affichait quand même "24 j" de droit congé). Ce n'est pas correct.
--
-- Nouvelle règle — droit_conge est le solde annuel pour l'année civile de
-- la fiche de paie (même valeur sur les 12 fiches de cette année-là, elle
-- ne grossit pas mois après mois) :
--   - Employé déjà en poste avant le 1er janvier de l'année de la fiche :
--     24 jours pleins pour toute l'année.
--   - Employé recruté DANS l'année de la fiche : 2 jours × nombre de mois
--     restants dans l'année civile à partir du mois d'embauche inclus.
--       ex : embauché en juillet -> 6 mois restants (juil. à déc.) -> 12 j
--            embauché en septembre -> 4 mois restants (sept. à déc.) -> 8 j
--            embauché en janvier -> 12 mois -> 24 j
--   - Chaque 1er janvier, ça repart sur la nouvelle année civile : un
--     employé recruté en juillet aura 12 j sur ses fiches de 2026, puis
--     24 j sur ses fiches de 2027 (il a maintenant une année complète
--     derrière lui pour l'année civile en cours).
--   - Employé recruté après le mois de la fiche (fiche antérieure à son
--     embauche) : 0.
--   - Date d'embauche inconnue (NULL) : on garde l'ancien comportement
--     (24) plutôt que de pénaliser l'employé par défaut.

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
    v_jours_ouvres NUMERIC := 0;
    v_jours_repos_travailles NUMERIC := 0;
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
    v_date_embauche DATE;
    v_mois_anciennete INT;
    v_droit_conge NUMERIC := 24;
BEGIN
    IF NOT public.is_admin(v_admin) THEN
        RAISE EXCEPTION 'Accès admin requis';
    END IF;

    SELECT * INTO v_existing FROM public.fiches_paie
    WHERE user_id = _user_id AND mois = v_mois_debut;

    IF v_existing.id IS NOT NULL AND v_existing.statut = 'validee' THEN
        RAISE EXCEPTION 'Cette fiche de paie est déjà validée pour ce mois. Dévalidez-la d''abord si vous devez la corriger.';
    END IF;

    SELECT salaire_base, date_embauche INTO v_salaire_base, v_date_embauche
    FROM public.profiles WHERE id = _user_id;
    v_salaire_base := COALESCE(v_salaire_base, 0);

    SELECT COALESCE(jours_reference_paie, 20), COALESCE(heures_par_jour, 8)
    INTO v_diviseur, v_heures_par_jour
    FROM public.parametres_bureau LIMIT 1;
    v_diviseur := COALESCE(v_diviseur, 20);
    v_heures_par_jour := COALESCE(v_heures_par_jour, 8);

    SELECT COALESCE(solde_actuel, 0) INTO v_solde_conge FROM public.solde_conges WHERE user_id = _user_id;
    v_solde_conge := COALESCE(v_solde_conge, 0);

    -- Droit congé : au prorata (2j/mois complet) durant la 1ère année
    -- d'ancienneté, 24j pleins ensuite. Ancienneté évaluée à la fin du mois
    -- de la fiche de paie, pas à la date du jour.
    IF v_date_embauche IS NULL THEN
        v_droit_conge := 24;
    ELSE
        v_mois_anciennete :=
            (EXTRACT(YEAR FROM v_mois_fin)::INT - EXTRACT(YEAR FROM v_date_embauche)::INT) * 12
            + (EXTRACT(MONTH FROM v_mois_fin)::INT - EXTRACT(MONTH FROM v_date_embauche)::INT)
            + 1; -- le mois d'embauche compte comme le 1er mois travaillé

        IF v_mois_anciennete >= 12 THEN
            v_droit_conge := 24;
        ELSE
            v_droit_conge := LEAST(GREATEST(v_mois_anciennete, 0) * 2, 24);
        END IF;
    END IF;

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

    v_jours_absence := v_absent_avec_ligne + v_absent_sans_pointage;

    SELECT COALESCE(SUM(
        LEAST(date_fin, v_mois_fin) - GREATEST(date_debut, v_mois_debut) + 1
    ), 0)
    INTO v_jours_conge
    FROM public.demandes
    WHERE user_id = _user_id AND type = 'conge_annuel' AND statut = 'approuve'
      AND date_debut <= v_mois_fin AND date_fin >= v_mois_debut;

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

    -- Rates — all rounded to at most 3 decimals, never left as raw NUMERIC
    -- division output.
    v_taux_journalier := CASE WHEN v_diviseur > 0 THEN ROUND(v_salaire_base / v_diviseur, 3) ELSE 0 END;
    v_taux_horaire := CASE WHEN v_heures_par_jour > 0 THEN ROUND(v_taux_journalier / v_heures_par_jour, 3) ELSE 0 END;
    v_taux_horaire_sup := ROUND(v_taux_horaire * 4.0 / 3.0, 3);

    -- Gross overtime hours, kept as-is; net = gross minus retard hours,
    -- floored at 0. Both rounded to 3 decimals before storage/display —
    -- this rounding was missing before, which is what leaked the raw float
    -- into the rubrique label.
    v_heures_sup_brutes := ROUND(v_heures_sup_brutes, 3);
    v_heures_sup_nettes := ROUND(GREATEST(v_heures_sup_brutes - (v_retard_minutes / 60.0), 0), 3);

    v_montant_heures_sup := ROUND(v_heures_sup_nettes * v_taux_horaire_sup, 2);
    v_montant_repos := ROUND(v_jours_repos_travailles * v_taux_journalier, 2);
    v_montant_deductions := ROUND(v_jours_absence * v_taux_journalier, 2);

    v_net := ROUND(
        v_salaire_base + v_montant_primes + v_montant_heures_sup + v_montant_repos - v_montant_deductions,
        2
    );

    -- Rubrique labels: plain, no "(X × Y)" breakdown — the PDF's Détails
    -- paie table already shows Nombre et Taux as their own columns.
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
            jsonb_build_object('label', 'Heures supplémentaires', 'montant', v_montant_heures_sup, 'type', 'gain')
        );
    END IF;
    IF v_jours_repos_travailles > 0 THEN
        v_details := v_details || jsonb_build_array(
            jsonb_build_object('label', 'Jours fériés/repos travaillés', 'montant', v_montant_repos, 'type', 'gain')
        );
    END IF;
    IF v_jours_absence > 0 THEN
        v_details := v_details || jsonb_build_array(
            jsonb_build_object('label', 'Absences non justifiées', 'montant', -v_montant_deductions, 'type', 'deduction')
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
            heures_supplementaires_brutes = v_heures_sup_brutes,
            montant_primes = v_montant_primes,
            montant_deductions = v_montant_deductions,
            net_a_payer = v_net,
            solde_conge = v_solde_conge,
            droit_conge = v_droit_conge,
            details = v_details,
            genere_par = v_admin
        WHERE id = v_existing.id
        RETURNING * INTO v_row;
    ELSE
        INSERT INTO public.fiches_paie (
            user_id, mois, statut, salaire_base, jours_travailles, jours_absence,
            jours_absence_justifiee, jours_conge, jours_ouvres_mois, jours_feries_travailles,
            retard_minutes, heures_supplementaires, heures_supplementaires_brutes,
            montant_primes, montant_deductions, net_a_payer,
            solde_conge, droit_conge, details, genere_par
        ) VALUES (
            _user_id, v_mois_debut, 'brouillon', v_salaire_base, v_jours_travailles, v_jours_absence,
            v_jours_absence_justifiee, v_jours_conge, v_jours_ouvres, v_jours_repos_travailles,
            v_retard_minutes, v_heures_sup_nettes, v_heures_sup_brutes,
            v_montant_primes, v_montant_deductions, v_net,
            v_solde_conge, v_droit_conge, v_details, v_admin
        )
        RETURNING * INTO v_row;
    END IF;

    RETURN v_row;
END;
$$;