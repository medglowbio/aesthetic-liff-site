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
assert.match(shared, /export function workflowErrorMessage/);

const caseWorkflow = read("supabase/functions/case-workflow/index.ts");
const catalogWorkflow = read("supabase/functions/catalog-workflow/index.ts");
const catalogAdmin = read("admin/catalog.js");
assert.match(caseWorkflow, /auditClient\.from\("case_events"\)\.insert/);
assert.doesNotMatch(caseWorkflow, /userClient\.from\("case_events"\)\.insert/);
assert.match(catalogWorkflow, /auditClient\.from\("catalog_events"\)\.insert/);
assert.doesNotMatch(catalogWorkflow, /client\.from\("catalog_events"\)\.insert/);
assert.match(catalogWorkflow, /type Action = "created" \| "saved"/);
assert.match(catalogWorkflow, /action === "created" \|\| action === "saved"/);
assert.doesNotMatch(catalogAdmin, /\.from\("catalog_events"\)\.insert/);
assert.match(catalogAdmin, /recordDraftEvent\("created"\)/);
assert.match(catalogAdmin, /recordDraftEvent\("saved"\)/);
// Draft-stage audit rows go through the workflow function, but a failure there
// must not turn a saved draft into a reported save failure.
assert.match(catalogAdmin, /async function recordDraftEvent\(action\)[\s\S]*?await invoke\(action\)[\s\S]*?catch/);
assert.match(catalogAdmin, /toast\(`草稿已儲存\$\{auditWarning\}`\)/);

const publishCatch = caseWorkflow.slice(caseWorkflow.indexOf("} catch (error) {", caseWorkflow.indexOf('if (action === "publish")')));
assert.match(publishCatch, /from\("cases"\)\.update\(\{\s*status: caseItem\.status/);
assert.match(publishCatch, /published_canvas_ratio: pair\.published_canvas_ratio/);
assert.ok(
  publishCatch.indexOf('from("cases").update') < publishCatch.indexOf('storage.from("case-published").remove(uploaded)'),
  "case status is restored before failed publish images are removed"
);

const migration = read("supabase/migrations/202609060001_secure_workflow_audit_events.sql");
assert.match(migration, /revoke insert on public\.case_events from authenticated/);
assert.match(migration, /revoke insert on public\.catalog_events from authenticated/);
const serviceRoleGrant = read("supabase/migrations/202609060002_grant_workflow_audit_service_role.sql");
assert.match(serviceRoleGrant, /grant insert on public\.case_events to service_role/);
assert.match(serviceRoleGrant, /grant insert on public\.catalog_events to service_role/);
// service_role holds INSERT and nothing else on the audit tables, so the audit
// client must never read from them - reads run as the signed-in user under RLS.
assert.doesNotMatch(serviceRoleGrant, /grant[^;]*select[^;]*to service_role/i);
assert.doesNotMatch(caseWorkflow, /auditClient[\s\S]{0,120}?\.select\(/);
assert.doesNotMatch(catalogWorkflow, /auditClient[\s\S]{0,120}?\.select\(/);
assert.match(catalogWorkflow, /client\.from\("catalog_events"\)\s*\n?\s*\.select\(/);
assert.match(caseWorkflow, /workflowErrorMessage\(error, "Workflow failed"\)/);
assert.match(catalogWorkflow, /workflowErrorMessage\(error, "Catalog workflow failed"\)/);
assert.ok(fs.existsSync(new URL("../SUPABASE_SETUP.md", import.meta.url)));

console.log("Verified audit permissions, service-role event writes, CORS allow-list and pinned SDK versions.");
