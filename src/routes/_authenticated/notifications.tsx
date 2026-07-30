import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentUser } from "@/lib/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bell, Check, User, Gift } from "lucide-react"; // CHANGEMENT: Ajout de User et Gift
import { formatDateFR } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/notifications")({
  component: NotifPage,
});

function NotifPage() {
  const qc = useQueryClient();

  // FIX: l'ancien code interrogeait une table "users" qui n'existe pas dans le schéma
  // (le rôle vit dans "user_roles", cf. src/lib/current-user.ts) et essayait de filtrer
  // sur des colonnes ("destinataire_id") absentes de la table réelle "notifications"
  // (qui n'a que : user_id, titre, message, lien, lue, created_at). Résultat : la requête
  // échouait silencieusement et l'admin retombait sur le mauvais filtre / affichage.
  // On utilise fetchCurrentUser() (fiable) et on filtre toujours par user_id, ce qui est
  // correct pour l'admin comme pour l'employé (le trigger DB insère une notif par admin).
  const { data: currentUser } = useQuery({
    queryKey: ["current-user"],
    queryFn: fetchCurrentUser,
  });

  const { data: notifs = [] } = useQuery({
    queryKey: ["notifications-all", currentUser?.id],
    queryFn: async () => {
      if (!currentUser) return [];
      const { data } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", currentUser.id)
        .order("created_at", { ascending: false })
        .limit(100);
      return data ?? [];
    },
    enabled: !!currentUser,
  });

  const marquerLu = async (id: string) => {
    await supabase.from("notifications").update({ lue: true }).eq("id", id);
    qc.invalidateQueries({ queryKey: ["notifications-all"] });
    qc.invalidateQueries({ queryKey: ["notif-count"] });
  };

  const toutMarquer = async () => {
    if (!currentUser) return;
    await supabase.from("notifications").update({ lue: true }).eq("user_id", currentUser.id).eq("lue", false);
    qc.invalidateQueries({ queryKey: ["notifications-all"] });
    qc.invalidateQueries({ queryKey: ["notif-count"] });
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl md:text-3xl font-semibold">Notifications</h1>
        <Button variant="outline" onClick={toutMarquer}><Check className="w-4 h-4 mr-2" />Tout marquer lu</Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {notifs.length === 0 ? (
            <div className="text-center text-muted-foreground py-12"><Bell className="w-8 h-8 mx-auto mb-2 opacity-30" />Aucune notification</div>
          ) : (
            <div className="divide-y">
              {notifs.map((n) => (
                <div key={n.id} className={"p-4 flex items-start gap-3 " + (n.lue ? "" : "bg-primary/5")}>
                  <div className={"w-2 h-2 rounded-full mt-2 " + (n.lue ? "bg-transparent" : "bg-primary")} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium flex items-center gap-2">
                      {/* CHANGEMENT #14: Icône pour les notifications de prime */}
                      {n.type === "prime" && <Gift className="w-4 h-4 text-green-500" />}
                      {n.type === "demande" && <User className="w-4 h-4 text-blue-500" />}
                      {n.titre}
                    </div>
                    <div className="text-sm text-muted-foreground">{n.message}</div>
                    <div className="text-xs text-muted-foreground mt-1">{formatDateFR(n.created_at)}</div>
                  </div>
                  {!n.lue && <Button size="sm" variant="ghost" onClick={() => marquerLu(n.id)}>Marquer lu</Button>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}