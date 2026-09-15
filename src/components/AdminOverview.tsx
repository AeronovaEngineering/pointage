import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";
import { Users, AlertCircle, FileCheck, Clock, TrendingDown, Palmtree, UserX } from "lucide-react";
import { STATUT_CLASS, STATUT_LABELS, toISODate, joursOuvresEntre, formatDateFR, type JourFerie } from "@/lib/format";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { displayName, initials } from "@/lib/current-user";

export function AdminOverview() {
  const today = toISODate(new Date());
  const monthStart = new Date(); 
  monthStart.setDate(1);

  // EMPLOYÉS ACTIFS
  const { data: employees = [] } = useQuery({
    queryKey: ["all-profiles"],
    queryFn: async () => {
      const [{ data: profs }, { data: roles }] = await Promise.all([
        supabase
          .from("profiles")
          .select("id,nom,prenom,email,photo_url,poste,actif")
          .eq("actif", true)
          .order("nom"),
        supabase
          .from("user_roles")
          .select("user_id,role")
          .eq("role", "admin"),
      ]);
      const adminIds = new Set((roles ?? []).map((r) => r.user_id));
      return (profs ?? []).filter((p) => !adminIds.has(p.id));
    },
  });

  // POINTAGES DU JOUR
  const { data: pointagesToday = [] } = useQuery({
    queryKey: ["pointages-today", today],
    queryFn: async () => {
      const { data } = await supabase
        .from("pointages")
        .select("user_id,statut,heure_pointage,retard_minutes")
        .eq("date", today);
      return data ?? [];
    },
    refetchInterval: 30000,
  });

  // CONGÉS DU JOUR - Correction des types
  const { data: congesAujourdhui = [] } = useQuery({
    queryKey: ["conges-aujourdhui", today],
    queryFn: async () => {
      // Utiliser .in() ou des conditions séparées pour les différents types
      const { data: conges } = await supabase
        .from("demandes")
        .select("user_id,type")
        .in("type", ["conge_annuel"])
        .eq("statut", "approuve")
        .lte("date_debut", today)
        .gte("date_fin", today);
      
      return conges ?? [];
    },
    refetchInterval: 30000,
  });

  // STATISTIQUES DU MOIS
  const { data: monthStats } = useQuery({
    queryKey: ["month-stats", toISODate(monthStart)],
    queryFn: async () => {
      const { data } = await supabase
        .from("pointages")
        .select("statut")
        .gte("date", toISODate(monthStart));
      const c = { present: 0, retard: 0, absent: 0, absent_justifie: 0, conge: 0 };
      (data || []).forEach((r) => { 
        if (r.statut in c) c[r.statut as keyof typeof c]++; 
      });
      return c;
    },
    refetchInterval: 30000,
  });

  // JOURS FÉRIÉS
  const { data: feries = [] } = useQuery({
    queryKey: ["feries-mois", toISODate(monthStart)],
    queryFn: async () => {
      const finMois = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
      const { data } = await supabase
        .from("jours_feries")
        .select("date,recurrent")
        .lte("date", toISODate(finMois));
      return (data ?? []) as JourFerie[];
    },
  });

  // DEMANDES EN ATTENTE
  const { data: pending = 0 } = useQuery({
    queryKey: ["pending-count"],
    queryFn: async () => {
      const { count } = await supabase
        .from("demandes")
        .select("*", { count: "exact", head: true })
        .eq("statut", "en_attente");
      return count ?? 0;
    },
    refetchInterval: 30000,
  });

  const ptMap = new Map(pointagesToday.map((p) => [p.user_id, p]));
  const congeSet = new Set(congesAujourdhui.map((c) => c.user_id));

  const joursOuvresEcoules = joursOuvresEntre(monthStart, new Date(), feries);
  const denominateur = joursOuvresEcoules * employees.length;
  const tauxAbs = denominateur > 0 
    ? Math.round(((monthStats?.absent ?? 0) / denominateur) * 100) 
    : 0;

  const now = new Date();
  const heureActuelle = now.getHours();
  const estApres9h = heureActuelle >= 9;
  const estApres18h = heureActuelle >= 18;

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl md:text-3xl font-semibold">Tableau de bord, admin</h1>
        <p className="text-muted-foreground">Vue d'ensemble de votre équipe</p>
      </div>

      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <KPI icon={Users} label="Employés actifs" value={employees.length} color="text-primary" />
        <KPI icon={TrendingDown} label="Taux d'absence (mois)" value={`${tauxAbs}%`} color={tauxAbs > 10 ? "text-destructive" : "text-warning"} />
        <KPI icon={AlertCircle} label="Retards ce mois" value={monthStats?.retard ?? 0} color="text-warning" />
        <KPI icon={FileCheck} label="Demandes en attente" value={pending} color="text-info" href="/admin/demandes" />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Présence en temps réel — {formatDateFR(new Date())}</CardTitle>
          <Link to="/admin/calendrier">
            <Button variant="outline" size="sm">Vue calendrier</Button>
          </Link>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2">
            {employees.map((emp) => {
              const p = ptMap.get(emp.id);
              const enConge = congeSet.has(emp.id);
              
              let statusText = "Pas encore";
              let statusClass = "border-warning/40 text-warning";
              let statusIcon = <Clock className="w-3 h-3 mr-1" />;
              
              if (!p && !enConge) {
                if (estApres18h) {
                  statusText = "Absent";
                  statusClass = "border-destructive/40 text-destructive";
                  statusIcon = <UserX className="w-3 h-3 mr-1" />;
                } else if (estApres9h) {
                  statusText = "⚠️ En retard";
                  statusClass = "border-warning/40 text-warning";
                  statusIcon = <Clock className="w-3 h-3 mr-1" />;
                }
              }

              return (
                <div key={emp.id} className="flex items-center justify-between p-3 rounded-md border bg-card hover:bg-muted/30">
                  <div className="flex items-center gap-3">
                    <Avatar className="w-9 h-9">
                      <AvatarImage src={emp.photo_url ?? undefined} />
                      <AvatarFallback>{initials({ nom: emp.nom, prenom: emp.prenom, email: emp.email })}</AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="font-medium">{displayName({ nom: emp.nom, prenom: emp.prenom, email: emp.email })}</div>
                      <div className="text-xs text-muted-foreground">{emp.poste || "—"}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {enConge ? (
                      <Badge variant="outline" className="border-muted-foreground/40 text-muted-foreground">
                        <Palmtree className="w-3 h-3 mr-1" />
                        En congé
                      </Badge>
                    ) : p ? (
                      <>
                        {p.heure_pointage && <span className="text-sm text-muted-foreground tabular-nums">{p.heure_pointage.slice(0, 5)}</span>}
                        {p.retard_minutes ? <span className="text-xs text-warning">+{p.retard_minutes}m</span> : null}
                        <Badge className={STATUT_CLASS[p.statut] + " border"}>
                          {STATUT_LABELS[p.statut]}
                        </Badge>
                      </>
                    ) : (
                      <Badge variant="outline" className={statusClass}>
                        {statusIcon}
                        {statusText}
                      </Badge>
                    )}
                  </div>
                </div>
              );
            })}
            {employees.length === 0 && (
              <div className="text-center text-muted-foreground py-8">
                Aucun employé actif.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function KPI({ icon: Icon, label, value, color, href }: { icon: any; label: string; value: number | string; color: string; href?: string }) {
  const inner = (
    <Card className={href ? "cursor-pointer hover:border-primary/40 transition-colors" : ""}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-2xl font-semibold">{value}</div>
            <div className="text-xs text-muted-foreground mt-1">{label}</div>
          </div>
          <Icon className={"w-5 h-5 " + color} />
        </div>
      </CardContent>
    </Card>
  );
  return href ? <Link to={href}>{inner}</Link> : inner;
}