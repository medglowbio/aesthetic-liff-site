alter table public.case_photo_pairs
  add column canvas_ratio text not null default '4:3',
  add column split_direction text not null default 'horizontal',
  add column before_source_private_path text,
  add column after_source_private_path text,
  add column before_crop_rect jsonb,
  add column after_crop_rect jsonb,
  add column published_canvas_ratio text,
  add column published_split_direction text;

alter table public.case_photo_pairs
  add constraint case_photo_pairs_canvas_ratio_check
    check (canvas_ratio in ('4:3', '3:4', '1:1')),
  add constraint case_photo_pairs_split_direction_check
    check (split_direction in ('horizontal', 'vertical')),
  add constraint case_photo_pairs_published_canvas_ratio_check
    check (published_canvas_ratio is null or published_canvas_ratio in ('4:3', '3:4', '1:1')),
  add constraint case_photo_pairs_published_split_direction_check
    check (published_split_direction is null or published_split_direction in ('horizontal', 'vertical'));

-- Existing public images were created as two 2:3 portraits in a 4:3 canvas.
update public.case_photo_pairs
set
  published_canvas_ratio = '4:3',
  published_split_direction = 'horizontal'
where before_public_path is not null and after_public_path is not null;

alter table public.case_photo_pairs
  add constraint case_photo_pairs_published_layout_check
    check (
      (
        before_public_path is null
        and published_canvas_ratio is null
        and published_split_direction is null
      )
      or
      (
        before_public_path is not null
        and published_canvas_ratio is not null
        and published_split_direction is not null
      )
    );

-- Sanitized source WebPs can be larger than the final published derivatives.
update storage.buckets
set file_size_limit = 15728640,
    allowed_mime_types = array['image/webp']
where id = 'case-drafts';

-- Anonymous visitors can see only the layout that belongs to published images.
grant select (published_canvas_ratio, published_split_direction)
on public.case_photo_pairs to anon;
