
-- ============ ENUMS ============
CREATE TYPE public.app_role AS ENUM ('admin', 'employe');
CREATE TYPE public.pointage_statut AS ENUM ('present', 'retard', 'absent', 'absent_justifie', 'conge');
CREATE TYPE public.demande_type AS ENUM ('conge_annuel', 'sortie_anticipee', 'absence_exceptionnelle');
CREATE TYPE public.demande_statut AS ENUM ('en_attente', 'approuve', 'refuse');
CREATE TYPE public.justif_statut AS ENUM ('en_attente', 'approuve', 'refuse');

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  nom TEXT,
  prenom TEXT,
  telephone TEXT,
  adresse TEXT,
  date_embauche DATE DEFAULT CURRENT_DATE,
  poste TEXT,
  departement TEXT,
  photo_url TEXT,
  actif BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- ============ USER ROLES ============
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION public.is_admin(_user_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT public.has_role(_user_id, 'admin'::public.app_role); $$;

-- ============ POLICIES: profiles ============
CREATE POLICY "profiles_select_own_or_admin" ON public.profiles FOR SELECT
  TO authenticated USING (id = auth.uid() OR public.is_admin(auth.uid()));
CREATE POLICY "profiles_insert_self" ON public.profiles FOR INSERT
  TO authenticated WITH CHECK (id = auth.uid() OR public.is_admin(auth.uid()));
CREATE POLICY "profiles_update_own_or_admin" ON public.profiles FOR UPDATE
  TO authenticated USING (id = auth.uid() OR public.is_admin(auth.uid()));

-- ============ POLICIES: user_roles ============
CREATE POLICY "user_roles_select_own_or_admin" ON public.user_roles FOR SELECT
  TO authenticated USING (user_id = auth.uid() OR public.is_admin(auth.uid()));
CREATE POLICY "user_roles_admin_all" ON public.user_roles FOR ALL
  TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- ============ POINTAGES ============
CREATE TABLE public.pointages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  heure_pointage TIME,
  statut public.pointage_statut NOT NULL,
  retard_minutes INT,
  commentaire TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, date)
);
GRANT SELECT, INSERT, UPDATE ON public.pointages TO authenticated;
GRANT ALL ON public.pointages TO service_role;
ALTER TABLE public.pointages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pointages_select_own_or_admin" ON public.pointages FOR SELECT
  TO authenticated USING (user_id = auth.uid() OR public.is_admin(auth.uid()));
CREATE POLICY "pointages_insert_own" ON public.pointages FOR INSERT
  TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "pointages_admin_all" ON public.pointages FOR UPDATE
  TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

CREATE INDEX pointages_user_date_idx ON public.pointages(user_id, date DESC);

-- ============ DEMANDES ============
CREATE TABLE public.demandes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type public.demande_type NOT NULL,
  date_debut DATE NOT NULL,
  date_fin DATE NOT NULL,
  heure_sortie TIME,
  motif TEXT,
  statut public.demande_statut NOT NULL DEFAULT 'en_attente',
  commentaire_admin TEXT,
  jours_deduits NUMERIC(5,2) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.demandes TO authenticated;
GRANT ALL ON public.demandes TO service_role;
ALTER TABLE public.demandes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "demandes_select_own_or_admin" ON public.demandes FOR SELECT
  TO authenticated USING (user_id = auth.uid() OR public.is_admin(auth.uid()));
CREATE POLICY "demandes_insert_own" ON public.demandes FOR INSERT
  TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "demandes_update_own_pending" ON public.demandes FOR UPDATE
  TO authenticated USING ((user_id = auth.uid() AND statut = 'en_attente') OR public.is_admin(auth.uid()))
  WITH CHECK ((user_id = auth.uid() AND statut = 'en_attente') OR public.is_admin(auth.uid()));
CREATE POLICY "demandes_delete_own_pending" ON public.demandes FOR DELETE
  TO authenticated USING (user_id = auth.uid() AND statut = 'en_attente');

