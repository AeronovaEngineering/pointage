import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentUser, displayName, initials } from "@/lib/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { EmployeeCalendar } from "@/components/EmployeeCalendar";
import { PrimeModal } from "@/components/PrimeModal";
import { formatTimeFR, toISODate, STATUT_LABELS, STATUT_CLASS, formatMinutesEnHeures } from "@/lib/format";
import { Clock, Coffee, Play, LogOut, CheckCircle2, AlertCircle, XCircle, Calendar as CalIcon, FileText, Gift } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/calendrier")({
  beforeLoad: async () => {
    const u = await fetchCurrentUser();
    if (!u || u.role !== "admin") throw new Error("Accès superviseur requis");
  },
  component: SuperviseurCalendrier,
});

function SuperviseurCalendrier() {
  const { data: employees = [] } = useQuery({
    queryKey: ["all-profiles-list"],
    queryFn: async () => {
      const [{ data: profs }, { data: roles }] = await Promise.all([
        supabase.from("profiles").select("id,nom,prenom,email,photo_url,poste,departement").order("nom"),
        supabase.from("user_roles").select("user_id,role").eq("role", "admin"),
      ]);
      const adminIds = new Set((roles ?? []).map((r) => r.user_id));
      return (profs ?? []).filter((p) => !adminIds.has(p.id));
    },
  });
  const [selected, setSelected] = useState<string>("");
  const [showPrimeModal, setShowPrimeModal] = useState(false);
  const current = selected || employees[0]?.id;
  const currentEmp = employees.find((e) => e.id === current);

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold">Calendrier des employés</h1>
          <p className="text-muted-foreground">Consultez l'activité complète de chaque membre</p>
        </div>
        <Select value={current} onValueChange={setSelected}>
          <SelectTrigger className="w-72"><SelectValue placeholder="Choisir un employé" /></SelectTrigger>
          <SelectContent>
            {employees.map((e) => <SelectItem key={e.id} value={e.id}>{displayName(e as any)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {current && currentEmp && (
        <>
          <Card>
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <Avatar className="w-14 h-14">
                  <AvatarImage src={currentEmp.photo_url ?? undefined} />
                  <AvatarFallback>{initials(currentEmp as any)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="font-semibold text-lg">{displayName(currentEmp as any)}</div>
                  <div className="text-sm text-muted-foreground">{currentEmp.poste || "—"} • {currentEmp.departement || "—"}</div>
                </div>
              </div>
              <Button 
                onClick={() => setShowPrimeModal(true)}
                variant="outline"
                className="flex items-center gap-2"
              >
                <Gift className="w-4 h-4" />
                Prime
              </Button>
            </CardContent>
          </Card>

          {showPrimeModal && (
            <PrimeModal
              employee={currentEmp}
              onClose={() => setShowPrimeModal(false)}
              onSuccess={() => {
                setShowPrimeModal(false);
              }}
            />
          )}

          <MonthlyStats userId={current} />
          <TodayDetail userId={current} />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalIcon className="w-5 h-5" />
                Calendrier mensuel
              </CardTitle>
            </CardHeader>
            <CardContent>
              <EmployeeCalendar userId={current} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function MonthlyStats({ userId }: { userId: string }) {
  const start = new Date(); start.setDate(1);
  const { data: stats } = useQuery({
    queryKey: ["superviseur-emp-stats", userId, toISODate(start)],
    queryFn: async () => {
      const { data } = await supabase.from("pointages").select("statut,retard_minutes").eq("user_id", userId).gte("date", toISODate(start));
      const counts = { present: 0, retard: 0, absent: 0, absent_justifie: 0, conge: 0, retard_total: 0 };
      (data || []).forEach((r: any) => {
        counts[r.statut as keyof typeof counts] = ((counts[r.statut as keyof typeof counts] as number) || 0) + 1;
        counts.retard_total += r.retard_minutes || 0;
      });
      return counts;
    },
  });
  return (
    <div className="grid gap-3 grid-cols-2 md:grid-cols-5">
      <StatMini label="Présents" value={stats?.present ?? 0} icon={CheckCircle2} color="text-success" />
      <StatMini label="Retards" value={stats?.retard ?? 0} sub={formatMinutesEnHeures(stats?.retard_total)} icon={AlertCircle} color="text-warning" />
      <StatMini label="Absents" value={stats?.absent ?? 0} icon={XCircle} color="text-destructive" />
      <StatMini label="Justifiés" value={stats?.absent_justifie ?? 0} icon={FileText} color="text-info" />
      <StatMini label="Congés" value={stats?.conge ?? 0} icon={CalIcon} color="text-conge" />
    </div>
  );
}

function StatMini({ label, value, sub, icon: Icon, color }: { label: string; value: number; sub?: string; icon: any; color: string }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-2xl font-semibold">{value}</div>
            <div className="text-xs text-muted-foreground mt-1">{label}</div>
            {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
          </div>
          <Icon className={cn("w-5 h-5", color)} />
        </div>
      </CardContent>
    </Card>
  );
}

function TodayDetail({ userId }: { userId: string }) {
  const today = toISODate(new Date());
  const { data: p } = useQuery({
    queryKey: ["superviseur-today", userId, today],
    queryFn: async () => (await supabase.from("pointages").select("*").eq("user_id", userId).eq("date", today).maybeSingle()).data,
  });

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Journée d'aujourd'hui</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {!p ? (
          <p className="text-sm text-muted-foreground">Aucun pointage aujourd'hui.</p>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className={cn(STATUT_CLASS[p.statut], "border")}>
                {STATUT_LABELS[p.statut]}
              </Badge>
              {p.retard_minutes ? <span className="text-sm text-muted-foreground">+{formatMinutesEnHeures(p.retard_minutes)} de retard</span> : null}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <TimeBox label="Arrivée" time={p.heure_pointage} icon={Clock} />
              <TimeBox label="Début pause" time={p.heure_debut_pause} icon={Coffee} />
              <TimeBox label="Fin pause" time={p.heure_fin_pause} icon={Play} />
              <TimeBox label="Sortie" time={p.heure_sortie} icon={LogOut} />
            </div>
            {p.taches_realisees && (
              <div className="p-3 rounded bg-muted/50 text-sm">
                <div className="font-medium mb-1">Tâches réalisées :</div>
                <p className="text-muted-foreground whitespace-pre-wrap">{p.taches_realisees}</p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TimeBox({ label, time, icon: Icon }: { label: string; time: string | null; icon: any }) {
  return (
    <div className={cn("p-2 rounded border flex items-center gap-2", time ? "statut-present" : "bg-muted/30")}>
      <Icon className={cn("w-4 h-4", time ? "text-success" : "text-muted-foreground")} />
      <div>
        <div className="text-[10px] text-muted-foreground">{label}</div>
        <div className="font-medium text-sm">{formatTimeFR(time)}</div>
      </div>
    </div>
  );
}