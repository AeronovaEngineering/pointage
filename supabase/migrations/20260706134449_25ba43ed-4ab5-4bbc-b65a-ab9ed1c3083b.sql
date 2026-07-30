
-- Storage policies : chaque fichier est stocké sous {user_id}/...
CREATE POLICY "photos_read_own_or_admin" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id='photos-profil' AND (auth.uid()::text = (storage.foldername(name))[1] OR public.is_admin(auth.uid())));
CREATE POLICY "photos_upload_own" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id='photos-profil' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "photos_update_own" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id='photos-profil' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "photos_delete_own" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id='photos-profil' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "justif_read_own_or_admin" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id='justificatifs-maladie' AND (auth.uid()::text = (storage.foldername(name))[1] OR public.is_admin(auth.uid())));
CREATE POLICY "justif_upload_own" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id='justificatifs-maladie' AND auth.uid()::text = (storage.foldername(name))[1]);
