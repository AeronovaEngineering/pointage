import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Clock, Coffee, Play, LogOut, CheckCircle2, Palmtree, MapPin } from "lucide-react";
import { QrScannerButton } from "@/components/QrScannerButton";
import { STATUT_LABELS, STATUT_CLASS, formatTimeFR, toISODate, formatMinutesEnHeures } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getPosition } from "@/lib/pointage-arrivee";

type Action = "arrivee" | "pause_debut" | "pause_fin" | "sortie";

export function PointageActions({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const today = toISODate(new Date());
  const [taches, setTaches] = useState("");
  const [loading, setLoading] = useState<Action | null>(null);

  const { data: p } = useQuery({
    queryKey: ["pointage-today", userId, today],
    queryFn: async () => {
      const { data } = await supabase.from("pointages").select("*").eq("user_id", userId).eq("date", today).maybeSingle();
      return data;
    },
  });

  const { data: congeAujourdhui } = useQuery({
    queryKey: ["conge-aujourdhui", userId, today],
    queryFn: async () => {
      const { data } = await supabase
        .from("demandes")
        .select("id")
        .eq("user_id", userId)
        .eq("type", "conge_annuel")
        .eq("statut", "approuve")
        .lte("date_debut", today)
        .gte("date_fin", today)
        .maybeSingle();
      return !!data;
    },
  });

  // Vérifier si la géolocalisation est configurée
  const checkGeolocationEnabled = async () => {
    const { data } = await supabase
      .from("parametres_bureau")
      .select("latitude, longitude")
      .single();
    return data?.latitude !== null && data?.longitude !== null;
  };

  const doAction = async (action: Action) => {
    if (action === "sortie" && !taches.trim()) {
      toast.error("Merci de saisir vos tâches réalisées avant de terminer la journée");
      return;
    }
    setLoading(action);

    let lat: number | undefined = undefined;
    let lng: number | undefined = undefined;
    
    // GPS verification for pause_fin and sortie
    if (action === "pause_fin" || action === "sortie") {
      const gpsEnabled = await checkGeolocationEnabled();
      if (gpsEnabled) {
        const pos = await getPosition();
        if (!pos) {
          toast.error("Impossible d'obtenir votre position. Vérifiez les autorisations GPS.");
          setLoading(null);
          return;
        }
        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
      } else {
        // GPS not configured, proceed without location
        toast.info("La vérification GPS n'est pas configurée par l'administrateur.");
      }
    }

    const { error } = await supabase.rpc("pointer_action", {
      _action: action,
      _lat: lat,
      _lng: lng,
      _taches: action === "sortie" ? taches : undefined,
    });
    setLoading(null);
    
    if (error) {
      // Handle specific location errors with custom messages
      if (error.message.includes("Localisation requise")) {
        toast.error(error.message);
        return;
      }
      if (error.message.includes("devez être au bureau")) {
        toast.error("📍 " + error.message);
        return;
      }
      return toast.error(error.message);
    }
    
    const msgs: Record<Action, string> = {
      arrivee: "Arrivée pointée",
      pause_debut: "Début de pause enregistré",
      pause_fin: "Reprise du travail enregistrée",
      sortie: "Fin de journée enregistrée. Bonne soirée !",
    };
    
    toast.success(msgs[action]);
    if (action === "sortie") setTaches("");
    qc.invalidateQueries({ queryKey: ["pointage-today", userId] });
    qc.invalidateQueries({ queryKey: ["pointages-month"] });
    qc.invalidateQueries({ queryKey: ["employee-stats", userId] });
  };

  if (congeAujourdhui) {
    return (
      <div className="flex items-center gap-3 p-4 rounded-md border border-muted-foreground/30 bg-muted/30 text-muted-foreground">
        <Palmtree className="w-5 h-5 shrink-0" />
        <div>
          <div className="font-medium text-foreground">Vous êtes en congé aujourd'hui</div>
          <div className="text-sm">Le pointage est désactivé pendant votre congé.</div>
        </div>
      </div>
    );
  }

  const hasArrivee = !!p?.heure_pointage;
  const hasPauseDebut = !!p?.heure_debut_pause;
  const hasPauseFin = !!p?.heure_fin_pause;
  const hasSortie = !!p?.heure_sortie;

  return (
    <div className="space-y-4">
      {p && (
        <div className="flex items-center gap-3 flex-wrap">
          <CheckCircle2 className="w-6 h-6 text-success" />
          <Badge className={cn(STATUT_CLASS[p.statut], "border")}>{STATUT_LABELS[p.statut]}</Badge>
          {formatMinutesEnHeures(p.retard_minutes) !== "0 min" ? <span className="text-sm text-muted-foreground">+{formatMinutesEnHeures(p.retard_minutes)}</span> : null}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <TimeBlock label="Arrivée" time={p?.heure_pointage} icon={Clock} />
        <TimeBlock label="Début pause" time={p?.heure_debut_pause} icon={Coffee} />
        <TimeBlock label="Fin pause" time={p?.heure_fin_pause} icon={Play} />
        <TimeBlock label="Sortie" time={p?.heure_sortie} icon={LogOut} />
      </div>

      {!hasArrivee && (
        <div className="flex gap-2">
          <div className="basis-2/3">
            <QrScannerButton onArrivee={() => qc.invalidateQueries({ queryKey: ["pointage-today", userId, today] })} />
          </div>
          <Button
            variant="outline"
            className="basis-1/3"
            onClick={() => navigate({ to: "/pointage-scan" })}
          >
            <MapPin className="w-4 h-4 mr-2" />
            Pointer
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" disabled={!hasArrivee || hasPauseDebut || hasSortie || loading !== null} onClick={() => doAction("pause_debut")}>
          <Coffee className="w-4 h-4 mr-2" />Début pause
        </Button>
        <Button variant="outline" disabled={!hasPauseDebut || hasPauseFin || hasSortie || loading !== null} onClick={() => doAction("pause_fin")}>
          <Play className="w-4 h-4 mr-2" />Fin pause
        </Button>
        <Button
          variant="secondary"
          className="col-span-2"
          disabled={!hasArrivee || hasSortie || !taches.trim() || loading !== null}
          onClick={() => doAction("sortie")}
        >
          <LogOut className="w-4 h-4 mr-2" />Fin de journée
        </Button>
      </div>

      {hasArrivee && !hasSortie && (
        <div className="space-y-2 pt-2 border-t">
          <Label>Tâches réalisées aujourd'hui <span className="text-destructive">*</span> (requis pour terminer la journée)</Label>
          <Textarea
            placeholder="Ex: développement de la page profil, corrections de bugs sur le module de pointage, réunion avec l'équipe design…"
            value={taches}
            onChange={(e) => setTaches(e.target.value)}
            rows={4}
          />
        </div>
      )}

      {hasSortie && p?.taches_realisees && (
        <div className="p-3 rounded bg-muted/50 text-sm">
          <div className="font-medium mb-1">Tâches réalisées :</div>
          <p className="text-muted-foreground whitespace-pre-wrap">{p.taches_realisees}</p>
        </div>
      )}
    </div>
  );
}

function TimeBlock({ label, time, icon: Icon }: { label: string; time: string | null | undefined; icon: any }) {
  return (
    <div className={cn("p-3 rounded-md border flex items-center gap-2", time ? "bg-success/10 border-success/30" : "bg-muted/30")}>
      <Icon className={cn("w-4 h-4", time ? "text-success" : "text-muted-foreground")} />
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="font-semibold text-sm">{formatTimeFR(time ?? null)}</div>
      </div>
    </div>
  );
}