-- =============================================
-- MIGRATION: RPC pour la gestion des congés et retards
-- Points #8, #10, #11, #12, #13
-- Date: 2026-07-09
-- =============================================

-- =============================================
-- SUPPRIMER LES FONCTIONS EXISTANTES
-- =============================================
DROP FUNCTION IF EXISTS approuver_demande(UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS marquer_absents_du_jour() CASCADE;
DROP FUNCTION IF EXISTS pointer_action(TEXT, DECIMAL, DECIMAL, TEXT) CASCADE;
DROP FUNCTION IF EXISTS traiter_temps_plus(UUID, DATE, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS calculer_solde_initial(DATE) CASCADE;
DROP FUNCTION IF EXISTS creer_solde_initial() CASCADE;
DROP TRIGGER IF EXISTS trigger_creer_solde_initial ON profiles;

-- =============================================
-- #9: Fonction de calcul du solde initial à l'embauche
-- =============================================
CREATE OR REPLACE FUNCTION calculer_solde_initial(_date_embauche DATE)
RETURNS DECIMAL
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  _mois INTEGER;
  _jours DECIMAL;
  _today DATE := CURRENT_DATE;
BEGIN
  -- Calculer le nombre de mois entre la date d'embauche et aujourd'hui
  _mois := EXTRACT(YEAR FROM _today) * 12 + EXTRACT(MONTH FROM _today) 
           - (EXTRACT(YEAR FROM _date_embauche) * 12 + EXTRACT(MONTH FROM _date_embauche));
  
  -- 2 jours par mois
  _jours := _mois * 2;
  
  -- Si moins d'un mois, minimum 1 jour
  IF _mois = 0 THEN
    _jours := 1;
  END IF;
  
  RETURN _jours;
END;
$$;

-- =============================================
-- #8: Approuver une demande avec décrémentation du solde
-- =============================================
CREATE OR REPLACE FUNCTION approuver_demande(
  _demande_id UUID,
  _commentaire TEXT DEFAULT NULL
)
RETURNS SETOF demandes
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  _user_id UUID;
  _type TEXT;
  _date_debut DATE;
  _date_fin DATE;
  _solde_actuel DECIMAL;
  _duree_jours DECIMAL;
BEGIN
  -- Récupérer la demande
  SELECT user_id, type, date_debut, date_fin INTO _user_id, _type, _date_debut, _date_fin
  FROM demandes
  WHERE id = _demande_id AND statut = 'en_attente';
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Demande introuvable ou déjà traitée';
  END IF;

  -- Mettre à jour le statut
  UPDATE demandes 
  SET statut = 'approuve', 
      commentaire_admin = _commentaire,
      updated_at = NOW()
  WHERE id = _demande_id;

  -- #8: Décrémenter le solde pour les congés
  IF _type = 'conge_annuel' THEN
    -- Calculer le nombre de jours
    _duree_jours := EXTRACT(DAY FROM (_date_fin - _date_debut)) + 1;
    
    -- Récupérer le solde actuel
    SELECT solde_actuel INTO _solde_actuel 
    FROM solde_conges 
    WHERE user_id = _user_id;
    
    IF _solde_actuel IS NULL THEN
      RAISE EXCEPTION 'Solde de congés introuvable';
    END IF;
    
    -- Vérifier si le solde est suffisant
    IF _solde_actuel < _duree_jours THEN
      RAISE EXCEPTION 'Solde insuffisant: %.2f jours disponibles, %.2f jours demandés', _solde_actuel, _duree_jours;
    END IF;
    
    -- Décrémenter le solde
    UPDATE solde_conges 
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
    
    -- Enregistrer le nombre de jours déduits
    UPDATE demandes 
    SET jours_deduits = _duree_jours
    WHERE id = _demande_id;
  END IF;

  -- Retourner la demande mise à jour
  RETURN QUERY SELECT * FROM demandes WHERE id = _demande_id;
END;
$$;

-- =============================================
-- #10: Marquer les absents avec déduction du solde
-- =============================================
CREATE OR REPLACE FUNCTION marquer_absents_du_jour()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  _today DATE := CURRENT_DATE;
  _absent_count INTEGER := 0;
  _user_record RECORD;
  _solde_actuel DECIMAL;
BEGIN
  -- Parcourir les employés qui n'ont pas pointé aujourd'hui
  FOR _user_record IN (
    SELECT p.id, p.actif
    FROM profiles p
    LEFT JOIN pointages pt ON pt.user_id = p.id AND pt.date = _today
    WHERE p.actif = TRUE
      AND pt.id IS NULL
      AND p.id NOT IN (
        SELECT user_id FROM demandes 
        WHERE date_debut <= _today AND date_fin >= _today 
          AND statut = 'approuve'
      )
  ) LOOP
    -- Créer un pointage "absent"
    INSERT INTO pointages (user_id, date, statut, retard_minutes)
    VALUES (_user_record.id, _today, 'absent', 0);
    
    -- #10: Déduire 1 jour du solde de congé pour absence non justifiée
    SELECT solde_actuel INTO _solde_actuel 
    FROM solde_conges 
    WHERE user_id = _user_record.id;
    
    IF _solde_actuel IS NOT NULL AND _solde_actuel > 0 THEN
      UPDATE solde_conges 
      SET solde_actuel = GREATEST(solde_actuel - 1, 0),
          historique = historique || jsonb_build_object(
            'date', NOW(),
            'type', 'deduction',
            'motif', 'Absence non justifiée le ' || _today,
            'jours', -1
          ),
          updated_at = NOW()
      WHERE user_id = _user_record.id;
    END IF;
    
    _absent_count := _absent_count + 1;
  END LOOP;

  RETURN _absent_count;
END;
$$;

-- =============================================
-- #11 & #12: Pointer action avec retards et heures sup
-- =============================================
CREATE OR REPLACE FUNCTION pointer_action(
  _action TEXT,
  _lat DECIMAL DEFAULT NULL,
  _lng DECIMAL DEFAULT NULL,
  _taches TEXT DEFAULT NULL
)
RETURNS SETOF pointages
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _today DATE := CURRENT_DATE;
  _existing_pointage pointages%ROWTYPE;
  _heure_actuelle TIME := CURRENT_TIME;
  _retard_minutes INTEGER := 0;
  _heure_limite TIME := '09:00:00';
  _temps_supplementaire DECIMAL := 0;
  _solde_actuel DECIMAL;
  _seuil_retard INTEGER := 120;
BEGIN
  -- Vérifier si l'utilisateur existe
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Utilisateur non authentifié';
  END IF;

  -- Récupérer le pointage du jour
  SELECT * INTO _existing_pointage
  FROM pointages
  WHERE user_id = _user_id AND date = _today;

  CASE _action
    -- ACTION: ARRIVEE
    WHEN 'arrivee' THEN
      IF _existing_pointage.id IS NOT NULL AND _existing_pointage.heure_pointage IS NOT NULL THEN
        RAISE EXCEPTION 'Vous avez déjà pointé votre arrivée aujourd''hui';
      END IF;

      -- #11: Calculer le retard (si arrivée après 9h)
      IF _heure_actuelle > _heure_limite THEN
        _retard_minutes := EXTRACT(EPOCH FROM (_heure_actuelle - _heure_limite)) / 60;
        
        -- #11: Déduire du solde de congé (0.5 jour pour 2h de retard)
        SELECT solde_actuel INTO _solde_actuel 
        FROM solde_conges 
        WHERE user_id = _user_id;
        
        IF _solde_actuel IS NOT NULL AND _solde_actuel > 0 AND _retard_minutes >= _seuil_retard THEN
          UPDATE solde_conges 
          SET solde_actuel = GREATEST(solde_actuel - 0.5, 0),
              historique = historique || jsonb_build_object(
                'date', NOW(),
                'type', 'deduction',
                'motif', 'Retard de ' || _retard_minutes || ' minutes le ' || _today,
                'jours', -0.5
              ),
              updated_at = NOW()
          WHERE user_id = _user_id;
        END IF;
      END IF;

      -- Insérer ou mettre à jour le pointage
      IF _existing_pointage.id IS NULL THEN
        INSERT INTO pointages (user_id, date, heure_pointage, retard_minutes, statut, taches_realisees)
        VALUES (_user_id, _today, _heure_actuelle, _retard_minutes, 
                CASE WHEN _retard_minutes > 0 THEN 'retard' ELSE 'present' END,
                _taches)
        RETURNING * INTO _existing_pointage;
      ELSE
        UPDATE pointages 
        SET heure_pointage = _heure_actuelle,
            retard_minutes = _retard_minutes,
            statut = CASE WHEN _retard_minutes > 0 THEN 'retard' ELSE 'present' END,
            taches_realisees = COALESCE(_taches, taches_realisees),
            updated_at = NOW()
        WHERE id = _existing_pointage.id
        RETURNING * INTO _existing_pointage;
      END IF;

    -- ACTION: DEBUT_PAUSE
    WHEN 'debut_pause' THEN
      IF _existing_pointage.id IS NULL THEN
        RAISE EXCEPTION 'Vous devez d''abord pointer votre arrivée';
      END IF;
      UPDATE pointages SET heure_debut_pause = _heure_actuelle, updated_at = NOW()
      WHERE id = _existing_pointage.id
      RETURNING * INTO _existing_pointage;

    -- ACTION: FIN_PAUSE
    WHEN 'fin_pause' THEN
      IF _existing_pointage.id IS NULL OR _existing_pointage.heure_debut_pause IS NULL THEN
        RAISE EXCEPTION 'Vous devez d''abord commencer votre pause';
      END IF;
      UPDATE pointages SET heure_fin_pause = _heure_actuelle, updated_at = NOW()
      WHERE id = _existing_pointage.id
      RETURNING * INTO _existing_pointage;

    -- ACTION: SORTIE
    WHEN 'sortie' THEN
      IF _existing_pointage.id IS NULL OR _existing_pointage.heure_pointage IS NULL THEN
        RAISE EXCEPTION 'Vous devez d''abord pointer votre arrivée';
      END IF;
      
      -- #12: Calculer les heures supplémentaires (après 17h)
      IF _heure_actuelle > '17:00:00' THEN
        _temps_supplementaire := EXTRACT(EPOCH FROM (_heure_actuelle - '17:00:00')) / 3600;
        _temps_supplementaire := ROUND(_temps_supplementaire * 2) / 2;
      END IF;

      UPDATE pointages 
      SET heure_sortie = _heure_actuelle,
          temps_supplementaire = _temps_supplementaire,
          updated_at = NOW()
      WHERE id = _existing_pointage.id
      RETURNING * INTO _existing_pointage;

    -- ACTION: AJOUT_TACHES
    WHEN 'taches' THEN
      IF _existing_pointage.id IS NULL THEN
        RAISE EXCEPTION 'Vous devez d''abord pointer votre arrivée';
      END IF;
      UPDATE pointages SET taches_realisees = _taches, updated_at = NOW()
      WHERE id = _existing_pointage.id
      RETURNING * INTO _existing_pointage;

    ELSE
      RAISE EXCEPTION 'Action inconnue: %', _action;
  END CASE;

  RETURN NEXT _existing_pointage;
END;
$$;

-- =============================================
-- #13: Traiter le temps supplémentaire (admin)
-- =============================================
CREATE OR REPLACE FUNCTION traiter_temps_plus(
  _user_id UUID,
  _date DATE,
  _choix TEXT,
  _commentaire TEXT DEFAULT NULL
)
RETURNS TABLE(
  success BOOLEAN,
  message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  _pointage_id UUID;
  _temps_supplementaire DECIMAL;
  _admin_id UUID := auth.uid();
  _is_admin BOOLEAN;
  _solde_actuel DECIMAL;
  _prime_montant DECIMAL;
BEGIN
  -- Vérifier si l'utilisateur est admin
  SELECT EXISTS (
    SELECT 1 FROM user_roles WHERE user_id = _admin_id AND role = 'admin'
  ) INTO _is_admin;
  
  IF NOT _is_admin THEN
    RETURN QUERY SELECT FALSE, 'Accès admin requis';
    RETURN;
  END IF;

  -- Récupérer le pointage avec temps supplémentaire
  SELECT id, temps_supplementaire INTO _pointage_id, _temps_supplementaire
  FROM pointages
  WHERE user_id = _user_id AND date = _date AND temps_supplementaire IS NOT NULL AND temps_supplementaire > 0;

  IF _pointage_id IS NULL OR _temps_supplementaire IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Aucun temps supplémentaire trouvé pour cette date';
    RETURN;
  END IF;

  -- Traiter selon le choix
  IF _choix = 'conge' THEN
    -- Ajouter au solde de congé (1h de temps sup = 0.125 jour de congé)
    SELECT solde_actuel INTO _solde_actuel 
    FROM solde_conges 
    WHERE user_id = _user_id;
    
    IF _solde_actuel IS NULL THEN
      RETURN QUERY SELECT FALSE, 'Solde de congés introuvable';
      RETURN;
    END IF;

    UPDATE solde_conges 
    SET solde_actuel = solde_actuel + (_temps_supplementaire * 0.125),
        historique = historique || jsonb_build_object(
          'date', NOW(),
          'type', 'credit',
          'motif', 'Temps supplémentaire converti en congé (' || _temps_supplementaire || 'h)',
          'jours', _temps_supplementaire * 0.125,
          'admin_id', _admin_id,
          'pointage_id', _pointage_id
        ),
        updated_at = NOW()
    WHERE user_id = _user_id;

    -- Notification pour l'employé
    INSERT INTO notifications (
      user_id,
      destinataire_id,
      expediteur_id,
      titre,
      message,
      type,
      lue,
      created_at
    ) VALUES (
      _user_id,
      _user_id,
      _admin_id,
      '📈 Temps supplémentaire converti en congé',
      'Vos ' || _temps_supplementaire || 'h de travail supplémentaire du ' || _date || ' ont été converties en ' || ROUND(_temps_supplementaire * 0.125, 2) || ' jours de congé.',
      'conges',
      FALSE,
      NOW()
    );

  ELSIF _choix = 'bonus' THEN
    -- Calcul du montant de la prime (10 /h)
    _prime_montant := ROUND(_temps_supplementaire * 10, 2);
    
    -- Créer une notification de prime pour l'employé
    INSERT INTO notifications (
      user_id,
      destinataire_id,
      expediteur_id,
      titre,
      message,
      type,
      lue,
      created_at
    ) VALUES (
      _user_id,
      _user_id,
      _admin_id,
      '🎉 Prime pour temps supplémentaire',
      'Vous avez reçu une prime de ' || _prime_montant || '   pour ' || _temps_supplementaire || 'h de travail supplémentaire le ' || _date || '.',
      'prime',
      FALSE,
      NOW()
    );
  ELSE
    RETURN QUERY SELECT FALSE, 'Choix invalide. Utilisez "conge" ou "bonus"';
    RETURN;
  END IF;

  -- Marquer le temps supplémentaire comme traité
  UPDATE pointages 
  SET commentaire = COALESCE(commentaire, '') || ' | Temps sup traité: ' || _choix || ' par admin le ' || NOW()
  WHERE id = _pointage_id;

  RETURN QUERY SELECT TRUE, 'Temps supplémentaire traité avec succès en ' || _choix;
END;
$$;

-- =============================================
-- #9: Trigger pour créer automatiquement le solde à l'embauche
-- =============================================
CREATE OR REPLACE FUNCTION creer_solde_initial()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  _solde_initial DECIMAL;
BEGIN
  -- Calculer le solde initial basé sur la date d'embauche
  IF NEW.date_embauche IS NOT NULL THEN
    _solde_initial := calculer_solde_initial(NEW.date_embauche);
  ELSE
    _solde_initial := 0;
  END IF;
  
  -- Créer le solde de congés
  INSERT INTO solde_conges (user_id, solde_actuel, dernier_credit_mois, historique, updated_at)
  VALUES (NEW.id, _solde_initial, CURRENT_DATE, '[]'::jsonb, NOW());
  
  RETURN NEW;
END;
$$;

-- Créer le trigger sur la table profiles
CREATE TRIGGER trigger_creer_solde_initial
AFTER INSERT ON profiles
FOR EACH ROW
EXECUTE FUNCTION creer_solde_initial();