create extension if not exists pgcrypto;

create or replace function public.generate_case_id()
returns text
language sql
volatile
as $$
  select 'AES-' || to_char(now(), 'YYYYMM') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role text not null default 'editor' check (role in ('editor', 'reviewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.treatment_catalog (
  id text primary key,
  name text not null,
  category_id text not null,
  category_name text not null,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.cases (
  id text primary key default public.generate_case_id(),
  title text not null check (char_length(title) between 2 and 100),
  summary text not null default '',
  status text not null default 'draft' check (status in ('draft', 'pending_review', 'changes_requested', 'published', 'archived')),
  display_order integer not null default 100,
  concern_tags text[] not null default '{}',
  consent_confirmed boolean not null default false,
  consent_confirmed_by uuid references public.profiles(id),
  consent_confirmed_at timestamptz,
  created_by uuid not null default auth.uid() references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  submitted_at timestamptz,
  published_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (consent_confirmed = false and consent_confirmed_by is null and consent_confirmed_at is null)
    or
    (consent_confirmed = true and consent_confirmed_by is not null and consent_confirmed_at is not null)
  )
);

create table public.case_treatments (
  case_id text not null references public.cases(id) on delete cascade,
  treatment_id text not null references public.treatment_catalog(id),
  created_at timestamptz not null default now(),
  primary key (case_id, treatment_id)
);

create table public.case_photo_pairs (
  id uuid primary key default gen_random_uuid(),
  case_id text not null references public.cases(id) on delete cascade,
  label text not null default '正面',
  follow_up_label text not null default '',
  sort_order integer not null default 0,
  before_private_path text not null,
  after_private_path text not null,
  before_public_path text,
  after_public_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (before_public_path is null and after_public_path is null)
    or
    (before_public_path is not null and after_public_path is not null)
  )
);

create table public.case_events (
  id bigint generated always as identity primary key,
  case_id text not null references public.cases(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  event_type text not null check (event_type in ('created', 'submitted', 'changes_requested', 'published', 'unpublished', 'archived')),
  note text not null default '',
  created_at timestamptz not null default now()
);

create index cases_status_order_idx on public.cases(status, display_order, id);
create index cases_created_by_idx on public.cases(created_by, updated_at desc);
create index case_photo_pairs_case_idx on public.case_photo_pairs(case_id, sort_order);
create index case_events_case_idx on public.case_events(case_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger cases_updated_at before update on public.cases
for each row execute function public.set_updated_at();
create trigger case_photo_pairs_updated_at before update on public.case_photo_pairs
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles(id, display_name, role)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)), 'editor')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

insert into public.profiles(id, display_name, role)
select
  user_account.id,
  coalesce(
    user_account.raw_user_meta_data ->> 'display_name',
    split_part(user_account.email, '@', 1),
    'staff'
  ),
  'editor'
from auth.users as user_account
on conflict (id) do nothing;

create or replace function public.is_reviewer()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'reviewer' and active = true);
$$;

create or replace function public.is_active_staff()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(select 1 from public.profiles where id = auth.uid() and active = true);
$$;

create or replace function public.can_read_case(target_case_id text)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(
    select 1 from public.cases c
    where c.id = target_case_id
      and (
        (c.status = 'published' and c.consent_confirmed = true)
        or (c.created_by = auth.uid() and public.is_active_staff())
        or public.is_reviewer()
      )
  );
$$;

create or replace function public.can_edit_case(target_case_id text)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(
    select 1 from public.cases c
    where c.id = target_case_id
      and (
        public.is_reviewer()
        or (c.created_by = auth.uid() and c.status in ('draft', 'changes_requested'))
      )
  );
$$;

alter table public.profiles enable row level security;
alter table public.treatment_catalog enable row level security;
alter table public.cases enable row level security;
alter table public.case_treatments enable row level security;
alter table public.case_photo_pairs enable row level security;
alter table public.case_events enable row level security;

create policy "profiles read self or reviewer" on public.profiles for select
using (id = auth.uid() or public.is_reviewer());
create policy "reviewers update profiles" on public.profiles for update
using (public.is_reviewer()) with check (public.is_reviewer());

