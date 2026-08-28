import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentUser } from "@/lib/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, CheckCircle2, AlertCircle, Calendar as CalIcon, XCircle, Gift } from "lucide-react";
import { toISODate, formatMontant } from "@/lib/format";
import { EmployeeCalendar } from "@/components/EmployeeCalendar";
import { AdminOverview } from "@/components/AdminOverview";
import { PointageActions } from "@/components/PointageActions";
import { useEffect } from "react";
import { toast } from "sonner";
export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  const { data: user } = useQuery({ queryKey: ["current-user"], queryFn: fetchCurrentUser });
  if (!user) return null;
  return user.role === "admin" ? <AdminOverview /> : <EmployeeDashboard userId={user.id} />;
}

function EmployeeDashboard({ userId }: { userId: string }) {
  const today = toISODate(new Date());

  const { data: profile } = useQuery({
    queryKey: ["profile-prenom", userId],
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("prenom,nom,photo_url")
        .eq("id", userId)
        .single();
      return data;
    },
  });

  const { data: solde } = useQuery({
    queryKey: ["solde", userId],
    queryFn: async () => {
      const { data } = await supabase.from("solde_conges").select("solde_actuel").eq("user_id", userId).maybeSingle();
      return data?.solde_actuel ?? 0;
    },
  });

  const { data: stats } = useQuery({
    queryKey: ["employee-stats", userId],
    queryFn: async () => {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const startStr = toISODate(start);
      const endStr = toISODate(end);
      const today = new Date();

      // Fetch all data needed
      const [pointagesResult, congesResult, feriesResult] = await Promise.all([
        supabase
          .from("pointages")
          .select("date,statut,retard_minutes")
          .eq("user_id", userId)
          .gte("date", startStr)
          .lte("date", endStr),
        supabase
          .from("demandes")
          .select("date_debut,date_fin")
          .eq("user_id", userId)
          .eq("type", "conge_annuel")
          .eq("statut", "approuve")
          .or(`date_debut.lte.${endStr},date_fin.gte.${startStr}`),
        supabase
          .from("jours_feries")
          .select("date,recurrent")
          .or(`date.gte.${startStr},date.lte.${endStr}`)
      ]);

      const pointages = pointagesResult.data ?? [];
      const conges = congesResult.data ?? [];
      const feries = feriesResult.data ?? [];

      // Build map of pointages by date
      const pointagesByDate = new Map();
      pointages.forEach((p: any) => {
        pointagesByDate.set(p.date, p);
      });

      // Build set of dates covered by approved congé
      const congeDates = new Set();
      conges.forEach((c: any) => {
        const debut = new Date(c.date_debut);
        const fin = new Date(c.date_fin);
        const current = new Date(debut);
        while (current <= fin) {
          const dateStr = toISODate(current);
          congeDates.add(dateStr);
          current.setDate(current.getDate() + 1);
        }
      });

      // Build set of holiday dates for the month
      const ferieDates = new Set();
      feries.forEach((f: any) => {
        const dateStr = f.date;
        ferieDates.add(dateStr);
      });

      // Initialize counters
      const counts = { 
        present: 0, 
        retard: 0, 
        absent: 0, 
        absent_justifie: 0, 
        conge: 0 
      };

      // Iterate over all days in the month
      const current = new Date(start);
      while (current <= end) {
        const dateStr = toISODate(current);
        const dayOfWeek = current.getDay();

        // Skip weekends
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
          // Check if it's a holiday
          if (ferieDates.has(dateStr)) {
            // Holidays are skipped entirely (not counted in any stat)
            current.setDate(current.getDate() + 1);
            continue;
          }

          // Skip future days
          if (current > today) {
            current.setDate(current.getDate() + 1);
            continue;
          }

          const pointage = pointagesByDate.get(dateStr);
          
          if (pointage) {
            // Use actual pointage data
            const statut = pointage.statut;
            counts[statut as keyof typeof counts] = ((counts[statut as keyof typeof counts] as number) || 0) + 1;
          } else if (congeDates.has(dateStr)) {
            // Day is covered by approved congé
            counts.conge += 1;
          } else {
            // Working day with no pointage and no congé = absent
            counts.absent += 1;
          }
        }

        current.setDate(current.getDate() + 1);
      }

      return counts;
    },
  });

  useEffect(() => {
      if (!userId) return;
      (async () => {
        const { data: unread } = await supabase
          .from("notifications")
          .select("id,message")
          .eq("user_id", userId)
          .eq("lue", false)
          .ilike("titre", "%prime%");
        if (unread && unread.length > 0) {
          unread.forEach((n) => toast.success(n.message));
          await supabase.from("notifications").update({ lue: true }).in("id", unread.map((n) => n.id));
        }
      })();
    }, [userId]);

  // Marquer les notifications comme lues (utilise la table notifications existante)
  const markPrimesAsRead = async () => {
    try {
      // Get unread prime notifications
      const { data: notifications } = await supabase
        .from('notifications')
        .select('id')
        .eq('user_id', userId)
        .eq('lue', false)
        .ilike('titre', '%prime%');
      
      if (notifications && notifications.length > 0) {
        const ids = notifications.map((n: any) => n.id);
        await supabase
          .from('notifications')
          .update({ lue: true })
          .in('id', ids);
      }
    } catch (error) {
      console.error("Erreur lors du marquage des notifications:", error);
    }
  };


  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl md:text-3xl font-semibold">
          Tableau de bord, {profile?.prenom || "..."}
        </h1>
        <p className="text-muted-foreground">
          {new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2 border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Clock className="w-5 h-5 text-primary" />Pointage du jour ({today})</CardTitle>
          </CardHeader>
          <CardContent>
            <PointageActions userId={userId} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Solde de congés</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-semibold text-primary">{Number(solde ?? 0).toFixed(2)}</div>
            <div className="text-sm text-muted-foreground mt-1">jours disponibles</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 grid-cols-2 md:grid-cols-5">
        <StatCard label="Présents" value={stats?.present ?? 0} icon={CheckCircle2} color="text-success" />
        <StatCard label="Retards" value={stats?.retard ?? 0} icon={AlertCircle} color="text-warning" />
        <StatCard label="Absents" value={stats?.absent ?? 0} icon={XCircle} color="text-destructive" />
        <StatCard label="Justifiés" value={stats?.absent_justifie ?? 0} icon={CheckCircle2} color="text-info" />
        <StatCard label="Congés" value={stats?.conge ?? 0} icon={CalIcon} color="text-muted-foreground" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CalIcon className="w-5 h-5" />Mon calendrier</CardTitle>
        </CardHeader>
        <CardContent>
          <EmployeeCalendar userId={userId} />
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color }: { label: string; value: number; icon: any; color: string }) {
  return (
    <Card>
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
}