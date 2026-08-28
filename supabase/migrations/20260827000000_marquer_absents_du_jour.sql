-- Migration: Schedule marquer_absents_du_jour() with pg_cron
-- Date: 2026-08-27

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('marquer-absents-quotidien')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'marquer-absents-quotidien');
    PERFORM cron.schedule('marquer-absents-quotidien', '0 17 * * 1-5', 'SELECT public.marquer_absents_du_jour();');
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

