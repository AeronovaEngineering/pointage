import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, XCircle } from "lucide-react";
import { STATUT_CLASS, STATUT_LABELS, monthDays, toISODate, formatMinutesEnHeures } from "@/lib/format";
import { cn } from "@/lib/utils";

const JOURS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const MOIS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

export function EmployeeCalendar({ userId }: { userId: string }) {
  const [cursor, setCursor] = useState(new Date());
  const year = cursor.getFullYear();
  const monthIdx = cursor.getMonth();
  const days = monthDays(year, monthIdx);
  const firstDayOfWeek = (new Date(year, monthIdx, 1).getDay() + 6) % 7;

  const { data: pointages = [] } = useQuery({
    queryKey: ["pointages-month", userId, year, monthIdx],
    queryFn: async () => {
      const start = toISODate(new Date(year, monthIdx, 1));
      const end = toISODate(new Date(year, monthIdx + 1, 0));
      const { data } = await supabase.from("pointages").select("date,statut,heure_pointage,retard_minutes").eq("user_id", userId).gte("date", start).lte("date", end);
      return data ?? [];
    },
  });
  const { data: conges = [] } = useQuery({
    queryKey: ["conges-month", userId, year, monthIdx],
    queryFn: async () => {
      const start = toISODate(new Date(year, monthIdx, 1));
      const end = toISODate(new Date(year, monthIdx + 1, 0));
      const { data } = await supabase
        .from("demandes")
        .select("date_debut,date_fin")
        .eq("user_id", userId)
        .eq("statut", "approuve")
        .eq("type", "conge_annuel")
        .lte("date_debut", end)
        .gte("date_fin", start);
      return data ?? [];
    },
  });

  const congeSet = new Set<string>();
  conges.forEach((c) => {
    let d = new Date(c.date_debut);
    const fin = new Date(c.date_fin);
    while (d <= fin) {
      congeSet.add(toISODate(d));
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
  });
  const { data: feries = [] } = useQuery({
    queryKey: ["feries-month", year, monthIdx],
    queryFn: async () => {
      const start = toISODate(new Date(year, monthIdx, 1));
      const end = toISODate(new Date(year, monthIdx + 1, 0));
      const { data } = await supabase.from("jours_feries").select("date,libelle").gte("date", start).lte("date", end);
      return data ?? [];
    },
  });

  const map = new Map(pointages.map((p) => [p.date, p]));
  const ferieSet = new Map(feries.map((f) => [f.date, f.libelle]));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <Button variant="outline" size="icon" onClick={() => setCursor(new Date(year, monthIdx - 1, 1))}>
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <div className="font-semibold text-lg">{MOIS[monthIdx]} {year}</div>
        <Button variant="outline" size="icon" onClick={() => setCursor(new Date(year, monthIdx + 1, 1))}>
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground mb-1">
        {JOURS.map((j) => <div key={j} className="py-1">{j}</div>)}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: firstDayOfWeek }).map((_, i) => <div key={"e" + i} />)}
        {days.map((d) => {
          const iso = toISODate(d);
          const p = map.get(iso);
          const ferie = ferieSet.get(iso);
          const dow = d.getDay();
          const isWeekend = dow === 0 || dow === 6;
          const isToday = iso === toISODate(new Date());
          return (
            <div
              key={iso}
              className={cn(
                "aspect-square p-1 rounded-md border text-xs flex flex-col items-start justify-between",
                congeSet.has(iso) ? STATUT_CLASS.conge : p ? STATUT_CLASS[p.statut] : "bg-card",
                ferie && "statut-ferie",
                isWeekend && !p && !ferie && "bg-muted/40 border-transparent text-muted-foreground",
                isToday && "ring-2 ring-primary",
              )}
              title={ferie || (p ? STATUT_LABELS[p.statut] : "")}
            >
              <span className="font-medium">{d.getDate()}</span>
              {congeSet.has(iso) && <span className="text-[10px] opacity-80">Congé</span>}
              {!congeSet.has(iso) && p?.statut === "absent" && <XCircle className="w-3 h-3 text-destructive" />}
              {!congeSet.has(iso) && p?.statut === "absent_justifie" && <span className="text-[10px] opacity-80">Justifié</span>}
              {!congeSet.has(iso) && p?.heure_pointage && p?.statut !== "absent" && p?.statut !== "absent_justifie" && (
                <span className="text-[10px] opacity-80">{p.heure_pointage.slice(0, 5)}</span>
              )}
              {!congeSet.has(iso) && p?.retard_minutes ? <span className="text-[10px] opacity-80">+{formatMinutesEnHeures(p.retard_minutes)}</span> : null}
            </div>
          );
        })}
      </div>

      {/* 🟢 LÉGENDE - AJOUT DE variant="outline" */}
      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        <Badge variant="outline" className="statut-present border">Présent</Badge>
        <Badge variant="outline" className="statut-retard border">Retard</Badge>
        <Badge variant="outline" className="statut-absent border">Absent</Badge>
        <Badge variant="outline" className="statut-justifie border">Justifié</Badge>
        <Badge variant="outline" className="statut-conge border">Congé</Badge>
        <Badge variant="outline" className="statut-ferie border">Férié</Badge>
      </div>
    </div>
  );
}