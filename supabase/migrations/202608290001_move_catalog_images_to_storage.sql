-- Point migrated catalog records at the immutable public Storage copies.

update public.treatment_categories
set image_url = 'https://qphyfixpjzzzwmypedzy.supabase.co/storage/v1/object/public/treatment-published/catalog/'
  || substring(image_url from length('assets/images/') + 1)
where image_url like 'assets/images/%';

update public.treatment_catalog
set image_url = 'https://qphyfixpjzzzwmypedzy.supabase.co/storage/v1/object/public/treatment-published/catalog/'
  || substring(image_url from length('assets/images/') + 1)
where image_url like 'assets/images/%';
