export const STATUT_LABELS: Record<string, string> = {
  present: "Présent",
  retard: "Retard",
  absent: "Absent",
  absent_justifie: "Absent justifié",
  conge: "Congé",
};

export const STATUT_CLASS: Record<string, string> = {
  present: "statut-present",
  retard: "statut-retard",
  absent: "statut-absent",
  absent_justifie: "statut-justifie",
  conge: "statut-conge",
};

export const DEMANDE_TYPE_LABELS: Record<string, string> = {
  conge_annuel: "Congé annuel",
  sortie_anticipee: "Sortie anticipée",
  absence_exceptionnelle: "Absence exceptionnelle",
  avance: "Demande d'avance",
};

export const DEMANDE_STATUT_LABELS: Record<string, string> = {
  en_attente: "En attente",
  approuve: "Approuvée",
  refuse: "Refusée",
};

export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  generique: "Information",
  demande: "Demande",
  prime: "Prime",
  conges: "Congés",
  retard: "Retard",
  systeme: "Système",
};

// Prime status classes for badges
export const PRIME_STATUT_CLASS = {
  pending: "bg-yellow-100 text-yellow-800",
  granted: "bg-green-100 text-green-800",
};

export function formatDateFR(d: string | Date, yearFormat: "2-digit" | "numeric" = "2-digit"): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = yearFormat === "numeric" ? String(date.getFullYear()) : String(date.getFullYear()).slice(-2);
  return `${day}/${month}/${year}`;
}

export function formatTimeFR(t: string | null): string {
  if (!t) return "—";
  return t.slice(0, 5);
}

export function minutesToDecimal(minutes: number | null | undefined): number {
  if (minutes === null || minutes === undefined) return 0;
  return Math.round((minutes / 60) * 100) / 100;
}

export function calculerDureeHeures(debut: string, fin: string): number {
  if (!debut || !fin) return 0;
  const [h1, m1] = debut.split(":").map(Number);
  const [h2, m2] = fin.split(":").map(Number);
  const totalMinutes = (h2 * 60 + m2) - (h1 * 60 + m1);
  return totalMinutes / 60;
}

export function formatDuree(heures: number): string {
  if (heures === 0) return "0 min";
  if (heures < 0) return formatDuree(Math.abs(heures));
  const h = Math.floor(heures);
  const m = Math.round((heures - h) * 60);
  if (h === 0) return `${m} min`;
  return `${h}h${m.toString().padStart(2, "0")}`;
}

// Format amount as euros
export function formatMontant(montant: number | null | undefined): string {
  if (montant === null || montant === undefined) return "—";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "TND",
    minimumFractionDigits: 2,
  }).format(montant);
}

// Format prime amount specifically (alias for formatMontant)
export const formatPrime = formatMontant;

export function joursEntre(debut: string, fin: string): number {
  const d1 = new Date(debut);
  const d2 = new Date(fin);
  const diff = d2.getTime() - d1.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export function isJourFerie(date: string, joursFeries: string[]): boolean {
  return joursFeries.includes(date);
}

export function nomJour(d: Date): string {
  return d.toLocaleDateString("fr-FR", { weekday: "long" });
}

export function nomMois(d: Date): string {
  return d.toLocaleDateString("fr-FR", { month: "long" });
}

export function monthDays(year: number, monthIdx: number): Date[] {
  const days: Date[] = [];
  const d = new Date(year, monthIdx, 1);
  while (d.getMonth() === monthIdx) {
    days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatMinutesEnHeures(minutes: number | null | undefined): string {
  if (!minutes || minutes === 0) return "0 min";
  const absMinutes = Math.abs(minutes);
  const heures = Math.floor(absMinutes / 60);
  const mins = absMinutes % 60;
  if (heures === 0) return `${mins} min`;
  return `${heures}h${mins.toString().padStart(2, "0")}`;
}
export interface JourFerie { date: string; recurrent: boolean; }

export function estFerie(d: Date, feries: JourFerie[]): boolean {
  const iso = toISODate(d);
  const mmdd = iso.slice(5);
  return feries.some((f) => f.date === iso || (f.recurrent && f.date.slice(5) === mmdd));
}

export function estJourOuvre(d: Date, feries: JourFerie[]): boolean {
  const jour = d.getDay();
  if (jour === 0 || jour === 6) return false;
  return !estFerie(d, feries);
}

export function joursOuvresEntre(debut: Date, fin: Date, feries: JourFerie[]): number {
  let count = 0;
  const cur = new Date(debut.getFullYear(), debut.getMonth(), debut.getDate());
  const last = new Date(fin.getFullYear(), fin.getMonth(), fin.getDate());
  while (cur <= last) {
    if (estJourOuvre(cur, feries)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}