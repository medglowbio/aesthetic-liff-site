import { createClient, type User } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

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

export type WorkflowClient = ReturnType<typeof createWorkflowClient>;

type StaffProfile = {
  id: string;
  role: string;
  active: boolean;
};

type WorkflowContext = {
  client: WorkflowClient;
  user: User;
  profile: StaffProfile;
};

type WorkflowRequestResult =
  | { response: Response; context?: never }
  | { response?: never; context: WorkflowContext };

export function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

export async function prepareWorkflowRequest(request: Request): Promise<WorkflowRequestResult> {
  if (request.method === "OPTIONS") {
    return { response: new Response("ok", { headers: corsHeaders }) };
  }
  if (request.method !== "POST") {
    return { response: json(405, { error: "Method not allowed" }) };
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization) {
    return { response: json(401, { error: "Missing authorization" }) };
  }

  const client = createWorkflowClient(authorization);
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) {
    return { response: json(401, { error: "Invalid session" }) };
  }

  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("id,role,active")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError) {
    return { response: json(500, { error: `Profile lookup failed: ${profileError.message}` }) };
  }
  if (!profile) {
    return { response: json(403, { error: "找不到此登入帳號的後台權限資料" }) };
  }
  if (!profile.active) {
    return { response: json(403, { error: "此後台帳號已停用" }) };
  }

  return { context: { client, user: userData.user, profile } };
}
