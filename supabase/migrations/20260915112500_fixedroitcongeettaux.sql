-- Migration: droit_conge (formule année civile) + taux journalier fixé à 30
-- Date: 2026-09-15
--
-- 1) droit_conge — la version précédente (20260915103000) calculait
--    l'ancienneté ÉCOULÉE jusqu'au mois de la fiche, donc la valeur
--    grossissait de 2j par mois au lieu d'être fixe sur toute l'année
--    civile (bug : un employé embauché en juillet obtenait 4j sur sa fiche
--    d'août, 6j en septembre, etc., au lieu de 12j toute l'année).
--
--    Nouvelle règle (fixe pour les 12 fiches d'une même année civile) :
--      - embauché avant le 1er janvier de l'année de la fiche -> 24j
--      - embauché EN janvier de l'année de la fiche -> 24j
--        (mois d'embauche = janvier -> 12 mois restants x 2 = 24, donc ce
--         cas rentre naturellement dans la même formule que ci-dessous)
--      - embauché dans l'année de la fiche, mois M (M > 1) -> (13 - M) x 2
--          ex : embauché juillet (M=7)    -> (13-7)x2  = 12j
--               embauché septembre (M=9)  -> (13-9)x2  = 8j
--               embauché janvier (M=1)    -> (13-1)x2  = 24j
--      - fiche antérieure au mois d'embauche -> 0j
--      - date d'embauche inconnue (NULL) -> 24j (comportement par défaut,
--        pour ne pas pénaliser l'employé)
--
--    Sanity check en langage clair : pour une année civile donnée, cette
--    valeur est LA MÊME sur les 12 fiches de cette année (elle ne dépend
--    plus du mois de la fiche, seulement de l'année de la fiche et de la
--    date d'embauche) — c'était l'objectif du 20260915103000 mais le calcul
--    ne le faisait pas correctement.
--
-- 2) taux_journalier — le diviseur (jours_reference_paie) était lu depuis
--    parametres_bureau (20, configurable). Nouvelle règle : le diviseur est
--    TOUJOURS 30, fixe, quel que soit le nombre de jours ouvrés réellement
--    travaillés ou en congé dans le mois. Un congé (jours_conge) ne modifie
--    ni ce diviseur ni le montant versé : le congé est déjà couvert par le
--    salaire de base et reste payé normalement (aucune ligne de déduction
--    ni d'ajout pour les jours de congé). Seules les absences non
--    justifiées sont déduites, au même taux_journalier fixe.
--    Sanity check : 6j de congé + 14j de travail (20j au total sur le
--    mois) donnent le même taux_journalier que 20j de travail sans congé —
--    le diviseur ne bouge jamais.
--
-- Rien d'autre ne change par rapport à 20260915103000 (heures sup., jours
-- fériés/repos travaillés, absences, solde_conge, structure de `details`).

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
    v_diviseur NUMERIC := 30; -- FIXE: toujours 30, ne dépend plus de parametres_bureau
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
    v_mois_embauche INT;
    v_annee_embauche INT;
    v_annee_fiche INT;
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

    -- heures_par_jour reste configurable via parametres_bureau ; le diviseur
    -- jours_reference_paie n'est plus lu, v_diviseur reste fixé à 30 ci-dessus.
    SELECT COALESCE(heures_par_jour, 8)
    INTO v_heures_par_jour
    FROM public.parametres_bureau LIMIT 1;
    v_heures_par_jour := COALESCE(v_heures_par_jour, 8);

    SELECT COALESCE(solde_actuel, 0) INTO v_solde_conge FROM public.solde_conges WHERE user_id = _user_id;
    v_solde_conge := COALESCE(v_solde_conge, 0);

    -- Droit congé : solde fixe pour l'année civile de la fiche (voir en-tête).
    v_annee_fiche := EXTRACT(YEAR FROM v_mois_fin)::INT;
    IF v_date_embauche IS NULL THEN
        v_droit_conge := 24;
    ELSE
        v_annee_embauche := EXTRACT(YEAR FROM v_date_embauche)::INT;
        v_mois_embauche := EXTRACT(MONTH FROM v_date_embauche)::INT;

        IF v_annee_embauche < v_annee_fiche THEN
            v_droit_conge := 24;
        ELSIF v_annee_embauche > v_annee_fiche THEN
            -- embauche dans une année postérieure à la fiche : ne devrait
            -- pas arriver en usage normal, traité comme "pas encore recruté"
            v_droit_conge := 0;
        ELSE
            IF v_date_embauche > v_mois_fin THEN
                -- fiche antérieure au mois d'embauche
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

    -- Rates — diviseur toujours 30 (v_diviseur déclaré ainsi ci-dessus, non
    -- écrasé par parametres_bureau). Congés non déduits, non ajoutés : ils
    -- restent couverts par le salaire de base, sans ligne dans `details`.
    v_taux_journalier := CASE WHEN v_diviseur > 0 THEN ROUND(v_salaire_base / v_diviseur, 3) ELSE 0 END;
    v_taux_horaire := CASE WHEN v_heures_par_jour > 0 THEN ROUND(v_taux_journalier / v_heures_par_jour, 3) ELSE 0 END;
    v_taux_horaire_sup := ROUND(v_taux_horaire * 4.0 / 3.0, 3);

    v_heures_sup_brutes := ROUND(v_heures_sup_brutes, 3);
    v_heures_sup_nettes := ROUND(GREATEST(v_heures_sup_brutes - (v_retard_minutes / 60.0), 0), 3);

    v_montant_heures_sup := ROUND(v_heures_sup_nettes * v_taux_horaire_sup, 2);
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