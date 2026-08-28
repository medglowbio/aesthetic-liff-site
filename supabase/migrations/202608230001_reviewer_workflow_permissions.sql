-- The workflow Edge Function uses the signed-in user's JWT so every action
-- remains constrained by RLS instead of depending on a service-role secret.
grant insert on public.case_events to authenticated;

drop policy if exists "active staff insert own case events" on public.case_events;
create policy "active staff insert own case events"
on public.case_events for insert to authenticated
with check (
  actor_id = auth.uid()
  and public.is_active_staff()
  and public.can_read_case(case_id)
);

drop policy if exists "reviewers publish case images" on storage.objects;
create policy "reviewers publish case images"
on storage.objects for insert to authenticated
with check (bucket_id = 'case-published' and public.is_reviewer());

drop policy if exists "reviewers update published case images" on storage.objects;
create policy "reviewers update published case images"
on storage.objects for update to authenticated
using (bucket_id = 'case-published' and public.is_reviewer())
with check (bucket_id = 'case-published' and public.is_reviewer());

drop policy if exists "reviewers remove published case images" on storage.objects;
create policy "reviewers remove published case images"
on storage.objects for delete to authenticated
using (bucket_id = 'case-published' and public.is_reviewer());
