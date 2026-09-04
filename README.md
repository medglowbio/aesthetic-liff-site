# Aesthetic LIFF Site

Treatment, case and doctor directory for GitHub Pages and LINE LIFF.

## Content Management

- `/admin/` manages cases.
- Case photo pairs support 4:3, 3:4 and 1:1 canvases in horizontal or vertical layouts; sanitized private source WebPs remain available for non-destructive recropping.
- `/admin/catalog.html` manages treatment categories, treatments, products and images.
- Supabase Auth, Postgres, Storage and Edge Functions provide the draft, review and publish workflow.
- The public site renders the catalog snapshot embedded in `index.html` first, then replaces it with published data from `get_published_treatment_catalog()`.
- Successful Supabase responses are cached in `localStorage`. If the network request fails, the site uses that cache when available and otherwise keeps the embedded snapshot visible.

## Supabase

Database migrations and Edge Functions live in `supabase/`. Apply them with the Supabase CLI from the repository root. Never commit service-role keys or the local `supabase/.temp/` directory.
