-- Workflow audit rows are evidence of server-validated state transitions.
-- Browsers may read authorized history, but only service-role Edge Functions
-- may append to it.
revoke insert on public.case_events from authenticated;
drop policy if exists "active staff insert own case events" on public.case_events;

revoke insert on public.catalog_events from authenticated;
drop policy if exists "staff insert catalog events" on public.catalog_events;
