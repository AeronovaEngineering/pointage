import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clock, CheckCircle2, XCircle, Loader2, MapPin } from "lucide-react";
import { pointerArriveeAvecPosition } from "@/lib/pointage-arrivee";

export const Route = createFileRoute("/_authenticated/pointage-scan")({
  ssr: false,
  component: PointageScanPage,
});

type Status = "idle" | "loading" | "success" | "already" | "error";

function PointageScanPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [heure, setHeure] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");

  const confirmer = async () => {
    setStatus("loading");
    const result = await pointerArriveeAvecPosition();
    if (result.status === "success") {
      setStatus("success");
      setHeure(result.heure);
    } else if (result.status === "already") {
      setStatus("already");
    } else if (result.status === "location_denied") {
      setStatus("error");
      setMessage("Autorisez l'accès à votre position pour pointer votre arrivée depuis le bureau.");
    } else {
      setStatus("error");
      setMessage(result.status === "error" ? result.message : "Erreur lors du pointage.");
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[70vh]">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <CardTitle className="flex items-center justify-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            Pointage d'arrivée
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === "idle" && (
            <div className="flex flex-col items-center gap-3 py-4">
              <MapPin className="w-8 h-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Confirmez votre arrivée. Votre position sera vérifiée pour s'assurer que vous êtes bien au bureau.
              </p>
              <Button className="w-full" onClick={confirmer}>Confirmer mon arrivée</Button>
            </div>
          )}

          {status === "loading" && (
            <div className="flex flex-col items-center gap-3 py-6 text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin" />
              <p>Vérification de votre position…</p>
            </div>
          )}

          {status === "success" && (
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="w-10 h-10 text-success" />
              <p className="font-medium">Arrivée pointée{heure ? ` à ${heure}` : ""} !</p>
              <p className="text-sm text-muted-foreground">Bonne journée 👋</p>
            </div>
          )}

          {status === "already" && (
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="w-10 h-10 text-success" />
              <p className="font-medium">Vous avez déjà pointé votre arrivée aujourd'hui.</p>
            </div>
          )}

          {status === "error" && (
            <div className="flex flex-col items-center gap-3 py-6">
              <XCircle className="w-10 h-10 text-destructive" />
              <p className="font-medium text-destructive">{message}</p>
              <Button variant="outline" className="w-full" onClick={confirmer}>Réessayer</Button>
            </div>
          )}

          <Button asChild variant="ghost" className="w-full">
            <Link to="/dashboard">Aller au tableau de bord</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
