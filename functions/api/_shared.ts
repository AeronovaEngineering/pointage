// functions/api/_shared.ts
import { createClient } from "@supabase/supabase-js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  META_PHONE_NUMBER_ID?: string;
  META_ACCESS_TOKEN?: string;
  META_FROM_PHONE?: string;
  ADMIN_WHATSAPP_NUMBER?: string;
}

export function getAdminClient(env: Env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function requireAdmin(request: Request, env: Env) {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    throw new Response("Unauthorized", { status: 401 });
  }
  const token = auth.replace("Bearer ", "");
  const supabaseAdmin = getAdminClient(env);

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const { data: isAdmin, error: adminError } = await supabaseAdmin.rpc("is_admin", {
    _user_id: userData.user.id,
  });
  if (adminError || !isAdmin) {
    throw new Response("Accès admin requis", { status: 403 });
  }

  return { supabaseAdmin, userId: userData.user.id };
}