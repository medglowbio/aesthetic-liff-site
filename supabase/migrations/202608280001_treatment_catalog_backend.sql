-- Full treatment catalog publishing workflow.
-- treatment_catalog remains the stable identity table referenced by case_treatments.

alter table public.treatment_catalog
  add column if not exists content_type text not null default 'treatment',
  add column if not exists device_subtitle text not null default '',
  add column if not exists short_description text not null default '',
  add column if not exists tags text[] not null default '{}',
  add column if not exists license_name text not null default '',
  add column if not exists license_no text not null default '',
  add column if not exists full_description text not null default '',
  add column if not exists suitable text not null default '',
  add column if not exists info jsonb not null default '[]'::jsonb,
  add column if not exists pre_notes text not null default '',
  add column if not exists post_notes text not null default '',
  add column if not exists image_url text not null default '',
  add column if not exists image_alt text not null default '',
  add column if not exists image_caption text not null default '',
  add column if not exists image_focus_x numeric(5,2) not null default 50,
  add column if not exists image_focus_y numeric(5,2) not null default 50,
  add column if not exists sort_order integer not null default 100,
  add column if not exists visible boolean not null default true,
  add column if not exists status text not null default 'published',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists reviewed_by uuid references public.profiles(id),
  add column if not exists published_at timestamptz;