create policy "active treatments are readable" on public.treatment_catalog for select
using (active = true or public.is_reviewer());
create policy "reviewers insert treatments" on public.treatment_catalog for insert
with check (public.is_reviewer());
create policy "reviewers update treatments" on public.treatment_catalog for update
using (public.is_reviewer()) with check (public.is_reviewer());

create policy "published or authorized cases are readable" on public.cases for select
using ((status = 'published' and consent_confirmed = true) or (created_by = auth.uid() and public.is_active_staff()) or public.is_reviewer());
create policy "active staff create cases" on public.cases for insert
with check (
  created_by = auth.uid()
  and exists(select 1 from public.profiles p where p.id = auth.uid() and p.active = true)
  and status = 'draft'
  and consent_confirmed = false
);
create policy "editors update editable cases" on public.cases for update
using (created_by = auth.uid() and public.is_active_staff() and status in ('draft', 'changes_requested'))
with check (created_by = auth.uid() and public.is_active_staff() and status in ('draft', 'changes_requested', 'pending_review'));
create policy "reviewers update all cases" on public.cases for update
using (public.is_reviewer()) with check (public.is_reviewer());

create policy "authorized case treatments are readable" on public.case_treatments for select
using (public.can_read_case(case_id));
create policy "authorized staff insert case treatments" on public.case_treatments for insert
with check (public.can_edit_case(case_id));
create policy "authorized staff delete case treatments" on public.case_treatments for delete
using (public.can_edit_case(case_id));

create policy "authorized case photos are readable" on public.case_photo_pairs for select
using (public.can_read_case(case_id));
create policy "authorized staff insert case photos" on public.case_photo_pairs for insert
with check (public.can_edit_case(case_id));
create policy "authorized staff update case photos" on public.case_photo_pairs for update
using (public.can_edit_case(case_id)) with check (public.can_edit_case(case_id));
create policy "authorized staff delete case photos" on public.case_photo_pairs for delete
using (public.can_edit_case(case_id));

create policy "authorized case events are readable" on public.case_events for select
using (public.can_read_case(case_id));

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values
  ('case-drafts', 'case-drafts', false, 5242880, array['image/webp']),
  ('case-published', 'case-published', true, 5242880, array['image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "staff upload own draft images" on storage.objects for insert to authenticated
with check (bucket_id = 'case-drafts' and public.is_active_staff() and (storage.foldername(name))[1] = auth.uid()::text);
create policy "staff read authorized draft images" on storage.objects for select to authenticated
using (bucket_id = 'case-drafts' and public.is_active_staff() and ((storage.foldername(name))[1] = auth.uid()::text or public.is_reviewer()));
create policy "staff update own draft images" on storage.objects for update to authenticated
using (bucket_id = 'case-drafts' and public.is_active_staff() and ((storage.foldername(name))[1] = auth.uid()::text or public.is_reviewer()))
with check (bucket_id = 'case-drafts' and public.is_active_staff() and ((storage.foldername(name))[1] = auth.uid()::text or public.is_reviewer()));
create policy "staff delete own draft images" on storage.objects for delete to authenticated
using (bucket_id = 'case-drafts' and public.is_active_staff() and ((storage.foldername(name))[1] = auth.uid()::text or public.is_reviewer()));

revoke all on public.case_events from anon, authenticated;
grant select on public.case_events to authenticated;

-- Anonymous visitors only receive fields needed by the public case gallery.
revoke all on public.cases from anon;
grant select (id, title, summary, status, display_order, concern_tags, consent_confirmed) on public.cases to anon;
revoke all on public.case_photo_pairs from anon;
grant select (id, case_id, label, follow_up_label, sort_order, before_public_path, after_public_path) on public.case_photo_pairs to anon;
revoke all on public.case_treatments from anon;
grant select (case_id, treatment_id) on public.case_treatments to anon;
revoke all on public.treatment_catalog from anon;
grant select (id, name, category_id, category_name, active) on public.treatment_catalog to anon;
