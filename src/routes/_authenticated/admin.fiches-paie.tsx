import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { displayName } from "@/lib/current-user";
import { formatMinutesEnHeures } from "@/lib/format";
import {
  FichePaie,
  FichePaieDetailLine,
  computeNet,
  devaliderFichePaie,
  fetchFichePaie,
  genererFichePaie,
  moisISO,
  moisLabel,
  updateFichePaie,
  validerFichePaie,
} from "@/lib/fiche-paie";
import { downloadFichePaiePDF } from "@/lib/fiche-paie-pdf";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Download, Lock, LockOpen, Plus, RefreshCw, Trash2, Wallet } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/fiches-paie")({
  component: AdminFichesPaie,
});

const now = new Date();
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
  return { value: moisISO(d.getFullYear(), d.getMonth()), label: moisLabel(moisISO(d.getFullYear(), d.getMonth())) };
});

function AdminFichesPaie() {
  const qc = useQueryClient();
  const [employeeId, setEmployeeId] = useState<string>("");
  const [mois, setMois] = useState<string>(MONTH_OPTIONS[0].value);
  const [saving, setSaving] = useState(false);

  const { data: employees = [] } = useQuery({
    queryKey: ["employees-list"],
    queryFn: async () => {
      const [{ data: profiles }, { data: roles }] = await Promise.all([
        supabase.from("profiles").select("id,nom,prenom,poste,departement,cni,num_secu,date_embauche,actif").order("nom"),
        supabase.from("user_roles").select("user_id,role"),
      ]);
      const adminIds = new Set((roles ?? []).filter((r) => r.role === "admin").map((r) => r.user_id));
      return (profiles ?? []).filter((p) => !adminIds.has(p.id));
    },
  });

  const employee = employees.find((e) => e.id === employeeId);

  const { data: fiche, isLoading } = useQuery({
    queryKey: ["fiche-paie", employeeId, mois],
    enabled: !!employeeId && !!mois,
    queryFn: () => fetchFichePaie(employeeId, mois),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["fiche-paie", employeeId, mois] });

  const generer = async () => {
    setSaving(true);
    try {
      await genererFichePaie(employeeId, mois);
      toast.success("Brouillon généré à partir du pointage");
      refresh();
    } catch (e: any) {
      toast.error(e.message ?? "Erreur lors de la génération");
    } finally {
      setSaving(false);
    }
  };

  const valider = async () => {
    if (!fiche) return;
    setSaving(true);
    try {
      await validerFichePaie(fiche.id);
      toast.success("Fiche de paie validée — l'employé peut la télécharger");
      refresh();
    } catch (e: any) {
      toast.error(e.message ?? "Erreur lors de la validation");
    } finally {
      setSaving(false);
    }
  };

  const devalider = async () => {
    if (!fiche) return;
    setSaving(true);
    try {
      await devaliderFichePaie(fiche.id);
      toast.success("Fiche rouverte en brouillon");
      refresh();
    } catch (e: any) {
      toast.error(e.message ?? "Erreur");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl md:text-3xl font-semibold">Fiches de paie</h1>
        <p className="text-muted-foreground">Générer, vérifier et valider les bulletins de paie mensuels</p>
      </div>

      <Card>
        <CardContent className="pt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>Employé</Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger><SelectValue placeholder="Choisir un employé" /></SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={e.id}>{displayName(e)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Mois</Label>
            <Select value={mois} onValueChange={setMois}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTH_OPTIONS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {!employeeId ? (
        <p className="text-muted-foreground text-sm">Choisissez un employé et un mois pour commencer.</p>
      ) : isLoading ? (
        <p className="text-muted-foreground text-sm">Chargement…</p>
      ) : !fiche ? (
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <p className="text-muted-foreground">
              Aucune fiche pour {moisLabel(mois)}, même pour un mois passé — elle peut être générée maintenant à partir du pointage enregistré.
            </p>
            <Button onClick={generer} disabled={saving}>
              <Plus className="w-4 h-4 mr-2" />
              Générer le brouillon
            </Button>
          </CardContent>
        </Card>
      ) : (
        <FicheEditor
          fiche={fiche}
          employeeName={employee ? displayName(employee) : ""}
          saving={saving}
          onRegenerate={generer}
          onValider={valider}
          onDevalider={devalider}
          onSaved={refresh}
          onDownload={() => employee && downloadFichePaiePDF(fiche, employee)}
        />
      )}
    </div>
  );
}

function FicheEditor({
  fiche,
  employeeName,
  saving,
  onRegenerate,
  onValider,
  onDevalider,
  onSaved,
  onDownload,
}: {
  fiche: FichePaie;
  employeeName: string;
  saving: boolean;
  onRegenerate: () => void;
  onValider: () => void;
  onDevalider: () => void;
  onSaved: () => void;
  onDownload: () => void;
}) {
  const [details, setDetails] = useState<FichePaieDetailLine[]>(fiche.details);
  const [commentaire, setCommentaire] = useState(fiche.commentaire_admin ?? "");
  const [dirty, setDirty] = useState(false);
  const readOnly = fiche.statut === "validee";

  // Reset local edit state whenever a different fiche is loaded
  useMemo(() => {
    setDetails(fiche.details);
    setCommentaire(fiche.commentaire_admin ?? "");
    setDirty(false);
  }, [fiche.id, fiche.updated_at]);

  const net = computeNet(details);

  const updateLine = (i: number, patch: Partial<FichePaieDetailLine>) => {
    setDetails((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
    setDirty(true);
  };

  const removeLine = (i: number) => {
    setDetails((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
  };

  const addLine = () => {
    setDetails((prev) => [...prev, { label: "", montant: 0, type: "gain" }]);
    setDirty(true);
  };

  const save = async () => {
    try {
      await updateFichePaie(fiche.id, { details, commentaire_admin: commentaire || null, net_a_payer: net });
      toast.success("Modifications enregistrées");
      setDirty(false);
      onSaved();
    } catch (e: any) {
      toast.error(e.message ?? "Erreur lors de l'enregistrement");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>{moisLabel(fiche.mois)}</CardTitle>
          <p className="text-sm text-muted-foreground">{employeeName}</p>
        </div>
        <Badge variant={fiche.statut === "validee" ? "default" : "outline"}>
          {fiche.statut === "validee" ? "Validée" : "Brouillon"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center text-sm">
          <Stat label="Travaillés" value={String(fiche.jours_travailles)} />
          <Stat label="Absences" value={String(fiche.jours_absence)} />
          <Stat label="Congés" value={String(fiche.jours_conge)} />
          <Stat label="Retard" value={formatMinutesEnHeures(fiche.retard_minutes)} />
          <Stat label="H. sup." value={`${fiche.heures_supplementaires.toFixed(1)}h`} />
        </div>

        <Separator />

        <div className="space-y-2">
          {details.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                className="flex-1"
                value={d.label}
                disabled={readOnly}
                placeholder="Libellé"
                onChange={(e) => updateLine(i, { label: e.target.value })}
              />
              <Select value={d.type} disabled={readOnly} onValueChange={(v) => updateLine(i, { type: v as "gain" | "deduction" })}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="gain">Gain</SelectItem>
                  <SelectItem value="deduction">Déduction</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="number"
                step="0.01"
                className="w-28"
                disabled={readOnly}
                value={Math.abs(d.montant)}
                onChange={(e) => {
                  const v = Number(e.target.value) || 0;
                  updateLine(i, { montant: d.type === "deduction" ? -Math.abs(v) : Math.abs(v) });
                }}
              />
              {!readOnly && (
                <Button variant="ghost" size="icon" onClick={() => removeLine(i)}>
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              )}
            </div>
          ))}
          {!readOnly && (
            <Button variant="outline" size="sm" onClick={addLine}>
              <Plus className="w-4 h-4 mr-2" />
              Ajouter une ligne
            </Button>
          )}
        </div>

        <div className="space-y-1">
          <Label>Note (visible par l'employé)</Label>
          <Textarea
            value={commentaire}
            disabled={readOnly}
            onChange={(e) => { setCommentaire(e.target.value); setDirty(true); }}
            placeholder="Optionnel"
          />
        </div>

        <div className="flex justify-between items-center bg-primary/5 rounded-lg px-4 py-3">
          <span className="font-semibold flex items-center gap-2"><Wallet className="w-4 h-4" />Net à payer</span>
          <span className="text-xl font-bold text-primary">{net.toFixed(2)} DT</span>
        </div>

        <div className="flex flex-wrap gap-2 justify-end">
          <Button variant="outline" onClick={onDownload}>
            <Download className="w-4 h-4 mr-2" />
            PDF
          </Button>

          {!readOnly && (
            <>
              <Button variant="outline" onClick={onRegenerate} disabled={saving}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Régénérer depuis le pointage
              </Button>
              <Button variant="outline" onClick={save} disabled={!dirty}>
                Enregistrer
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button disabled={saving}>
                    <Lock className="w-4 h-4 mr-2" />
                    Valider
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Valider cette fiche de paie ?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Une fois validée, elle apparaîtra dans l'historique de l'employé et pourra être téléchargée. Enregistrez vos modifications avant de valider si nécessaire.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Annuler</AlertDialogCancel>
                    <AlertDialogAction onClick={async () => { if (dirty) await save(); onValider(); }}>Valider</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}

          {readOnly && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={saving}>
                  <LockOpen className="w-4 h-4 mr-2" />
                  Dévalider
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Rouvrir cette fiche ?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Elle redeviendra un brouillon et disparaîtra temporairement de l'historique de l'employé, le temps de la corriger.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Annuler</AlertDialogCancel>
                  <AlertDialogAction onClick={onDevalider}>Dévalider</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted rounded-lg py-2 px-1">
      <div className="font-semibold">{value}</div>
      <div className="text-[11px] text-muted-foreground leading-tight">{label}</div>
    </div>
  );
}