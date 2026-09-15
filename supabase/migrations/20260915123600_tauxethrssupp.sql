-- Migration: persister taux_journalier et taux_horaire_sup (fin du bug PDF)
-- Date: 2026-09-15
--
-- Jusqu'ici, taux_journalier (÷30) et le taux des heures sup. étaient
-- calculés en local dans generer_fiche_paie() mais jamais sauvegardés sur
-- la ligne fiches_paie. Le PDF (fiche-paie-pdf.ts) devinait donc lui-même
-- un "Taux" pour chaque rubrique en faisant montant ÷ nombre — et pour la
-- ligne "Salaire de base" / "Nombre de jours présent", il utilisait
-- `salaire_base ÷ jours_travailles` (jours réellement travaillés), pas le
-- vrai taux_journalier ÷30. C'est ce bug d'affichage qui donnait
-- l'impression que le taux "ne suivait pas" le fix à 30.
--
-- Fix : on stocke maintenant les deux taux réels sur la fiche, calculés une
-- seule fois côté SQL, pour que le PDF n'ait plus jamais à les redériver :
--   - taux_journalier      = salaire_base / 30 (fixe)
--   - taux_horaire_sup     = taux effectif moyen payé sur les heures sup. du
--     mois (montant_heures_sup / heures_supplementaires nettes). Comme
--     AeroNova ne dépasse quasiment jamais 48h/semaine, ce sera dans la
--     quasi-totalité des cas exactement taux_horaire × 1.25 (palier 1 apuré
--     seul) ; si une semaine dépassait un jour 48h, ce taux refléterait la
--     moyenne pondérée des deux paliers pour le mois plutôt que d'afficher
--     un chiffre faux.
--
-- Rien d'autre ne change dans le calcul (paliers 25%/50% par semaine,
-- absences, congé, jours fériés/repos travaillés, droit_conge, solde_conge).

ALTER TABLE public.fiches_paie
ADD COLUMN IF NOT EXISTS taux_journalier NUMERIC(10,3) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS taux_horaire_sup NUMERIC(10,3) NOT NULL DEFAULT 0;

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
    v_diviseur NUMERIC := 30;
    v_heures_par_jour NUMERIC := 8;
    v_retard_minutes INT := 0;
    v_heures_sup_brutes NUMERIC := 0;
    v_heures_sup_nettes NUMERIC := 0;
    v_montant_primes NUMERIC := 0;
    v_taux_journalier NUMERIC := 0;
    v_taux_horaire NUMERIC := 0;
    v_taux_horaire_sup_effectif NUMERIC := 0;
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
    v_mois_embauche INT;
    v_annee_embauche INT;
    v_annee_fiche INT;
    v_droit_conge NUMERIC := 24;
    v_heures_regulieres_semaine NUMERIC;
    v_seuil_tier1 NUMERIC;
    v_semaine RECORD;
    v_heures_sem_nettes NUMERIC;
    v_tier1 NUMERIC;
    v_tier2 NUMERIC;
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

    SELECT COALESCE(heures_par_jour, 8)
    INTO v_heures_par_jour
    FROM public.parametres_bureau LIMIT 1;
    v_heures_par_jour := COALESCE(v_heures_par_jour, 8);

    SELECT COALESCE(solde_actuel, 0) INTO v_solde_conge FROM public.solde_conges WHERE user_id = _user_id;
    v_solde_conge := COALESCE(v_solde_conge, 0);

    v_annee_fiche := EXTRACT(YEAR FROM v_mois_fin)::INT;
    IF v_date_embauche IS NULL THEN
        v_droit_conge := 24;
    ELSE
        v_annee_embauche := EXTRACT(YEAR FROM v_date_embauche)::INT;
        v_mois_embauche := EXTRACT(MONTH FROM v_date_embauche)::INT;

        IF v_annee_embauche < v_annee_fiche THEN
            v_droit_conge := 24;
        ELSIF v_annee_embauche > v_annee_fiche THEN
            v_droit_conge := 0;
        ELSE
            IF v_date_embauche > v_mois_fin THEN
                v_droit_conge := 0;
            ELSE
                v_droit_conge := LEAST((13 - v_mois_embauche) * 2, 24);
            END IF;
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

    v_taux_journalier := CASE WHEN v_diviseur > 0 THEN ROUND(v_salaire_base / v_diviseur, 3) ELSE 0 END;
    v_taux_horaire := CASE WHEN v_heures_par_jour > 0 THEN ROUND(v_taux_journalier / v_heures_par_jour, 3) ELSE 0 END;

    v_heures_regulieres_semaine := v_heures_par_jour * 5;
    v_seuil_tier1 := GREATEST(48 - v_heures_regulieres_semaine, 0);

    v_heures_sup_brutes := ROUND(v_heures_sup_brutes, 3);
    v_heures_sup_nettes := 0;
    v_montant_heures_sup := 0;

    FOR v_semaine IN
        SELECT
            date_trunc('week', p.date)::date AS debut,
            COALESCE(SUM(p.temps_supplementaire), 0) AS brutes,
            COALESCE(SUM(p.retard_minutes) FILTER (WHERE p.statut = 'retard'), 0) AS retard
        FROM public.pointages p
        WHERE p.user_id = _user_id AND p.date BETWEEN v_mois_debut AND v_mois_fin
        GROUP BY 1
    LOOP
        v_heures_sem_nettes := ROUND(GREATEST(v_semaine.brutes - (v_semaine.retard / 60.0), 0), 3);
        v_tier1 := LEAST(v_heures_sem_nettes, v_seuil_tier1);
        v_tier2 := GREATEST(v_heures_sem_nettes - v_seuil_tier1, 0);

        v_heures_sup_nettes := v_heures_sup_nettes + v_heures_sem_nettes;
        v_montant_heures_sup := v_montant_heures_sup
            + ROUND(v_tier1 * v_taux_horaire * 1.25, 2)
            + ROUND(v_tier2 * v_taux_horaire * 1.50, 2);
    END LOOP;

    v_heures_sup_nettes := ROUND(v_heures_sup_nettes, 3);
    v_montant_heures_sup := ROUND(v_montant_heures_sup, 2);

    -- Taux effectif moyen affiché sur le PDF pour les heures sup. Quasi
    -- toujours = taux_horaire × 1.25 (AeroNova ne dépasse presque jamais
    -- 48h/semaine) ; si un mois contenait une semaine >48h, ce taux montre
    -- la moyenne pondérée réellement payée plutôt qu'un chiffre inventé.
    v_taux_horaire_sup_effectif := CASE
        WHEN v_heures_sup_nettes > 0 THEN ROUND(v_montant_heures_sup / v_heures_sup_nettes, 3)
        ELSE ROUND(v_taux_horaire * 1.25, 3)
    END;

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
            taux_journalier = v_taux_journalier,
            taux_horaire_sup = v_taux_horaire_sup_effectif,
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
            solde_conge, droit_conge, taux_journalier, taux_horaire_sup, details, genere_par
        ) VALUES (
            _user_id, v_mois_debut, 'brouillon', v_salaire_base, v_jours_travailles, v_jours_absence,
            v_jours_absence_justifiee, v_jours_conge, v_jours_ouvres, v_jours_repos_travailles,
            v_retard_minutes, v_heures_sup_nettes, v_heures_sup_brutes,
            v_montant_primes, v_montant_deductions, v_net,
            v_solde_conge, v_droit_conge, v_taux_journalier, v_taux_horaire_sup_effectif, v_details, v_admin
        )
        RETURNING * INTO v_row;
    END IF;

    RETURN v_row;
END;
$$;