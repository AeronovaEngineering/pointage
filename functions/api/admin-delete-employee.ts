// functions/api/admin-delete-employee.ts
// Route: POST /api/admin-delete-employee
import { requireAdmin, type Env } from "./_shared";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  try {
    const { supabaseAdmin, userId: callerId } = await requireAdmin(request, env);
    const { userId } = (await request.json()) as { userId: string };

    if (userId === callerId) {
      return Response.json({ error: "Vous ne pouvez pas vous supprimer" }, { status: 400 });
    }

    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (error) return Response.json({ error: error.message }, { status: 400 });

    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof Response) return err;
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
};