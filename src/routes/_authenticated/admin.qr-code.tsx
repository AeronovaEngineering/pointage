import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCurrentUser } from "@/lib/current-user";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Printer, MapPin, Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/qr-code")({
  ssr: false,
  beforeLoad: async () => {
    const u = await fetchCurrentUser();
    if (!u || u.role !== "admin") throw new Error("Accès admin requis");
  },
  component: QrCodePage,
});

function QrCodePage() {
  const qc = useQueryClient();
  const scanUrl = typeof window !== "undefined" ? `${window.location.origin}/pointage-scan` : "";
  const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(scanUrl)}`;

  const { data: bureau } = useQuery({
    queryKey: ["parametres-bureau"],
    queryFn: async () => {
      const { data } = await supabase.from("parametres_bureau").select("*").eq("id", 1).maybeSingle();
      return data;
    },
  });

  const [rayon, setRayon] = useState(150);
  const [locating, setLocating] = useState(false);

  const utiliserMaPosition = () => {
    if (!("geolocation" in navigator)) {
      toast.error("La géolocalisation n'est pas disponible sur cet appareil.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { error } = await supabase
          .from("parametres_bureau")
          .update({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, rayon_metres: rayon })
          .eq("id", 1);
        setLocating(false);
        if (error) return toast.error(error.message);
        toast.success("Position du bureau enregistrée");
        qc.invalidateQueries({ queryKey: ["parametres-bureau"] });
      },
      () => {
        setLocating(false);
        toast.error("Position refusée ou indisponible. Autorisez la géolocalisation puis réessayez.");
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const retirerVerification = async () => {
    const { error } = await supabase
      .from("parametres_bureau")
      .update({ latitude: null, longitude: null })
      .eq("id", 1);
    if (error) return toast.error(error.message);
    toast.success("Vérification GPS désactivée");
    qc.invalidateQueries({ queryKey: ["parametres-bureau"] });
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl md:text-3xl font-semibold">QR code de pointage</h1>
        <p className="text-muted-foreground">
          Imprimez ce code et affichez-le à l'entrée du bureau. Chaque employé le scanne depuis
          l'application (bouton "Scanner le QR code d'arrivée") pour enregistrer son arrivée du jour.
        </p>
      </div>

      <Card className="print:shadow-none print:border-none">
        <CardHeader>
          <CardTitle>Pointage d'arrivée</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          {scanUrl && <img src={qrImg} alt="QR code de pointage" className="rounded-md border" />}
          <p className="text-sm text-muted-foreground break-all text-center">{scanUrl}</p>
          <Button onClick={() => window.print()} className="print:hidden">
            <Printer className="w-4 h-4 mr-2" />
            Imprimer
          </Button>
        </CardContent>
      </Card>

      <Card className="print:hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><MapPin className="w-5 h-5" />Vérification de position (anti copier-coller)</CardTitle>
          <CardDescription>
            Sans ça, n'importe qui pourrait recopier le lien du QR code et pointer à distance. Avec la
            position du bureau enregistrée, l'arrivée n'est acceptée que si l'employé est physiquement à
            proximité (même s'il a le lien).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {bureau?.latitude != null ? (
            <div className="text-sm text-muted-foreground">
              Position enregistrée : <b>{bureau.latitude.toFixed(5)}, {bureau.longitude?.toFixed(5)}</b> — rayon autorisé : <b>{bureau.rayon_metres} m</b>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">Aucune position enregistrée : la vérification GPS est désactivée pour l'instant.</div>
          )}

          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1">
              <Label>Rayon autorisé (mètres)</Label>
              <Input type="number" className="w-32" value={rayon} onChange={(e) => setRayon(Number(e.target.value))} />
            </div>
            <Button onClick={utiliserMaPosition} disabled={locating}>
              {locating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <MapPin className="w-4 h-4 mr-2" />}
              Utiliser ma position actuelle (être au bureau)
            </Button>
            {bureau?.latitude != null && (
              <Button variant="outline" onClick={retirerVerification}>Désactiver la vérification GPS</Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
