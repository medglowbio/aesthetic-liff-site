import { createClient, type User } from "npm:@supabase/supabase-js@2.115.0";

const productionOrigins = new Set([
  "https://medglowbio.github.io"
]);

function isAllowedOrigin(origin: string) {
  return productionOrigins.has(origin)
    || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

export function workflowCorsHeaders(request: Request) {
  const origin = request.headers.get("Origin") || "";
  return {
    ...(isAllowedOrigin(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

function createWorkflowClient(authorization: string) {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false }
    }
  );
}

function createAuditClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export type WorkflowClient = ReturnType<typeof createWorkflowClient>;

type StaffProfile = {
  id: string;
  role: string;
  active: boolean;
};

type WorkflowContext = {
  client: WorkflowClient;
  auditClient: WorkflowClient;
  user: User;
  profile: StaffProfile;
};

type WorkflowRequestResult =
  | { response: Response; context?: never }
  | { response?: never; context: WorkflowContext };

export function json(request: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...workflowCorsHeaders(request), "Content-Type": "application/json" }
  });
}

export function workflowErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message || "").trim();
    if (message) return message;
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}

export async function prepareWorkflowRequest(request: Request): Promise<WorkflowRequestResult> {
  const origin = request.headers.get("Origin");
  if (origin && !isAllowedOrigin(origin)) {
    return { response: json(request, 403, { error: "Origin not allowed" }) };
  }
  if (request.method === "OPTIONS") {
    return { response: new Response("ok", { headers: workflowCorsHeaders(request) }) };
  }
  if (request.method !== "POST") {
    return { response: json(request, 405, { error: "Method not allowed" }) };
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization) {
    return { response: json(request, 401, { error: "Missing authorization" }) };
  }

  const client = createWorkflowClient(authorization);
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) {
    return { response: json(request, 401, { error: "Invalid session" }) };
  }

  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("id,role,active")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError) {
    return { response: json(request, 500, { error: `Profile lookup failed: ${profileError.message}` }) };
  }
  if (!profile) {
    return { response: json(request, 403, { error: "找不到此登入帳號的後台權限資料" }) };
  }
  if (!profile.active) {
    return { response: json(request, 403, { error: "此後台帳號已停用" }) };
  }

  return { context: { client, auditClient: createAuditClient(), user: userData.user, profile } };
}