-- ============ JUSTIFICATIFS MALADIE ============
CREATE TABLE public.justificatifs_maladie (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pointage_id UUID REFERENCES public.pointages(id) ON DELETE SET NULL,
  date_concernee DATE NOT NULL,
  image_url TEXT NOT NULL,
  statut public.justif_statut NOT NULL DEFAULT 'en_attente',
  commentaire_admin TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.justificatifs_maladie TO authenticated;
GRANT ALL ON public.justificatifs_maladie TO service_role;
ALTER TABLE public.justificatifs_maladie ENABLE ROW LEVEL SECURITY;

CREATE POLICY "justif_select_own_or_admin" ON public.justificatifs_maladie FOR SELECT
  TO authenticated USING (user_id = auth.uid() OR public.is_admin(auth.uid()));
CREATE POLICY "justif_insert_own" ON public.justificatifs_maladie FOR INSERT
  TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "justif_update_admin" ON public.justificatifs_maladie FOR UPDATE
  TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- ============ SOLDE CONGES ============
CREATE TABLE public.solde_conges (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  solde_actuel NUMERIC(6,2) NOT NULL DEFAULT 0,
  dernier_credit_mois DATE,
  historique JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.solde_conges TO authenticated;
GRANT ALL ON public.solde_conges TO service_role;
ALTER TABLE public.solde_conges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "solde_select_own_or_admin" ON public.solde_conges FOR SELECT
  TO authenticated USING (user_id = auth.uid() OR public.is_admin(auth.uid()));
CREATE POLICY "solde_update_admin" ON public.solde_conges FOR UPDATE
  TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- ============ JOURS FERIES ============
CREATE TABLE public.jours_feries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  libelle TEXT NOT NULL,
  recurrent BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(date, libelle)
);
GRANT SELECT ON public.jours_feries TO authenticated;
GRANT ALL ON public.jours_feries TO service_role;
ALTER TABLE public.jours_feries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "feries_select_all" ON public.jours_feries FOR SELECT
  TO authenticated USING (true);
CREATE POLICY "feries_admin_all" ON public.jours_feries FOR ALL
  TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- ============ NOTIFICATIONS ============
CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  titre TEXT NOT NULL,
  message TEXT NOT NULL,
  lien TEXT,
  lue BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notif_select_own" ON public.notifications FOR SELECT
  TO authenticated USING (user_id = auth.uid());
CREATE POLICY "notif_update_own" ON public.notifications FOR UPDATE
  TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============ TRIGGERS ============
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_demandes_updated BEFORE UPDATE ON public.demandes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create profile + solde on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_first_user BOOLEAN;
BEGIN
  SELECT NOT EXISTS(SELECT 1 FROM public.user_roles) INTO v_first_user;

  INSERT INTO public.profiles (id, email, nom, prenom)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'nom', ''),
    COALESCE(NEW.raw_user_meta_data->>'prenom', '')
  );

  INSERT INTO public.solde_conges (user_id, solde_actuel, dernier_credit_mois)
  VALUES (NEW.id, 0, date_trunc('month', CURRENT_DATE)::date);

  -- Le tout premier utilisateur devient admin automatiquement
  IF v_first_user THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'employe');
  END IF;

  RETURN NEW;
