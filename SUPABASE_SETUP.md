# Supabase Setup

This project uses Supabase Auth, Postgres, Storage and two Edge Functions for
the case and treatment review workflows.

## 1. Create and configure the project

1. Create a Supabase project and install the current Supabase CLI.
2. In Authentication settings, disable public sign-up. Staff accounts should be
   created or invited by an administrator.
3. Set the production site URL to
   `https://medglowbio.github.io/aesthetic-liff-site/` and allow the matching
   `/admin/` redirect. Add the local `http://127.0.0.1:<port>/admin/` redirect
   used for development.
4. Copy the project URL and publishable key into
   `assets/config/supabase-config.js`. This file must never contain a secret or
   service-role key.

If the production origin changes, update the allow-list in
`supabase/functions/_shared/workflow-request.ts` before deploying the
functions.

## 2. Apply the database

Link the repository to the target project, test migrations in a staging
project, then push them in timestamp order:

```sh
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push
```

The migrations create the application tables, RLS policies, public RPCs and
these Storage buckets:

- `case-drafts` (private)
- `case-published` (public)
- `treatment-drafts` (private)
- `treatment-published` (public)

Do not edit an already-applied migration. Add a new forward-only migration and
verify it in staging first.

### Rollout order for an existing environment

The static site, the Edge Functions and the database are deployed separately,
and merging to `main` publishes the site to GitHub Pages within about a minute.
Upgrading through `202609060001_secure_workflow_audit_events.sql` therefore has
to run in this order:

1. **Deploy both Edge Functions.** The updated functions accept every action the
   current and the new admin pages send, so they are safe to deploy while the
   old site is still live.
2. **Merge to `main`** and let GitHub Pages publish the new admin pages.
3. **Run `supabase db push`.** The functions now write audit rows with the
   service-role client, so removing direct browser insert access does not
   interrupt workflow event logging.

Deploying in a different order does not lose data — draft-stage audit calls
degrade to a `操作紀錄稍後補登` warning — but the catalog revision history will
have gaps for anything saved during the window.

## 3. Deploy Edge Functions

For a new empty project, deploy both workflows after migrations finish:

```sh
npx supabase functions deploy case-workflow
npx supabase functions deploy catalog-workflow
```

Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` to hosted functions. The service-role client is
used only to append server-validated audit events; it must not be exposed to
the browser.

## 4. Add staff accounts

Create or invite users from the Authentication dashboard. Confirm every user
has a row in `public.profiles` with an enabled `editor` or `reviewer` role.
Keep public registration disabled.

## 5. Verify

Run local checks and then test with both roles:

```sh
npm test
npm run test:edge
```

Verify that anonymous users see only published content, editors cannot publish,
reviewers can complete workflow actions, private draft images are inaccessible,
and browser clients cannot insert audit rows directly.
