import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchCurrentUser } from "@/lib/current-user";
import { fetchFichesPaie, moisLabel } from "@/lib/fiche-paie";
import { downloadFichePaiePDF } from "@/lib/fiche-paie-pdf";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, FileText, Wallet } from "lucide-react";

export const Route = createFileRoute("/_authenticated/mes-fiches-paie")({
  component: MesFichesPaie,
});

function MesFichesPaie() {
  const { data: user } = useQuery({ queryKey: ["current-user"], queryFn: fetchCurrentUser });

  const { data: fiches = [], isLoading } = useQuery({
    queryKey: ["mes-fiches-paie", user?.id],
    enabled: !!user,
    queryFn: () => fetchFichesPaie(user!.id),
  });

  if (!user) return null;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl md:text-3xl font-semibold">Mes fiches de paie</h1>
        <p className="text-muted-foreground">Historique de vos bulletins de paie validés</p>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Chargement…</p>
      ) : fiches.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
            Aucune fiche de paie disponible pour le moment.
            <br />
            Elle apparaîtra ici dès que votre administrateur l'aura validée.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {fiches.map((f) => (
            <Card key={f.id}>
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Wallet className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <div className="font-medium">{moisLabel(f.mois)}</div>
                    <div className="text-sm text-muted-foreground">Net : {f.net_a_payer.toFixed(2)} DT</div>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    downloadFichePaiePDF(f, {
                      nom: user.nom,
                      prenom: user.prenom,
                      poste: user.poste,
                      departement: user.departement,
                      cni: user.cni,
                      num_secu: user.num_secu,
                      date_embauche: user.date_embauche,
                      type_contrat: user.type_contrat,
                      situation_familiale: (user as any).situation_familiale,
                      nombre_enfants: (user as any).nombre_enfants,
                      mode_paiement: f.mode_paiement,
                    })
                  }
                >
                  <Download className="w-4 h-4 mr-2" />
                  PDF
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}