END; $$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Fonction : pointer (côté serveur pour l'heure)
CREATE OR REPLACE FUNCTION public.effectuer_pointage()
RETURNS public.pointages LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user UUID := auth.uid();
  v_now TIMESTAMPTZ := now();
  v_date DATE := (v_now AT TIME ZONE 'Africa/Tunis')::date;
  v_time TIME := (v_now AT TIME ZONE 'Africa/Tunis')::time;
  v_statut public.pointage_statut;
  v_retard INT := NULL;
  v_row public.pointages;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Non authentifié'; END IF;

  IF v_time < TIME '09:00:00' THEN
    v_statut := 'present';
  ELSIF v_time <= TIME '17:00:00' THEN
    v_statut := 'retard';
    v_retard := EXTRACT(EPOCH FROM (v_time - TIME '09:00:00'))::int / 60;
  ELSE
    v_statut := 'retard';
    v_retard := EXTRACT(EPOCH FROM (v_time - TIME '09:00:00'))::int / 60;
  END IF;

  INSERT INTO public.pointages (user_id, date, heure_pointage, statut, retard_minutes)
  VALUES (v_user, v_date, v_time, v_statut, v_retard)
  ON CONFLICT (user_id, date) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM public.pointages WHERE user_id = v_user AND date = v_date;
  END IF;
  RETURN v_row;
END; $$;
GRANT EXECUTE ON FUNCTION public.effectuer_pointage() TO authenticated;

-- Fonction : approuver une demande (décrémente le solde si congé annuel)
CREATE OR REPLACE FUNCTION public.approuver_demande(_demande_id UUID, _commentaire TEXT DEFAULT NULL)
RETURNS public.demandes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_d public.demandes;
  v_jours NUMERIC;
  v_solde NUMERIC;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'Accès refusé'; END IF;
  SELECT * INTO v_d FROM public.demandes WHERE id = _demande_id FOR UPDATE;
  IF v_d.id IS NULL THEN RAISE EXCEPTION 'Demande introuvable'; END IF;
  IF v_d.statut <> 'en_attente' THEN RAISE EXCEPTION 'Déjà traitée'; END IF;

  IF v_d.type = 'conge_annuel' THEN
    v_jours := (v_d.date_fin - v_d.date_debut) + 1;
    SELECT solde_actuel INTO v_solde FROM public.solde_conges WHERE user_id = v_d.user_id FOR UPDATE;
    IF v_solde < v_jours THEN RAISE EXCEPTION 'Solde insuffisant (% j)', v_solde; END IF;
    UPDATE public.solde_conges SET
      solde_actuel = solde_actuel - v_jours,
      historique = historique || jsonb_build_object('type','debit_conge','jours',v_jours,'date',now(),'demande_id',_demande_id),
      updated_at = now()
    WHERE user_id = v_d.user_id;
    -- Marquer les jours dans le calendrier
    INSERT INTO public.pointages (user_id, date, statut)
    SELECT v_d.user_id, d::date, 'conge'
    FROM generate_series(v_d.date_debut, v_d.date_fin, '1 day'::interval) d
    ON CONFLICT (user_id, date) DO UPDATE SET statut = 'conge';
  END IF;

  UPDATE public.demandes SET
    statut = 'approuve',
    commentaire_admin = _commentaire,
    jours_deduits = CASE WHEN v_d.type='conge_annuel' THEN (v_d.date_fin - v_d.date_debut) + 1 ELSE 0 END
  WHERE id = _demande_id RETURNING * INTO v_d;

  INSERT INTO public.notifications (user_id, titre, message, lien)
  VALUES (v_d.user_id, 'Demande approuvée', 'Votre demande a été approuvée.', '/employe/demandes');
  RETURN v_d;
END; $$;
GRANT EXECUTE ON FUNCTION public.approuver_demande(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.refuser_demande(_demande_id UUID, _commentaire TEXT DEFAULT NULL)
RETURNS public.demandes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_d public.demandes;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'Accès refusé'; END IF;
  UPDATE public.demandes SET statut='refuse', commentaire_admin=_commentaire
    WHERE id=_demande_id AND statut='en_attente' RETURNING * INTO v_d;
  IF v_d.id IS NULL THEN RAISE EXCEPTION 'Introuvable ou déjà traitée'; END IF;
  INSERT INTO public.notifications (user_id, titre, message, lien)
  VALUES (v_d.user_id, 'Demande refusée', COALESCE(_commentaire,'Votre demande a été refusée.'), '/employe/demandes');
  RETURN v_d;
END; $$;
GRANT EXECUTE ON FUNCTION public.refuser_demande(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.traiter_justificatif(_justif_id UUID, _approuve BOOLEAN, _commentaire TEXT DEFAULT NULL)
RETURNS public.justificatifs_maladie LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_j public.justificatifs_maladie;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'Accès refusé'; END IF;
  UPDATE public.justificatifs_maladie
  SET statut = CASE WHEN _approuve THEN 'approuve'::justif_statut ELSE 'refuse'::justif_statut END,
      commentaire_admin = _commentaire
  WHERE id = _justif_id RETURNING * INTO v_j;
  IF v_j.id IS NULL THEN RAISE EXCEPTION 'Justificatif introuvable'; END IF;

  IF _approuve THEN
    INSERT INTO public.pointages (user_id, date, statut)
    VALUES (v_j.user_id, v_j.date_concernee, 'absent_justifie')
    ON CONFLICT (user_id, date) DO UPDATE SET statut = 'absent_justifie';
  END IF;

  INSERT INTO public.notifications (user_id, titre, message, lien)
  VALUES (v_j.user_id,
    CASE WHEN _approuve THEN 'Justificatif approuvé' ELSE 'Justificatif refusé' END,
    COALESCE(_commentaire, 'Votre justificatif a été traité.'), '/employe/demandes');
  RETURN v_j;
END; $$;
GRANT EXECUTE ON FUNCTION public.traiter_justificatif(UUID, BOOLEAN, TEXT) TO authenticated;

-- Marquer absents (cron 17h)
CREATE OR REPLACE FUNCTION public.marquer_absents_du_jour()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_date DATE := (now() AT TIME ZONE 'Africa/Tunis')::date;
  v_count INT := 0;
  v_ferie BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.jours_feries WHERE date = v_date) INTO v_ferie;
  IF v_ferie THEN RETURN 0; END IF;
  IF EXTRACT(DOW FROM v_date) IN (0,6) THEN RETURN 0; END IF;

  INSERT INTO public.pointages (user_id, date, statut)
  SELECT p.id, v_date, 'absent'
  FROM public.profiles p
  WHERE p.actif = true
    AND NOT EXISTS (SELECT 1 FROM public.pointages pt WHERE pt.user_id=p.id AND pt.date=v_date);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.notifications (user_id, titre, message)
  SELECT p.user_id, 'Absence enregistrée', 'Vous avez été marqué absent aujourd''hui.'
  FROM public.pointages p
  WHERE p.date = v_date AND p.statut='absent';
  RETURN v_count;
END; $$;

-- Crédit mensuel (+1.75)
CREATE OR REPLACE FUNCTION public.crediter_soldes_mensuels()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_mois DATE := date_trunc('month', CURRENT_DATE)::date;
  v_count INT := 0;
BEGIN
  UPDATE public.solde_conges SET
    solde_actuel = solde_actuel + 1.75,
    dernier_credit_mois = v_mois,
    historique = historique || jsonb_build_object('type','credit_mensuel','jours',1.75,'date',now()),
    updated_at = now()
  WHERE (dernier_credit_mois IS NULL OR dernier_credit_mois < v_mois)
    AND user_id IN (SELECT id FROM public.profiles WHERE actif = true);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;

-- Ajuster solde (admin)
CREATE OR REPLACE FUNCTION public.ajuster_solde(_user_id UUID, _delta NUMERIC, _motif TEXT)
RETURNS public.solde_conges LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.solde_conges;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'Accès refusé'; END IF;
  UPDATE public.solde_conges SET
    solde_actuel = solde_actuel + _delta,
    historique = historique || jsonb_build_object('type','ajustement_admin','jours',_delta,'motif',_motif,'date',now(),'par',auth.uid()),
    updated_at = now()
  WHERE user_id = _user_id RETURNING * INTO v_row;
  RETURN v_row;
END; $$;
GRANT EXECUTE ON FUNCTION public.ajuster_solde(UUID, NUMERIC, TEXT) TO authenticated;

-- Assigner un rôle (admin)
CREATE OR REPLACE FUNCTION public.definir_role(_user_id UUID, _role public.app_role)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'Accès refusé'; END IF;
  DELETE FROM public.user_roles WHERE user_id = _user_id;
  INSERT INTO public.user_roles (user_id, role) VALUES (_user_id, _role);
END; $$;
GRANT EXECUTE ON FUNCTION public.definir_role(UUID, public.app_role) TO authenticated;

-- Jours fériés Tunisie 2026 fixes
INSERT INTO public.jours_feries (date, libelle, recurrent) VALUES
('2026-01-01','Nouvel An',true),
('2026-03-20','Fête de l''Indépendance',true),
('2026-04-09','Journée des Martyrs',true),
('2026-05-01','Fête du Travail',true),
('2026-07-25','Fête de la République',true),
('2026-10-15','Fête de l''Évacuation',true),
('2026-12-17','Fête de la Révolution et de la Jeunesse',true)
ON CONFLICT DO NOTHING;
