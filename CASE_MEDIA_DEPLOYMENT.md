# Mixed photo / video cases

This change is review-only until the migration, workflow and both interfaces have
been deployed together. It does not upload sample cases or alter existing case
content. PR #7's masonry is already present in the main branch used by this PR.

## Release order

1. Back up the database and confirm the Storage global upload limit is at least
   52,428,800 bytes (50 MiB). Do not change billing plans automatically.
2. Apply `supabase/migrations/202609100001_case_mixed_media.sql`. This preserves
   existing IDs, paths, crop rectangles, ordering and published image layouts.
   `case_photo_pairs` becomes the backing table for both single and comparison
   groups. Existing rows default to image/image comparison groups.
3. Deploy `case-workflow` together with its shared helpers and the shared
   `assets/js/case-media.js` module. The Supabase bundler must include that relative
   import; run `npm run test:edge` before deploying.
4. Deploy the public page, admin page and all changed/new JS and CSS. Verify the
   versioned scripts load without cache or CDN errors, including tus-js-client
   4.3.1. Open a fresh admin tab before enabling new media uploads for staff.
5. Smoke-test a private draft, reviewer preview, mixed-media publication and
   unpublication in a staging project before enabling production uploads.

Do not deploy the new admin ahead of the public page/workflow. Older clients only
understand photo comparisons. Staff should refresh existing admin tabs after the
release. New media capability is not safe to roll back to a photos-only UI while
published mixed-media cases remain visible.

## Storage and formats

- Photos retain the existing `case-drafts` / `case-published` workflow and limits.
- `case-video-drafts` is private; `case-video-published` serves approved MP4 files
  and WebP posters. Video maximum: 50 MiB and 60 seconds; poster maximum: 5 MiB.
- Supported uploads are ordinary, non-fragmented H.264 MP4 files, with AAC audio
  or no audio. HEVC/MOV and other formats require re-exporting in a video editor.
- Header inspection is shared between browser and server. The server checks the
  stored object's size, MIME type and case ownership, then reads only bounded
  MP4 header/index ranges. Publication uses cross-bucket copy rather than loading
  the full movie into Edge Function memory.
- Export metadata embedded inside the MP4 is not stripped or transcoded by this
  feature. Only reviewed exports should be published. Image sanitization remains
  unchanged.
- TUS uploads use immutable UUID paths, 6 MiB chunks and refreshed auth headers.
  Cancel pauses the transfer; saving again in the same editor resumes it. Do not
  close the tab until saved. A failed/abandoned unfinished TUS session may remain
  until Storage expires it; completed replacement objects are explicitly cleaned.

## Playback

The gallery loads posters only. Details render each group in order. Mixed
photo/video groups keep the photo still. Video/video groups share a timeline
ending at the shorter duration, pause together during buffering, and correct
drift above 150 ms. This is approximate browser synchronization, not frame-locked
clinical measurement. Sound is initially muted; paired playback enables only the
after video's audio. Opening another group pauses the previous player. Closing a
case releases video sources and event listeners.

## Tests and review artifacts

- `npm ci && npm test`: existing checks plus actual MP4 parsing, six combinations,
  public mapping, and a PGlite PostgreSQL migration/RLS test.
- `npm run test:edge`: request/auth tests, publication success/rollback/failure
  tests, and Deno type checks.
- `tools/fixtures/` contains synthetic color/test-pattern media only. These are
  not patient records or treatment results.
- Browser QA uses a local server and mocked auth/storage/workflow endpoints;
  it must not send QA uploads to a live Supabase project.
- Real iPhone Safari and LINE WebView validation must be recorded separately.
  Desktop Chromium or emulation is not a substitute for those device checks.

## Recovery

If new-media rollout fails, disable further staff uploads, keep the new schema,
and repair the frontend/workflow together. Do not drop the new columns or buckets:
they may contain reviewed media. Before rolling back to a photo-only release,
unpublish cases using single/mixed/video groups through the new workflow, retain
private originals, and verify that all remaining published cases are legacy
photo comparisons. Publication failures restore database snapshots before
removing newly copied objects; investigate any explicit rollback/cleanup errors
before retrying. Deleted public URLs may remain in browser/CDN caches until expiry.

## Reproduce browser QA

Use Playwright CLI from the repository root, with a dedicated browser session.
Start `python3 tools/browser/range-server.py` (loopback port 8767); the Range
support is required for meaningful seeking tests. Plain Python http.server
cannot reproduce video seeking reliably. Run `node tools/browser/prepare-fixture.mjs`
to generate an 8 MiB padded synthetic movie in ignored output storage.

Open a Playwright session, then use `run-code --filename` with each file:

- `tools/browser/verify-admin-media.js`
- `tools/browser/verify-upload-resume.js`
- `tools/browser/verify-case-media.js`
- `tools/browser/capture-previews.js` (after the public test)

The upload test intentionally cancels at 75%, resumes with HEAD/PATCH, injects
one disconnected PATCH and checks recovery without a second POST or duplicate
case. The public test checks six combinations, five viewport widths, no gallery
video downloads, native mixed-media playback, shared controls, a simulated
waiting/canplay transition, the shorter endpoint and disposal. Browser test
requests to Supabase are intercepted; these tests do not create live cases.

Reference: [Supabase resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads).
