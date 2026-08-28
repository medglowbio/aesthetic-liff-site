# Aesthetic LIFF Site

Treatment, case and doctor directory for GitHub Pages and LINE LIFF.

## Content Management

- `/admin/` manages cases.
- `/admin/catalog.html` manages treatment categories, treatments, products and images.
- Supabase Auth, Postgres, Storage and Edge Functions provide the draft, review and publish workflow.
- The public site reads published catalog data through `get_published_treatment_catalog()` and keeps the embedded catalog as an offline fallback.

## Supabase

Database migrations and Edge Functions live in `supabase/`. Apply them with the Supabase CLI from the repository root. Never commit service-role keys or the local `supabase/.temp/` directory.
