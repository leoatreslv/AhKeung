-- 0003_exercise_images_bucket.sql — Storage bucket for trainer-uploaded
-- exercise images. Public-read so the PWA service worker can cache them
-- behind a CacheFirst rule (see vite.config.ts); writes restricted to a
-- per-user prefix `{auth.uid()}/...`.

insert into storage.buckets (id, name, public)
  values ('exercise-images', 'exercise-images', true)
  on conflict (id) do nothing;

-- Authenticated users may upload into their own prefix only.
create policy "exercise-images insert own prefix" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'exercise-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "exercise-images update own prefix" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'exercise-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'exercise-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "exercise-images delete own prefix" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'exercise-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Read is implicit because the bucket is marked public; no SELECT policy
-- needed (and none provided, since the public flag bypasses RLS for reads).
