-- supabase/migrations/20260713020000_fix_double_insert_solde_conges.sql

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

  -- solde_conges is NOT inserted here anymore. It's already handled by
  -- trigger_creer_solde_initial (fires on the profiles INSERT above) which
  -- correctly calculates the starting balance from date_embauche, instead
  -- of hardcoding 0 like this trigger used to do. Inserting it here too
  -- caused a duplicate-key violation on solde_conges.user_id, which rolled
  -- back the entire auth.users insert and surfaced as an opaque 500 error
  -- from auth.admin.createUser().

  IF v_first_user THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'employe');
  END IF;

  RETURN NEW;
END; $$;