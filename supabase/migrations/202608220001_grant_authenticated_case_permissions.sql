-- Table privileges are required in addition to RLS policies.
grant select on public.profiles to authenticated;

grant select, insert, update on public.treatment_catalog to authenticated;
grant select, insert, update on public.cases to authenticated;
grant select, insert, delete on public.case_treatments to authenticated;
grant select, insert, update, delete on public.case_photo_pairs to authenticated;
grant select on public.case_events to authenticated;
