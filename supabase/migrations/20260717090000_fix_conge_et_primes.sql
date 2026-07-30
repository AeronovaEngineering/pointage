-- =============================================
-- MIGRATION: Corrige l'approbation de congé (bug EXTRACT),
-- ajoute le système de primes admin, et passe le crédit mensuel
-- de congé sur une base "anniversaire de la date d'embauche".
-- Date: 2026-07-10
-- =============================================

-- =============================================
-- FIX: approuver_demande plantait avec
-- "function pg_catalog.extract(unknown, integer) does not exist".
-- Cause : (date - date) renvoie déjà un entier en Postgres, on ne peut
-- pas lui appliquer EXTRACT(DAY FROM ...) qui attend un interval.
-- =============================================
CREATE OR REPLACE FUNCTION public.approuver_demande(
  _demande_id UUID,
  _commentaire TEXT DEFAULT NULL
)
RETURNS SETOF public.demandes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id UUID;
  _type TEXT;
  _date_debut DATE;
  _date_fin DATE;
  _solde_actuel DECIMAL;
  _duree_jours DECIMAL;
BEGIN
  SELECT user_id, type, date_debut, date_fin INTO _user_id, _type, _date_debut, _date_fin
  FROM public.demandes
  WHERE id = _demande_id AND statut = 'en_attente';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Demande introuvable ou déjà traitée';
  END IF;

  UPDATE public.demandes
  SET statut = 'approuve',
      commentaire_admin = _commentaire,
      updated_at = NOW()
  WHERE id = _demande_id;

  IF _type = 'conge_annuel' THEN
    -- FIX: (date - date) est déjà un nombre de jours entier, pas un interval.
    _duree_jours := (_date_fin - _date_debut) + 1;

    SELECT solde_actuel INTO _solde_actuel
    FROM public.solde_conges
    WHERE user_id = _user_id;

    IF _solde_actuel IS NULL THEN
      RAISE EXCEPTION 'Solde de congés introuvable';
    END IF;

    IF _solde_actuel < _duree_jours THEN
      RAISE EXCEPTION 'Solde insuffisant: %.2f jours disponibles, %.2f jours demandés', _solde_actuel, _duree_jours;
    END IF;

    UPDATE public.solde_conges
    SET solde_actuel = solde_actuel - _duree_jours,
        historique = historique || jsonb_build_object(
          'date', NOW(),
          'type', 'deduction',
          'motif', 'Congé approuvé',
          'jours', -_duree_jours,
          'demande_id', _demande_id
        ),
        updated_at = NOW()
    WHERE user_id = _user_id;

    UPDATE public.demandes
    SET jours_deduits = _duree_jours
    WHERE id = _demande_id;
  END IF;

  RETURN QUERY SELECT * FROM public.demandes WHERE id = _demande_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.approuver_demande(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approuver_demande(UUID, TEXT) TO authenticated;

-- =============================================
-- Crédit mensuel de congé basé sur l'ANNIVERSAIRE de la date d'embauche
-- (et non plus sur le mois calendaire) : chaque mois complet écoulé
-- depuis l'embauche ajoute 2 jours. Rattrape aussi les mois manqués
-- si la tâche planifiée n'a pas tourné pendant un moment.
-- =============================================
CREATE OR REPLACE FUNCTION public.crediter_soldes_mensuels()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count INT := 0;
  v_emp RECORD;
  v_prochain DATE;
BEGIN
  FOR v_emp IN
    SELECT p.id, p.date_embauche, sc.dernier_credit_mois
    FROM public.profiles p
    JOIN public.solde_conges sc ON sc.user_id = p.id
    WHERE p.actif = true AND p.date_embauche IS NOT NULL
  LOOP
    -- Point de départ : dernier crédit connu, sinon la date d'embauche elle-même
    v_prochain := COALESCE(v_emp.dernier_credit_mois, v_emp.date_embauche) + INTERVAL '1 month';

    WHILE v_prochain <= CURRENT_DATE LOOP
      UPDATE public.solde_conges SET
        solde_actuel = solde_actuel + 2,
        dernier_credit_mois = v_prochain,
        historique = historique || jsonb_build_object(
          'type', 'credit_mensuel',
          'jours', 2,
          'date', now(),
          'anniversaire', v_prochain
        ),
        updated_at = now()
      WHERE user_id = v_emp.id;

      v_count := v_count + 1;
      v_prochain := v_prochain + INTERVAL '1 month';
    END LOOP;
  END LOOP;

  RETURN v_count;
END; $$;

REVOKE EXECUTE ON FUNCTION public.crediter_soldes_mensuels() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crediter_soldes_mensuels() TO authenticated;

-- Planifie l'exécution quotidienne si pg_cron est disponible sur le projet
-- (sans casser la migration si l'extension n'est pas installée).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('crediter-soldes-conges-quotidien')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'crediter-soldes-conges-quotidien');
    PERFORM cron.schedule('crediter-soldes-conges-quotidien', '0 2 * * *', 'SELECT public.crediter_soldes_mensuels();');
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- pg_cron non configuré sur ce projet : à défaut, appeler
  -- public.crediter_soldes_mensuels() manuellement ou via un cron externe.
  NULL;
END $$;

-- =============================================
-- Système de PRIME donnée manuellement par l'admin (indépendant des
-- primes automatiques liées au temps supplémentaire).
-- =============================================
CREATE TABLE IF NOT EXISTS public.primes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  montant NUMERIC(10,2) NOT NULL,
  commentaire TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.primes ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.primes TO authenticated;
GRANT ALL ON public.primes TO service_role;

DROP POLICY IF EXISTS "primes_select_own_or_admin" ON public.primes;
CREATE POLICY "primes_select_own_or_admin" ON public.primes FOR SELECT
  TO authenticated USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE OR REPLACE FUNCTION public.donner_prime(
  _user_id UUID,
  _montant NUMERIC,
  _commentaire TEXT DEFAULT NULL
)
RETURNS public.primes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_row public.primes;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_admin AND role = 'admin') INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Accès admin requis';
  END IF;

  IF _montant IS NULL OR _montant <= 0 THEN
    RAISE EXCEPTION 'Montant invalide';
  END IF;

  INSERT INTO public.primes (user_id, admin_id, montant, commentaire)
  VALUES (_user_id, v_admin, _montant, NULLIF(_commentaire, ''))
  RETURNING * INTO v_row;

  INSERT INTO public.notifications (user_id, titre, message, lien)
  VALUES (
    _user_id,
    '🎉 Vous avez reçu une prime',
    'Une prime de ' || _montant || ' DT vous a été accordée.'
      || CASE WHEN _commentaire IS NOT NULL AND _commentaire <> '' THEN ' Commentaire : ' || _commentaire ELSE '' END,
    '/dashboard'
  );

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.donner_prime(UUID, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.donner_prime(UUID, NUMERIC, TEXT) TO authenticated;