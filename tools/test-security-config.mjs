import assert from "node:assert/strict";
import fs from "node:fs";

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const browserFiles = ["index.html", "admin/index.html", "admin/catalog.html"];

for (const file of browserFiles) {
  const source = read(file);
  assert.match(source, /@supabase\/supabase-js@2\.115\.0/, `${file} pins Supabase JS`);
  assert.doesNotMatch(source, /@supabase\/supabase-js@2(?:["'<\/])/, `${file} has no floating major`);
}

const shared = read("supabase/functions/_shared/workflow-request.ts");
assert.match(shared, /@supabase\/supabase-js@2\.115\.0/);
assert.match(shared, /https:\/\/medglowbio\.github\.io/);
assert.doesNotMatch(shared, /Access-Control-Allow-Origin["']:\s*["']\*["']/);
assert.match(shared, /SUPABASE_SERVICE_ROLE_KEY/);

const caseWorkflow = read("supabase/functions/case-workflow/index.ts");
const catalogWorkflow = read("supabase/functions/catalog-workflow/index.ts");
assert.match(caseWorkflow, /auditClient\.from\("case_events"\)\.insert/);
assert.doesNotMatch(caseWorkflow, /userClient\.from\("case_events"\)\.insert/);
assert.match(catalogWorkflow, /auditClient\.from\("catalog_events"\)\.insert/);
assert.doesNotMatch(catalogWorkflow, /client\.from\("catalog_events"\)\.insert/);

const migration = read("supabase/migrations/202609060001_secure_workflow_audit_events.sql");
assert.match(migration, /revoke insert on public\.case_events from authenticated/);
assert.match(migration, /revoke insert on public\.catalog_events from authenticated/);
assert.ok(fs.existsSync(new URL("../SUPABASE_SETUP.md", import.meta.url)));

console.log("Verified audit permissions, service-role event writes, CORS allow-list and pinned SDK versions.");
