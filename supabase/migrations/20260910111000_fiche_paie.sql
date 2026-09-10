-- Migration: Fiches de paie (payslips)
-- Date: 2026-09-10
--
-- Adds a monthly payslip workflow:
--   * public.fiches_paie stores one row per (employee, mois)
--   * generer_fiche_paie() builds/refreshes a DRAFT from pointages/primes/profiles
--   * valider_fiche_paie() locks a draft as final (admin only)
--   * devalider_fiche_paie() reopens a validated fiche for correction (admin only)
--
-- Employees only ever see rows with statut = 'validee'. Drafts are admin-only
-- so employees never see a work-in-progress payslip.

-- =============================================
-- 0. Make sure salaire_base exists (frontend already reads/writes it; some
--    environments may have added it by hand outside the migrations folder).
-- =============================================
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS salaire_base NUMERIC(10,2);

-- =============================================
-- 1. TABLE fiches_paie
-- =============================================
CREATE TABLE IF NOT EXISTS public.fiches_paie (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    mois DATE NOT NULL, -- always the 1st of the month, e.g. 2026-08-01
    statut TEXT NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon', 'validee')),

    salaire_base NUMERIC(10,2) NOT NULL DEFAULT 0,
    jours_travailles NUMERIC(6,2) NOT NULL DEFAULT 0,
    jours_absence NUMERIC(6,2) NOT NULL DEFAULT 0,
    jours_absence_justifiee NUMERIC(6,2) NOT NULL DEFAULT 0,
    jours_conge NUMERIC(6,2) NOT NULL DEFAULT 0,
    jours_ouvres_mois NUMERIC(6,2) NOT NULL DEFAULT 0,
    retard_minutes INT NOT NULL DEFAULT 0,
    heures_supplementaires NUMERIC(6,2) NOT NULL DEFAULT 0,

    montant_primes NUMERIC(10,2) NOT NULL DEFAULT 0,
    montant_deductions NUMERIC(10,2) NOT NULL DEFAULT 0,
    net_a_payer NUMERIC(10,2) NOT NULL DEFAULT 0,

    -- Editable breakdown shown on the payslip, e.g.
    -- [{"label":"Salaire de base","montant":1200,"type":"gain"},
    --  {"label":"Primes du mois","montant":80,"type":"gain"},
    --  {"label":"Absences non justifiées (2j)","montant":-92.3,"type":"deduction"}]
    -- Regenerating a draft recomputes this from scratch; admin can hand-edit
    -- any line (or add new ones) before validating.
    details JSONB NOT NULL DEFAULT '[]'::jsonb,
    commentaire_admin TEXT,

    genere_par UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    valide_par UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    valide_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(user_id, mois)
);

COMMENT ON TABLE public.fiches_paie IS 'Monthly payslips: draft generated from attendance data, reviewed and locked by an admin.';

CREATE INDEX IF NOT EXISTS fiches_paie_user_mois_idx ON public.fiches_paie(user_id, mois DESC);

ALTER TABLE public.fiches_paie ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.fiches_paie TO authenticated;
GRANT ALL ON public.fiches_paie TO service_role;

DROP POLICY IF EXISTS "fiches_paie_select_own_validee_or_admin" ON public.fiches_paie;
CREATE POLICY "fiches_paie_select_own_validee_or_admin" ON public.fiches_paie FOR SELECT
    TO authenticated USING (
        (user_id = auth.uid() AND statut = 'validee')
        OR public.is_admin(auth.uid())
    );

DROP POLICY IF EXISTS "fiches_paie_admin_update" ON public.fiches_paie;
CREATE POLICY "fiches_paie_admin_update" ON public.fiches_paie FOR UPDATE
    TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- No direct INSERT/DELETE policy: rows are only created/removed via the
-- SECURITY DEFINER functions below, which enforce the admin check themselves.

