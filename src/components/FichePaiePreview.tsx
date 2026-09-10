import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { FichePaie, moisLabel } from "@/lib/fiche-paie";
import { formatDateFR, formatMinutesEnHeures } from "@/lib/format";

interface Props {
  fiche: FichePaie;
  employeeName: string;
  poste?: string | null;
  departement?: string | null;
}

export function FichePaiePreview({ fiche, employeeName, poste, departement }: Props) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-xl">{moisLabel(fiche.mois)}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {employeeName}
            {poste ? ` • ${poste}` : ""}
            {departement ? ` • ${departement}` : ""}
          </p>
        </div>
        <Badge variant={fiche.statut === "validee" ? "default" : "outline"}>
          {fiche.statut === "validee" ? "Validée" : "Brouillon"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center">
          <StatBox label="Jours travaillés" value={String(fiche.jours_travailles)} />
          <StatBox label="Absences" value={String(fiche.jours_absence)} />
          <StatBox label="Congés" value={String(fiche.jours_conge)} />
          <StatBox label="Retards" value={formatMinutesEnHeures(fiche.retard_minutes)} />
          <StatBox label="Heures sup." value={`${fiche.heures_supplementaires.toFixed(1)}h`} />
        </div>

        <Separator />

        <div className="space-y-2">
          {fiche.details.map((d, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{d.label}</span>
              <span className={`font-medium ${d.montant < 0 ? "text-destructive" : ""}`}>
                {d.montant < 0 ? "-" : ""}
                {Math.abs(d.montant).toFixed(2)} DT
              </span>
            </div>
          ))}
        </div>

        <Separator />

        <div className="flex justify-between items-center bg-primary/5 rounded-lg px-4 py-3">
          <span className="font-semibold">Net à payer</span>
          <span className="text-xl font-bold text-primary">{fiche.net_a_payer.toFixed(2)} DT</span>
        </div>

        {fiche.commentaire_admin && (
          <p className="text-sm text-muted-foreground italic">Note : {fiche.commentaire_admin}</p>
        )}

        {fiche.statut === "validee" && fiche.valide_at && (
          <p className="text-xs text-muted-foreground text-right">Validée le {formatDateFR(fiche.valide_at)}</p>
        )}
      </CardContent>
    </Card>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted rounded-lg py-2 px-1">
      <div className="text-sm font-semibold">{value}</div>
      <div className="text-[11px] text-muted-foreground leading-tight">{label}</div>
    </div>
  );
}