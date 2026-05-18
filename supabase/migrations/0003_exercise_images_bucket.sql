-- 0003_exercise_images_bucket.sql — Storage bucket for trainer-uploaded
-- exercise images. Public-read so the PWA service worker can cache them
-- behind a CacheFirst rule (see vite.config.ts).
--
-- ⚠ READ THIS BEFORE APPLYING ⚠
--
-- Supabase has two parallel Storage authorization layers:
--
--   (1) "Legacy" storage: policies written against the public.storage.objects
--       table via plain SQL (the policies below). These are the ones every
--       Supabase tutorial from 2022–2024 documents.
--   (2) "New" storage authorization: policies created through the
--       dashboard's Storage → Policies UI, stored in a separate
--       internal table. Projects on the new asymmetric/publishable keys
--       (`sb_publishable_…` instead of the long anon JWT) use this layer
--       exclusively — the SQL policies below are evaluated by Postgres
--       RLS but Supabase Storage bypasses Postgres RLS for these
--       projects and consults the new table instead.
--
-- TL;DR: if your `apikey` header value starts with `sb_publishable_`, the
--        SQL policies below DO NOT TAKE EFFECT. You must add policies via
--        the dashboard UI. The bucket creation in this migration still
--        runs and is still needed.
--
-- Dashboard policies to add manually after running this migration on a
-- "new" project (Storage → exercise-images → Policies → New policy):
--
--   Policy name: exercise-images own prefix (INSERT)
--     Allowed operation: INSERT
--     Target roles: authenticated
--     USING expression: (leave empty)
--     WITH CHECK expression:
--       bucket_id = 'exercise-images'
--       and name like (auth.uid()::text || '/%')
--
--   Policy name: exercise-images own prefix (UPDATE)
--     Allowed operation: UPDATE
--     Target roles: authenticated
--     USING / WITH CHECK: same expression as above.
--
--   Policy name: exercise-images own prefix (DELETE)
--     Allowed operation: DELETE
--     Target roles: authenticated
--     USING expression: same expression as above.
--
-- The bucket-level caps (2 MB size limit + image/* MIME allowlist) are
-- applied via SQL below, so no manual Configuration step is required.

-- ─── Bucket ───────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
  values ('exercise-images', 'exercise-images', true)
  on conflict (id) do nothing;

-- Bucket-level safety nets. Reject uploads larger than 2 MB or with
-- unexpected MIME types at the storage layer, regardless of which
-- authorization layer the project uses. The client's resizeImage()
-- produces ~80-200 KB JPEGs so legitimate uploads sail through this
-- easily; the cap is defence in depth.
update storage.buckets
   set file_size_limit    = 2097152,  -- 2 MB
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'exercise-images';

-- ─── Legacy RLS policies (only effective on "old" storage projects) ──
-- Uses LIKE instead of storage.foldername() because storage.foldername
-- has behaved inconsistently across Supabase versions in our testing.

drop policy if exists "exercise-images insert own prefix" on storage.objects;
drop policy if exists "exercise-images update own prefix" on storage.objects;
drop policy if exists "exercise-images delete own prefix" on storage.objects;

create policy "exercise-images insert own prefix" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'exercise-images'
    and name like (auth.uid()::text || '/%')
  );

create policy "exercise-images update own prefix" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'exercise-images'
    and name like (auth.uid()::text || '/%')
  )
  with check (
    bucket_id = 'exercise-images'
    and name like (auth.uid()::text || '/%')
  );

create policy "exercise-images delete own prefix" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'exercise-images'
    and name like (auth.uid()::text || '/%')
  );

-- Read is implicit because the bucket is marked public; no SELECT policy
-- needed and none provided.
