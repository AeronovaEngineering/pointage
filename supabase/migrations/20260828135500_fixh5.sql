-- Migration: Fix overtime to bonus conversion rate from 10 DT/h to 5 DT/h
-- Date: 2026-08-28

CREATE OR REPLACE FUNCTION public.convertir_heures_sup(
    _user_id UUID,
    _heures NUMERIC,
    _type TEXT,
    _commentaire TEXT DEFAULT NULL
)
RETURNS public.conversions_heures_sup
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin UUID := auth.uid();
    v_is_admin BOOLEAN;
    v_solde NUMERIC;
    v_jours_conge NUMERIC;
    v_montant NUMERIC;
    v_row public.conversions_heures_sup;
BEGIN
    -- Check if caller is admin
    SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_admin AND role = 'admin')
    INTO v_is_admin;

    IF NOT v_is_admin THEN
        RAISE EXCEPTION 'Accès refusé';
    END IF;

    -- Validate type
    IF _type NOT IN ('conge', 'prime') THEN
        RAISE EXCEPTION 'Type invalide. Utilisez "conge" ou "prime"';
    END IF;

    -- Validate hours
    IF _heures IS NULL OR _heures <= 0 THEN
        RAISE EXCEPTION 'Les heures doivent être un nombre positif';
    END IF;

    -- Check available balance
    v_solde := public.get_solde_heures_sup(_user_id);

    IF _heures > v_solde THEN
        RAISE EXCEPTION 'Solde d''heures supplémentaires insuffisant (solde: % h, demandé: % h)', v_solde, _heures;
    END IF;

    -- Handle conversion based on type
    IF _type = 'conge' THEN
        -- Convert to days off (1h = 0.125 jour = 1/8 de jour)
        v_jours_conge := ROUND(_heures * 0.125, 2);

        -- Update solde_conges
        UPDATE public.solde_conges
        SET solde_actuel = solde_actuel + v_jours_conge,
            historique = historique || jsonb_build_object(
                'date', NOW(),
                'type', 'credit',
                'motif', 'Heures supplémentaires converties en congé',
                'jours', v_jours_conge,
                'admin_id', v_admin,
                'heures_sup', _heures
            ),
            updated_at = NOW()
        WHERE user_id = _user_id;

        -- Insert notification
        INSERT INTO public.notifications (user_id, titre, message, lien)
        VALUES (
            _user_id,
            '📈 Heures supplémentaires converties en congé',
            'Vos ' || _heures || 'h de travail supplémentaire ont été converties en ' || v_jours_conge || ' jours de congé.',
            '/dashboard'
        );

    ELSIF _type = 'prime' THEN
        -- Calculate bonus (5 DT per hour) - FIXED from 10 DT/h to 5 DT/h
        v_montant := ROUND(_heures * 5, 2);

        -- Insert into primes table (using existing pattern)
        INSERT INTO public.primes (user_id, admin_id, montant, commentaire)
        VALUES (
            _user_id,
            v_admin,
            v_montant,
            COALESCE(_commentaire, 'Conversion de ' || _heures || 'h supplémentaires')
        );

        -- Insert notification
        INSERT INTO public.notifications (user_id, titre, message, lien)
        VALUES (
            _user_id,
            '🎉 Heures supplémentaires converties en prime',
            'Vos ' || _heures || 'h de travail supplémentaire ont été converties en une prime de ' || v_montant || ' DT.',
            '/dashboard'
        );
    END IF;

    -- Record the conversion
    INSERT INTO public.conversions_heures_sup (
        user_id,
        admin_id,
        heures,
        type,
        jours_conge,
        montant,
        commentaire
    )
    VALUES (
        _user_id,
        v_admin,
        _heures,
        _type,
        v_jours_conge,
        v_montant,
        _commentaire
    )
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.convertir_heures_sup(UUID, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convertir_heures_sup(UUID, NUMERIC, TEXT, TEXT) TO authenticated;