CREATE TRIGGER trg_fiches_paie_updated BEFORE UPDATE ON public.fiches_paie
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- 2. FUNCTION generer_fiche_paie
--    Builds (or refreshes, if still a draft) one employee's payslip for a
--    given month from pointages / primes / profiles. Raises if the fiche for
--    that month is already validated (use devalider_fiche_paie first).
-- =============================================
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

    SELECT COALESCE(SUM(montant), 0) INTO v_montant_primes
    FROM public.primes
    WHERE user_id = _user_id AND created_at::date BETWEEN v_mois_debut AND v_mois_fin;

    v_taux_journalier := CASE WHEN v_jours_ouvres > 0 THEN ROUND(v_salaire_base / v_jours_ouvres, 3) ELSE 0 END;
    v_montant_deductions := ROUND(v_jours_absence * v_taux_journalier, 2);
    v_net := ROUND(v_salaire_base + v_montant_primes - v_montant_deductions, 2);

    v_details := jsonb_build_array(
        jsonb_build_object('label', 'Salaire de base', 'montant', v_salaire_base, 'type', 'gain'),
        jsonb_build_object('label', 'Primes du mois', 'montant', v_montant_primes, 'type', 'gain'),
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

REVOKE EXECUTE ON FUNCTION public.generer_fiche_paie(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generer_fiche_paie(UUID, DATE) TO authenticated;

-- Small helper so the loop above doesn't need to duplicate holiday/weekend
-- logic; mirrors the frontend's estJourOuvre() in src/lib/format.ts.
CREATE OR REPLACE FUNCTION public.estJourOuvre_sql(_jour DATE)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_dow INT := EXTRACT(DOW FROM _jour);
    v_ferie BOOLEAN;
BEGIN
    IF v_dow = 0 OR v_dow = 6 THEN
        RETURN false;
    END IF;
    SELECT EXISTS (
        SELECT 1 FROM public.jours_feries
        WHERE date = _jour OR (recurrent AND to_char(date, 'MM-DD') = to_char(_jour, 'MM-DD'))
    ) INTO v_ferie;
    RETURN NOT v_ferie;
END;
$$;

-- =============================================
-- 3. FUNCTION valider_fiche_paie
--    Locks a draft as final and notifies the employee. Only fields already
--    on the row are used — admins edit via a normal UPDATE (allowed by RLS)
--    before calling this.
-- =============================================
CREATE OR REPLACE FUNCTION public.valider_fiche_paie(_fiche_id UUID)
RETURNS public.fiches_paie
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin UUID := auth.uid();
    v_row public.fiches_paie;
BEGIN
    IF NOT public.is_admin(v_admin) THEN
        RAISE EXCEPTION 'Accès admin requis';
    END IF;

    UPDATE public.fiches_paie
    SET statut = 'validee', valide_par = v_admin, valide_at = now()
    WHERE id = _fiche_id AND statut = 'brouillon'
    RETURNING * INTO v_row;

    IF v_row.id IS NULL THEN
        RAISE EXCEPTION 'Fiche introuvable ou déjà validée';
    END IF;

    INSERT INTO public.notifications (user_id, titre, message, lien)
    VALUES (
        v_row.user_id,
        '💰 Fiche de paie disponible',
        'Votre fiche de paie de ' || to_char(v_row.mois, 'TMMonth YYYY') || ' est prête et peut être téléchargée.',
        '/mes-fiches-paie'
    );

    RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.valider_fiche_paie(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.valider_fiche_paie(UUID) TO authenticated;

-- =============================================
-- 4. FUNCTION devalider_fiche_paie
--    Reopens a validated fiche (e.g. to fix a mistake). Admin only.
-- =============================================
CREATE OR REPLACE FUNCTION public.devalider_fiche_paie(_fiche_id UUID)
RETURNS public.fiches_paie
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin UUID := auth.uid();
    v_row public.fiches_paie;
BEGIN
    IF NOT public.is_admin(v_admin) THEN
        RAISE EXCEPTION 'Accès admin requis';
    END IF;

    UPDATE public.fiches_paie
    SET statut = 'brouillon', valide_par = NULL, valide_at = NULL
    WHERE id = _fiche_id
    RETURNING * INTO v_row;

    IF v_row.id IS NULL THEN
        RAISE EXCEPTION 'Fiche introuvable';
    END IF;

    RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.devalider_fiche_paie(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.devalider_fiche_paie(UUID) TO authenticated;