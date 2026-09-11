-- Mixed media groups; existing photo IDs, paths and crop data remain intact.
begin;
alter table public.case_photo_pairs
  alter column before_private_path drop not null,
  alter column after_private_path drop not null,
  drop constraint case_photo_pairs_check,
  drop constraint case_photo_pairs_published_layout_check,
  add column layout_kind text not null default 'comparison' check (layout_kind in ('single','comparison')),
  add column published_layout_kind text check (published_layout_kind in ('single','comparison'));
alter table public.case_photo_pairs
  add column before_media_type text not null default 'image' check (before_media_type in ('image','video')),
  add column before_poster_private_path text,
  add column before_video_meta jsonb,
  add column published_before_media_type text check (published_before_media_type in ('image','video')),
  add column before_poster_public_path text,
  add column published_before_video_meta jsonb;
alter table public.case_photo_pairs
  add column after_media_type text not null default 'image' check (after_media_type in ('image','video')),
  add column after_poster_private_path text,
  add column after_video_meta jsonb,
  add column published_after_media_type text check (published_after_media_type in ('image','video')),
  add column after_poster_public_path text,
  add column published_after_video_meta jsonb;
update public.case_photo_pairs set
  published_layout_kind = 'comparison',
  published_before_media_type = 'image', published_after_media_type = 'image'
where before_public_path is not null;

alter table public.case_photo_pairs add constraint case_media_single_slot_check
  check (layout_kind <> 'single' or (after_private_path is null and after_source_private_path is null and after_poster_private_path is null));
alter table public.case_photo_pairs add constraint case_media_public_snapshot_check check (
  (before_public_path is null and after_public_path is null
    and published_layout_kind is null and published_canvas_ratio is null and published_split_direction is null
    and published_before_media_type is null and published_after_media_type is null
    and before_poster_public_path is null and after_poster_public_path is null
    and published_before_video_meta is null and published_after_video_meta is null)
  or
  (before_public_path is not null and published_canvas_ratio is not null and published_split_direction is not null
    and published_layout_kind is not null and published_before_media_type is not null
    and (published_before_media_type = 'image' or (before_poster_public_path is not null and published_before_video_meta is not null))
    and (
      (published_layout_kind = 'single' and after_public_path is null and published_after_media_type is null
        and after_poster_public_path is null and published_after_video_meta is null)
      or
      (published_layout_kind = 'comparison' and after_public_path is not null and published_after_media_type is not null
        and (published_after_media_type = 'image' or (after_poster_public_path is not null and published_after_video_meta is not null)))
    ))
);

grant select (published_layout_kind, published_before_media_type, published_after_media_type,
  before_poster_public_path, after_poster_public_path, published_before_video_meta, published_after_video_meta)
on public.case_photo_pairs to anon;
grant select, insert, update, delete on public.case_photo_pairs to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('case-video-drafts','case-video-drafts',false,52428800,array['video/mp4','image/webp']),
 ('case-video-published','case-video-published',true,52428800,array['video/mp4','image/webp']);

create policy "staff insert editable case video drafts" on storage.objects for insert to authenticated
with check (bucket_id = 'case-video-drafts' and public.is_active_staff()
 and (storage.foldername(name))[1] = auth.uid()::text
 and public.can_edit_case((storage.foldername(name))[2]));
create policy "staff read authorized case video drafts" on storage.objects for select to authenticated
using (bucket_id = 'case-video-drafts' and public.is_active_staff()
 and public.can_read_case((storage.foldername(name))[2])
 and ((storage.foldername(name))[1] = auth.uid()::text or public.is_reviewer()));
create policy "staff delete editable case video drafts" on storage.objects for delete to authenticated
using (bucket_id = 'case-video-drafts' and public.is_active_staff()
 and public.can_edit_case((storage.foldername(name))[2])
 and ((storage.foldername(name))[1] = auth.uid()::text or public.is_reviewer()));
-- Immutable UUID paths; no UPDATE / overwrite policy, including resumed uploads.
create policy "reviewers insert published case videos" on storage.objects for insert to authenticated
with check (bucket_id = 'case-video-published' and public.is_reviewer()
 and public.can_edit_case((storage.foldername(name))[1]));
create policy "reviewers read published case videos" on storage.objects for select to authenticated
using (bucket_id = 'case-video-published' and public.is_reviewer());
create policy "reviewers delete published case videos" on storage.objects for delete to authenticated
using (bucket_id = 'case-video-published' and public.is_reviewer());
commit;
