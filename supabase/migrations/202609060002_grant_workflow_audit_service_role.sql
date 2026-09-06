-- Edge Functions write validated workflow events with the service-role client.
-- RLS bypass alone does not grant table privileges after browser INSERT access
-- has been revoked, so keep this capability explicit and narrowly scoped.
grant insert on public.case_events to service_role;
grant insert on public.catalog_events to service_role;
