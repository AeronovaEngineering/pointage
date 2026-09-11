import { supabase } from "@/integrations/supabase/client";

export type FichePaieStatut = "brouillon" | "validee";

export interface FichePaieDetailLine {
  label: string;
  montant: number;
  type: "gain" | "deduction";
}

export interface FichePaie {
  id: string;
  user_id: string;
  mois: string; // ISO date, always the 1st of the month
  statut: FichePaieStatut;
  salaire_base: number;
  jours_travailles: number;
  jours_absence: number;
  jours_absence_justifiee: number;
  jours_conge: number;
  jours_ouvres_mois: number;
  jours_feries_travailles: number;
  retard_minutes: number;
  heures_supplementaires: number;
  heures_supplementaires_brutes: number;
  montant_primes: number;
  montant_deductions: number;
  net_a_payer: number;
  solde_conge: number;
  droit_conge: number;
  details: FichePaieDetailLine[];
  commentaire_admin: string | null;
  genere_par: string | null;
  valide_par: string | null;
  valide_at: string | null;
  created_at: string;
  updated_at: string;
}

// First-of-month ISO date for a given year/monthIndex (0-based), the shape
// the DB stores `mois` as.
export function moisISO(year: number, monthIndex: number): string {
  const m = String(monthIndex + 1).padStart(2, "0");
  return `${year}-${m}-01`;
}

export function moisLabel(moisISODate: string): string {
  const [y, m] = moisISODate.split("-").map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// The generated Supabase types widen `statut` to `string` (Postgres CHECK
// constraints aren't reflected as literal unions) and `details` to `Json`.
// We know both are narrower by construction (only ever written by the code
// in this file / the SQL functions), so we cast once at the boundary rather
// than loosening FichePaie everywhere it's used across the app.
function asFichePaie(row: any): FichePaie {
  return row as FichePaie;
}

export async function fetchFichesPaie(userId: string): Promise<FichePaie[]> {
  const { data, error } = await supabase
    .from("fiches_paie")
    .select("*")
    .eq("user_id", userId)
    .order("mois", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(asFichePaie);
}

export async function fetchFichePaie(userId: string, moisISODate: string): Promise<FichePaie | null> {
  const { data, error } = await supabase
    .from("fiches_paie")
    .select("*")
    .eq("user_id", userId)
    .eq("mois", moisISODate)
    .maybeSingle();
  if (error) throw error;
  return data ? asFichePaie(data) : null;
}

// Admin: build/refresh a draft from attendance + primes for that month.
export async function genererFichePaie(userId: string, moisISODate: string): Promise<FichePaie> {
  const { data, error } = await supabase.rpc("generer_fiche_paie", { _user_id: userId, _mois: moisISODate });
  if (error) throw error;
  return asFichePaie(data);
}

// Admin: persist manual edits to a still-draft fiche (line items, comment).
export async function updateFichePaie(
  id: string,
  patch: Partial<Pick<FichePaie, "details" | "commentaire_admin" | "montant_primes" | "montant_deductions" | "net_a_payer">>
): Promise<void> {
  const { error } = await supabase.from("fiches_paie").update(patch as any).eq("id", id);
  if (error) throw error;
}

export async function validerFichePaie(id: string): Promise<FichePaie> {
  const { data, error } = await supabase.rpc("valider_fiche_paie", { _fiche_id: id });
  if (error) throw error;
  return asFichePaie(data);
}

export async function devaliderFichePaie(id: string): Promise<FichePaie> {
  const { data, error } = await supabase.rpc("devalider_fiche_paie", { _fiche_id: id });
  if (error) throw error;
  return asFichePaie(data);
}

// Recompute net_a_payer from a details array (sum of gains + deductions,
// deductions are stored as negative montant already).
export function computeNet(details: FichePaieDetailLine[]): number {
  return Math.round(details.reduce((sum, d) => sum + d.montant, 0) * 100) / 100;
}