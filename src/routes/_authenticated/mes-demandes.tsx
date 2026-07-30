import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentUser } from "@/lib/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { DEMANDE_TYPE_LABELS, DEMANDE_STATUT_LABELS, formatDateFR } from "@/lib/format";
import { Plus, Upload, FileCheck, XCircle, Clock } from "lucide-react";

export const Route = createFileRoute("/_authenticated/mes-demandes")({
  component: MesDemandes,
});

function MesDemandes() {
  const qc = useQueryClient();
  const { data: user } = useQuery({ queryKey: ["current-user"], queryFn: fetchCurrentUser });

  const { data: demandes = [] } = useQuery({
    queryKey: ["mes-demandes", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from("demandes").select("*").eq("user_id", user!.id).order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const { data: justifs = [] } = useQuery({
    queryKey: ["mes-justifs", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from("justificatifs_maladie").select("*").eq("user_id", user!.id).order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const supprimer = async (id: string) => {
    if (!confirm("Supprimer cette demande ?")) return;
    const { error } = await supabase.from("demandes").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Supprimée");
    qc.invalidateQueries({ queryKey: ["mes-demandes"] });
  };

  if (!user) return null;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold">Mes demandes</h1>
          <p className="text-muted-foreground">Congés, sorties et justificatifs</p>
        </div>
        <div className="flex gap-2">
          <NouvelleDemandeDialog userId={user.id} onDone={() => qc.invalidateQueries({ queryKey: ["mes-demandes"] })} />
          <NouveauJustifDialog userId={user.id} onDone={() => qc.invalidateQueries({ queryKey: ["mes-justifs"] })} />
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Congés, sorties et absences</CardTitle></CardHeader>
        <CardContent>
          {demandes.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">Aucune demande.</p>
          ) : (
            <div className="space-y-2">
              {demandes.map((d) => (
                <div key={d.id} className="p-4 rounded-md border flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{DEMANDE_TYPE_LABELS[d.type]}</span>
                      <StatusBadge s={d.statut} />
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">
                      {formatDateFR(d.date_debut)}{d.date_debut !== d.date_fin ? ` → ${formatDateFR(d.date_fin)}` : ""}
                      {d.heure_sortie ? ` — sortie à ${d.heure_sortie.slice(0, 5)}` : ""}
                      {/* CHANGEMENT #1: Affichage de l'heure de retour */}
                      {d.heure_retour ? ` — retour à ${d.heure_retour.slice(0, 5)}` : ""}
                      {/* CHANGEMENT #2: Affichage du montant pour les avances */}
                      {d.montant ? ` — ${d.montant}  ` : ""}
                    </div>
                    {d.motif && <div className="text-sm mt-1">{d.motif}</div>}
                    {d.commentaire_admin && <div className="text-sm text-muted-foreground italic mt-1">Réponse admin : {d.commentaire_admin}</div>}
                  </div>
                  {d.statut === "en_attente" && (
                    <Button variant="ghost" size="sm" onClick={() => supprimer(d.id)}>Annuler</Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Justificatifs maladie</CardTitle></CardHeader>
        <CardContent>
          {justifs.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">Aucun justificatif.</p>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {justifs.map((j) => (
                <div key={j.id} className="p-4 rounded-md border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium">{formatDateFR(j.date_concernee)}</span>
                    <StatusBadge s={j.statut} />
                  </div>
                  {/* CHANGEMENT #3: Affichage du motif (obligatoire) */}
                  {j.motif && <div className="text-sm mt-1">{j.motif}</div>}
                  {/* CHANGEMENT #3: Image optionnelle - affichage conditionnel */}
                  {j.image_url && <SignedImage path={j.image_url} bucket="justificatifs-maladie" />}
                  {j.commentaire_admin && <div className="text-sm text-muted-foreground italic mt-2">{j.commentaire_admin}</div>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ s }: { s: string }) {
  if (s === "en_attente") return <Badge className="statut-retard border"><Clock className="w-3 h-3 mr-1" />{DEMANDE_STATUT_LABELS[s]}</Badge>;
  if (s === "approuve") return <Badge className="statut-present border"><FileCheck className="w-3 h-3 mr-1" />{DEMANDE_STATUT_LABELS[s]}</Badge>;
  return <Badge className="statut-absent border"><XCircle className="w-3 h-3 mr-1" />{DEMANDE_STATUT_LABELS[s]}</Badge>;
}

function SignedImage({ path, bucket }: { path: string; bucket: string }) {
  const { data } = useQuery({
    queryKey: ["signed", bucket, path],
    queryFn: async () => {
      const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
      return data?.signedUrl;
    },
  });
  if (!data) return <div className="h-32 rounded bg-muted animate-pulse" />;
  return <a href={data} target="_blank" rel="noopener"><img src={data} alt="justificatif" className="rounded max-h-40 object-cover w-full" /></a>;
}

function NouvelleDemandeDialog({ userId, onDone }: { userId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"conge_annuel" | "sortie_anticipee" | "absence_exceptionnelle" | "avance">("conge_annuel");
  const [dateDebut, setDateDebut] = useState("");
  const [dateFin, setDateFin] = useState("");
  const [heureSortie, setHeureSortie] = useState("");
  const [heureRetour, setHeureRetour] = useState("");
  const [montantAvance, setMontantAvance] = useState("");
  const [motif, setMotif] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validation commune
    if (!motif.trim()) {
      return toast.error("Merci d'indiquer le motif de votre demande");
    }
    
    // Validation spécifique à l'avance
    if (type === "avance") {
      if (!montantAvance || parseFloat(montantAvance) <= 0) {
        return toast.error("Veuillez entrer un montant valide pour l'avance");
      }
      if (!dateDebut) {
        return toast.error("Veuillez sélectionner une date");
      }
    }
    
    // Validation pour les autres types
    if (type === "sortie_anticipee" && !heureSortie) {
      return toast.error("Veuillez indiquer l'heure de sortie");
    }
    
    if (type === "conge_annuel" && (!dateDebut || !dateFin)) {
      return toast.error("Veuillez sélectionner les dates de début et fin");
    }

    setLoading(true);
    
    // Construire l'objet de la demande
    const demandeData: any = {
      user_id: userId,
      type,
      motif,
    };

    // Ajouter les champs selon le type
    if (type === "avance") {
      demandeData.date_debut = dateDebut;
      demandeData.date_fin = dateDebut;
      demandeData.montant = parseFloat(montantAvance);
      demandeData.heure_sortie = null;
      demandeData.heure_retour = null;
    } else if (type === "sortie_anticipee") {
      demandeData.date_debut = dateDebut;
      demandeData.date_fin = dateDebut;
      demandeData.heure_sortie = heureSortie;
      demandeData.heure_retour = heureRetour || null;
      demandeData.montant = null;
    } else {
      demandeData.date_debut = dateDebut;
      demandeData.date_fin = dateFin;
      demandeData.heure_sortie = null;
      demandeData.heure_retour = null;
      demandeData.montant = null;
    }

    const { error } = await supabase.from("demandes").insert(demandeData);
    
    setLoading(false);
    if (error) {
      console.error("Error creating demande:", error);
      return toast.error(error.message);
    }
    
    toast.success("Demande envoyée");
    setOpen(false);
    setMotif("");
    setDateDebut("");
    setDateFin("");
    setHeureSortie("");
    setHeureRetour("");
    setMontantAvance("");
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="w-4 h-4 mr-2" />Nouvelle demande</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Nouvelle demande</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v: any) => setType(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="conge_annuel">Congé annuel</SelectItem>
                <SelectItem value="sortie_anticipee">Sortie anticipée</SelectItem>
                <SelectItem value="absence_exceptionnelle">Absence exceptionnelle</SelectItem>
                <SelectItem value="avance">Demande d'avance</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>{type === "sortie_anticipee" ? "Date" : "Date début"}</Label>
              <Input type="date" required value={dateDebut} onChange={(e) => setDateDebut(e.target.value)} />
            </div>
            
            {type === "sortie_anticipee" ? (
              <div className="space-y-2">
                <Label>Heure de sortie</Label>
                <Input type="time" required value={heureSortie} onChange={(e) => setHeureSortie(e.target.value)} />
              </div>
            ) : type === "avance" ? (
              <div className="space-y-2">
                <Label>Montant (DT)</Label>
                <Input 
                  type="number" 
                  step="0.01" 
                  min="0"
                  required 
                  value={montantAvance} 
                  onChange={(e) => setMontantAvance(e.target.value)} 
                  placeholder="0.00" 
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Date fin</Label>
                <Input type="date" required value={dateFin} onChange={(e) => setDateFin(e.target.value)} min={dateDebut} />
              </div>
            )}
          </div>
          
          {type === "sortie_anticipee" && (
            <div className="space-y-2">
              <Label>Heure de retour (optionnel)</Label>
              <Input type="time" value={heureRetour} onChange={(e) => setHeureRetour(e.target.value)} />
              <p className="text-xs text-muted-foreground">Laissez vide si vous ne connaissez pas encore l'heure de retour</p>
            </div>
          )}
          
          <div className="space-y-2">
            <Label>Motif <span className="text-destructive">*</span></Label>
            <Textarea required value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Précisez la raison de votre demande (obligatoire)…" />
          </div>
          
          <DialogFooter>
            <Button type="submit" disabled={loading}>Envoyer</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NouveauJustifDialog({ userId, onDone }: { userId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  // CHANGEMENT #3: Ajout du motif (obligatoire)
  const [motif, setMotif] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // CHANGEMENT #3: Motif obligatoire
    if (!motif.trim()) return toast.error("Le motif est obligatoire");
    setLoading(true);
    let path = null;
    // CHANGEMENT #3: Le fichier devient optionnel
    if (file) {
      const ext = file.name.split(".").pop();
      path = `${userId}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("justificatifs-maladie").upload(path, file);
      if (upErr) { setLoading(false); return toast.error(upErr.message); }
    }
    const { error } = await supabase.from("justificatifs_maladie").insert({ 
      user_id: userId, 
      date_concernee: date, 
      // CHANGEMENT #3: Ajout du motif
      motif,
      image_url: path 
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Justificatif envoyé");
    setOpen(false); 
    setDate(""); 
    // CHANGEMENT #3: Réinitialisation du motif
    setMotif("");
    setFile(null);
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline"><Upload className="w-4 h-4 mr-2" />Justificatif maladie</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Envoyer un justificatif maladie</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label>Date concernée</Label>
            <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          {/* CHANGEMENT #3: Motif obligatoire */}
          <div className="space-y-2">
            <Label>Motif <span className="text-destructive">*</span></Label>
            <Textarea required value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Décrivez le motif de votre arrêt..." />
          </div>
          {/* CHANGEMENT #3: Fichier devient optionnel */}
          <div className="space-y-2">
            <Label>Certificat médical (optionnel)</Label>
            <Input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <p className="text-xs text-muted-foreground">Vous pouvez joindre un certificat si vous en avez un</p>
          </div>
          <DialogFooter><Button type="submit" disabled={loading}>Envoyer</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}