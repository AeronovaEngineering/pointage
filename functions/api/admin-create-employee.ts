// functions/api/admin-create-employee.ts
// Route: POST /api/admin-create-employee
import { requireAdmin, type Env } from "./_shared";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  try {
    const { supabaseAdmin } = await requireAdmin(request, env);
    const body = (await request.json()) as {
      email: string;
      password: string;
      nom: string;
      prenom: string;
      poste?: string;
      departement?: string;
      role?: string;
      date_embauche?: string;
    };
    const { email, password, nom, prenom, poste, departement, role, date_embauche } = body;

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { nom, prenom },
    });

    if (authError) {
      console.error("admin-create-employee: auth.admin.createUser failed:", authError);
      return Response.json(
        { error: authError.message || String(authError) || "Erreur inconnue (création du compte)" },
        { status: 400 }
      );
    }

    const userId = authData.user.id;

    // profiles + user_roles are already created automatically by the
    // handle_new_user() trigger on auth.users insert (with role defaulting
    // to 'employe', or 'admin' if this is literally the first user ever).
    // We only need to UPDATE the extra fields the trigger doesn't set,
    // and fix the role if the admin picked something different.

    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .update({
        poste: poste || null,
        departement: departement || null,
        date_embauche: date_embauche || new Date().toISOString().split("T")[0],
      })
      .eq("id", userId);

    if (profileError) {
      console.error("admin-create-employee: profiles update failed:", profileError);
      return Response.json(
        { error: profileError.message || String(profileError) || "Erreur inconnue (profil)" },
        { status: 400 }
      );
    }

    if (role && role !== "employe") {
      const { error: roleError } = await supabaseAdmin
        .from("user_roles")
        .update({ role })
        .eq("user_id", userId);

      if (roleError) {
        console.error("admin-create-employee: user_roles update failed:", roleError);
        return Response.json(
          { error: roleError.message || String(roleError) || "Erreur inconnue (rôle)" },
          { status: 400 }
        );
      }
    }

    return Response.json({ ok: true, userId });
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("admin-create-employee: unexpected failure:", err);
    return Response.json(
      { error: (err as Error)?.message || "Erreur serveur inconnue" },
      { status: 500 }
    );
  }
};