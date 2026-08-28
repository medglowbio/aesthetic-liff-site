-- Storage upserts check whether an object already exists, so reviewers need
-- SELECT in addition to INSERT/UPDATE when publishing approved case images.
drop policy if exists "reviewers read published case images" on storage.objects;
create policy "reviewers read published case images"
on storage.objects for select to authenticated
using (bucket_id = 'case-published' and public.is_reviewer());
