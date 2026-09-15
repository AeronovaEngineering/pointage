import { supabase } from "@/integrations/supabase/client";

export interface UserProfile {
  id: string;
  email: string;
  nom: string;
  prenom: string;
  role: "admin" | "employe";
  actif: boolean;
  photo_url?: string;
  telephone?: string;
  adresse?: string;
  poste?: string;
  departement?: string;
  date_embauche?: string;
  // Nouveaux champs
  profil_completed?: boolean;
  date_naissance?: string;
  cni?: string;
  rib?: string;
  whatsapp?: string;
  email_personnel?: string;
  nationalite?: string;
  urgence_nom?: string;
  urgence_relation?: string;
  urgence_telephone?: string;
  mutuelle?: string;
  num_secu?: string;
  groupe_sanguin?: string;
  allergies?: string;
  manager?: string;
  type_contrat?: string;
  politique_horaire?: string;
  situation_familiale?: string;
  nombre_enfants?: number;
  created_at?: string;
  updated_at?: string;
}

export async function fetchCurrentUser(): Promise<UserProfile | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();

  if (error || !profile) return null;

  const { data: roleData } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", session.user.id)
    .single();

  return {
    ...profile,
    role: roleData?.role || "employe",
    email: session.user.email || "",
  };
}

// ============================================================
// FONCTIONS UTILITAIRES
// ============================================================

export function displayName(user: { nom?: string | null; prenom?: string | null; email?: string }): string {
  if (user.prenom && user.nom) {
    return `${user.prenom} ${user.nom}`;
  }
  if (user.nom) return user.nom;
  if (user.prenom) return user.prenom;
  return user.email || "Utilisateur";
}

export function initials(user: { nom?: string | null; prenom?: string | null; email?: string }): string {
  if (user.prenom && user.nom) {
    return `${user.prenom[0]}${user.nom[0]}`.toUpperCase();
  }
  if (user.nom) return user.nom[0].toUpperCase();
  if (user.prenom) return user.prenom[0].toUpperCase();
  return (user.email?.[0] || "U").toUpperCase();
}