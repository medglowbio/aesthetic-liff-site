import { prepareWorkflowRequest, workflowCorsHeaders } from "./workflow-request.ts";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

Deno.test("allows the production admin origin", () => {
  const request = new Request("https://example.test", {
    headers: { Origin: "https://medglowbio.github.io" }
  });
  assertEqual(
    workflowCorsHeaders(request)["Access-Control-Allow-Origin"],
    "https://medglowbio.github.io",
    "production origin"
  );
});

Deno.test("allows local preview origins", () => {
  const request = new Request("https://example.test", {
    headers: { Origin: "http://127.0.0.1:8080" }
  });
  assertEqual(
    workflowCorsHeaders(request)["Access-Control-Allow-Origin"],
    "http://127.0.0.1:8080",
    "local origin"
  );
});

Deno.test("does not grant CORS to unknown origins", () => {
  const request = new Request("https://example.test", {
    headers: { Origin: "https://attacker.example" }
  });
  assertEqual(
    workflowCorsHeaders(request)["Access-Control-Allow-Origin"],
    undefined,
    "unknown origin"
  );
});

Deno.test("rejects an unknown browser origin before authentication", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    headers: { Origin: "https://attacker.example" }
  });
  const result = await prepareWorkflowRequest(request);
  assertEqual(result.response?.status, 403, "unknown-origin status");
  assertEqual(
    result.response?.headers.get("Access-Control-Allow-Origin"),
    null,
    "unknown-origin CORS header"
  );
});

Deno.test("returns CORS headers for unauthenticated production requests", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    headers: { Origin: "https://medglowbio.github.io" }
  });
  const result = await prepareWorkflowRequest(request);
  assertEqual(result.response?.status, 401, "missing-auth status");
  assertEqual(
    result.response?.headers.get("Access-Control-Allow-Origin"),
    "https://medglowbio.github.io",
    "production CORS header"
  );
});