do $$ begin
  alter table public.treatment_catalog add constraint treatment_catalog_content_type_check
    check (content_type in ('treatment', 'product'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.treatment_catalog add constraint treatment_catalog_status_check
    check (status in ('published', 'unpublished', 'archived'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.treatment_catalog add constraint treatment_catalog_focus_check
    check (image_focus_x between 0 and 100 and image_focus_y between 0 and 100);
exception when duplicate_object then null; end $$;

create table if not exists public.treatment_categories (
  id text primary key,
  group_key text not null default 'type',
  name text not null,
  summary text not null default '',
  icon text not null default '',
  image_url text not null default '',
  image_alt text not null default '',
  image_focus_x numeric(5,2) not null default 50 check (image_focus_x between 0 and 100),
  image_focus_y numeric(5,2) not null default 50 check (image_focus_y between 0 and 100),
  sort_order integer not null default 100,
  visible boolean not null default true,
  status text not null default 'published' check (status in ('published', 'unpublished', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  published_at timestamptz
);

create table if not exists public.treatment_subcategories (
  id text primary key,
  category_id text not null references public.treatment_categories(id),
  name text not null,
  sort_order integer not null default 100,
  visible boolean not null default true,
  status text not null default 'published' check (status in ('published', 'unpublished', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  published_at timestamptz,
  unique (category_id, name)
);

create table if not exists public.treatment_subcategory_links (
  treatment_id text not null references public.treatment_catalog(id),
  subcategory_id text not null references public.treatment_subcategories(id),
  sort_order integer not null default 100,
  primary key (treatment_id, subcategory_id)
);

create table if not exists public.catalog_revisions (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('category', 'subcategory', 'treatment')),
  entity_id text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'pending_review', 'changes_requested', 'published', 'archived')),
  revision_number integer not null default 1,
  note text not null default '',
  created_by uuid not null default auth.uid() references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  submitted_at timestamptz,
  published_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists catalog_revisions_open_entity_idx
  on public.catalog_revisions(entity_type, entity_id)
  where status in ('draft', 'pending_review', 'changes_requested');
create index if not exists catalog_revisions_status_idx
  on public.catalog_revisions(status, updated_at desc);

create table if not exists public.catalog_events (
  id bigint generated always as identity primary key,
  revision_id uuid references public.catalog_revisions(id),
  entity_type text not null,
  entity_id text not null,
  actor_id uuid not null references public.profiles(id),
  event_type text not null check (event_type in ('created', 'saved', 'submitted', 'changes_requested', 'published', 'unpublished', 'archived')),
  note text not null default '',
  created_at timestamptz not null default now()
);

drop trigger if exists treatment_categories_updated_at on public.treatment_categories;
create trigger treatment_categories_updated_at before update on public.treatment_categories
for each row execute function public.set_updated_at();
drop trigger if exists treatment_subcategories_updated_at on public.treatment_subcategories;
create trigger treatment_subcategories_updated_at before update on public.treatment_subcategories
for each row execute function public.set_updated_at();
drop trigger if exists catalog_revisions_updated_at on public.catalog_revisions;
create trigger catalog_revisions_updated_at before update on public.catalog_revisions
for each row execute function public.set_updated_at();

create or replace function public.set_catalog_revision_number()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select coalesce(max(revision_number), 0) + 1
    into new.revision_number
  from public.catalog_revisions
  where entity_type = new.entity_type
    and entity_id = new.entity_id;
  return new;
end;
$$;

drop trigger if exists catalog_revisions_set_number on public.catalog_revisions;
create trigger catalog_revisions_set_number before insert on public.catalog_revisions
for each row execute function public.set_catalog_revision_number();

alter table public.treatment_categories enable row level security;
alter table public.treatment_subcategories enable row level security;
alter table public.treatment_subcategory_links enable row level security;
alter table public.catalog_revisions enable row level security;
alter table public.catalog_events enable row level security;

drop policy if exists "published categories readable" on public.treatment_categories;
create policy "published categories readable" on public.treatment_categories for select
using ((status = 'published' and visible = true) or public.is_active_staff());
drop policy if exists "reviewers manage categories" on public.treatment_categories;
create policy "reviewers manage categories" on public.treatment_categories for all
using (public.is_reviewer()) with check (public.is_reviewer());

drop policy if exists "published subcategories readable" on public.treatment_subcategories;
create policy "published subcategories readable" on public.treatment_subcategories for select
using ((status = 'published' and visible = true) or public.is_active_staff());
drop policy if exists "reviewers manage subcategories" on public.treatment_subcategories;
create policy "reviewers manage subcategories" on public.treatment_subcategories for all
using (public.is_reviewer()) with check (public.is_reviewer());

drop policy if exists "published treatment links readable" on public.treatment_subcategory_links;
create policy "published treatment links readable" on public.treatment_subcategory_links for select
using (exists (
  select 1 from public.treatment_catalog t
  where t.id = treatment_id and ((t.status = 'published' and t.visible = true and t.active = true) or public.is_active_staff())
));
drop policy if exists "reviewers manage treatment links" on public.treatment_subcategory_links;
create policy "reviewers manage treatment links" on public.treatment_subcategory_links for all
using (public.is_reviewer()) with check (public.is_reviewer());

drop policy if exists "staff read catalog revisions" on public.catalog_revisions;
create policy "staff read catalog revisions" on public.catalog_revisions for select
using (public.is_reviewer() or (public.is_active_staff() and created_by = auth.uid()));
drop policy if exists "staff create catalog revisions" on public.catalog_revisions;
create policy "staff create catalog revisions" on public.catalog_revisions for insert
with check (public.is_active_staff() and created_by = auth.uid() and status = 'draft');
drop policy if exists "staff update own catalog revisions" on public.catalog_revisions;
create policy "staff update own catalog revisions" on public.catalog_revisions for update
using (public.is_reviewer() or (public.is_active_staff() and created_by = auth.uid() and status in ('draft', 'changes_requested')))
with check (public.is_reviewer() or (public.is_active_staff() and created_by = auth.uid() and status in ('draft', 'changes_requested', 'pending_review')));

drop policy if exists "staff read catalog events" on public.catalog_events;
create policy "staff read catalog events" on public.catalog_events for select
using (public.is_reviewer() or exists (
  select 1 from public.catalog_revisions r where r.id = revision_id and r.created_by = auth.uid()
));
drop policy if exists "staff insert catalog events" on public.catalog_events;
create policy "staff insert catalog events" on public.catalog_events for insert
with check (public.is_active_staff() and actor_id = auth.uid());

-- Live published rows may only be changed by reviewers through the workflow function.
drop policy if exists "active treatments are readable" on public.treatment_catalog;
create policy "published treatments are readable" on public.treatment_catalog for select
using ((status = 'published' and visible = true and active = true) or public.is_active_staff());
drop policy if exists "reviewers insert treatments" on public.treatment_catalog;
create policy "reviewers insert treatments" on public.treatment_catalog for insert
with check (public.is_reviewer());
drop policy if exists "reviewers update treatments" on public.treatment_catalog;
create policy "reviewers update treatments" on public.treatment_catalog for update
using (public.is_reviewer()) with check (public.is_reviewer());

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values
  ('treatment-drafts', 'treatment-drafts', false, 5242880, array['image/webp']),
  ('treatment-published', 'treatment-published', true, 5242880, array['image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "staff upload treatment drafts" on storage.objects;
create policy "staff upload treatment drafts" on storage.objects for insert to authenticated
with check (bucket_id = 'treatment-drafts' and public.is_active_staff() and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "staff read treatment drafts" on storage.objects;
create policy "staff read treatment drafts" on storage.objects for select to authenticated
using (bucket_id = 'treatment-drafts' and public.is_active_staff() and ((storage.foldername(name))[1] = auth.uid()::text or public.is_reviewer()));
drop policy if exists "staff update treatment drafts" on storage.objects;
create policy "staff update treatment drafts" on storage.objects for update to authenticated
using (bucket_id = 'treatment-drafts' and public.is_active_staff() and ((storage.foldername(name))[1] = auth.uid()::text or public.is_reviewer()))
with check (bucket_id = 'treatment-drafts' and public.is_active_staff());
drop policy if exists "staff delete treatment drafts" on storage.objects;
create policy "staff delete treatment drafts" on storage.objects for delete to authenticated
using (bucket_id = 'treatment-drafts' and public.is_active_staff() and ((storage.foldername(name))[1] = auth.uid()::text or public.is_reviewer()));

-- Reviewers need to copy approved images into the public bucket.
drop policy if exists "reviewers manage published treatment images" on storage.objects;
create policy "reviewers manage published treatment images" on storage.objects for all to authenticated
using (bucket_id = 'treatment-published' and public.is_reviewer())
with check (bucket_id = 'treatment-published' and public.is_reviewer());

revoke all on public.treatment_categories, public.treatment_subcategories,
  public.treatment_subcategory_links, public.catalog_revisions, public.catalog_events from anon;
grant select on public.treatment_categories, public.treatment_subcategories,
  public.treatment_subcategory_links to authenticated;
grant select, insert, update on public.catalog_revisions to authenticated;
grant select, insert on public.catalog_events to authenticated;
grant select, insert, update, delete on public.treatment_categories, public.treatment_subcategories,
  public.treatment_subcategory_links to authenticated;
grant select, insert, update on public.treatment_catalog to authenticated;

-- One RPC is the complete anonymous public surface. Drafts never appear here.
create or replace function public.get_published_treatment_catalog()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'group', c.group_key,
        'name', c.name,
        'icon', c.icon,
        'concern', c.summary,
        'image', c.image_url,
        'imageAlt', c.image_alt,
        'imageFocusX', c.image_focus_x,
        'imageFocusY', c.image_focus_y,
        'sortOrder', c.sort_order,
        'subcategories', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'sortOrder', s.sort_order,
            'treatmentIds', coalesce((
              select jsonb_agg(l.treatment_id order by l.sort_order, t.sort_order, t.name)
              from public.treatment_subcategory_links l
              join public.treatment_catalog t on t.id = l.treatment_id
              where l.subcategory_id = s.id
                and t.status = 'published' and t.visible = true and t.active = true
            ), '[]'::jsonb)
          ) order by s.sort_order, s.name)
          from public.treatment_subcategories s
          where s.category_id = c.id and s.status = 'published' and s.visible = true
        ), '[]'::jsonb)
      ) order by c.sort_order, c.name)
      from public.treatment_categories c
      where c.status = 'published' and c.visible = true
    ), '[]'::jsonb),
    'treatments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'name', t.name,
        'categoryId', t.category_id,
        'categoryName', t.category_name,
        'contentType', t.content_type,
        'device', t.device_subtitle,
        'desc', t.short_description,
        'tags', t.tags,
        'licenseName', t.license_name,
        'licenseNo', t.license_no,
        'fullDescription', t.full_description,
        'suitable', t.suitable,
        'info', t.info,
        'preNotes', t.pre_notes,
        'postNotes', t.post_notes,
        'image', t.image_url,
        'imageAlt', t.image_alt,
        'imageCaption', t.image_caption,
        'imageFocusX', t.image_focus_x,
        'imageFocusY', t.image_focus_y,
        'sortOrder', t.sort_order
      ) order by t.sort_order, t.name)
      from public.treatment_catalog t
      where t.status = 'published' and t.visible = true and t.active = true
    ), '[]'::jsonb),
    'generatedAt', now()
  );
$$;

revoke all on function public.get_published_treatment_catalog() from public;
grant execute on function public.get_published_treatment_catalog() to anon, authenticated;
