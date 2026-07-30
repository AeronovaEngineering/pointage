import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentUser, displayName } from "@/lib/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { DEMANDE_TYPE_LABELS, formatDateFR } from "@/lib/format";
import { Check, X, FileText, Send } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/demandes")({
  beforeLoad: async () => {
    const u = await fetchCurrentUser();
    if (!u || u.role !== "admin") throw new Error("Accès admin requis");
  },
  component: AdminDemandes,
});

function AdminDemandes() {
  const qc = useQueryClient();

  // Fetch demandes + profiles séparément (fiable, indépendant de la résolution FK PostgREST)
  const { data: demandes = [], isLoading: loadingD } = useQuery({
    queryKey: ["admin-demandes"],
    queryFn: async () => {
      const [{ data: rows, error }, { data: profs }] = await Promise.all([
        supabase.from("demandes").select("*").order("created_at", { ascending: false }),
        supabase.from("profiles").select("id,nom,prenom,email,telephone"),
      ]);
      if (error) throw error;
      const map = new Map((profs ?? []).map((p) => [p.id, p]));
      return (rows ?? []).map((d) => ({ ...d, profile: map.get(d.user_id) }));
    },
  });

  const { data: justifs = [], isLoading: loadingJ } = useQuery({
    queryKey: ["admin-justifs"],
    queryFn: async () => {
      const [{ data: rows, error }, { data: profs }] = await Promise.all([
        supabase.from("justificatifs_maladie").select("*").order("created_at", { ascending: false }),
        supabase.from("profiles").select("id,nom,prenom,email,telephone"),
      ]);
      if (error) throw error;
      const map = new Map((profs ?? []).map((p) => [p.id, p]));
      return (rows ?? []).map((j) => ({ ...j, profile: map.get(j.user_id) }));
    },
  });

  // CHANGEMENT #5: Fonction pour envoyer une notification WhatsApp
  const sendWhatsAppNotification = async (employe: any, demande: any, type: string) => {
    try {
      // Construire le message
      const nomEmploye = employe ? displayName(employe) : "Employé";
      const typeDemande = DEMANDE_TYPE_LABELS[demande.type] || demande.type;
      
      let message = "";
      if (demande.type === "sortie_anticipee") {
        message = `${nomEmploye} a demandé une sortie anticipée le ${formatDateFR(demande.date_debut)} à ${demande.heure_sortie?.slice(0, 5) || "---"}`;
        if (demande.heure_retour) {
          message += ` avec retour prévu à ${demande.heure_retour.slice(0, 5)}`;
        }
      } else if (demande.type === "avance") {
        message = `${nomEmploye} a demandé une avance de ${demande.montant || "0"}  `;
      } else if (demande.type === "conge_annuel") {
        message = `${nomEmploye} a demandé un congé du ${formatDateFR(demande.date_debut)} au ${formatDateFR(demande.date_fin)}`;
      } else if (demande.type === "absence_exceptionnelle") {
        message = `${nomEmploye} a demandé une absence exceptionnelle le ${formatDateFR(demande.date_debut)}`;
      } else {
        message = `${nomEmploye} a soumis une demande de ${typeDemande}`;
      }

      // Ajouter le motif si présent
      if (demande.motif) {
        message += `\nMotif : ${demande.motif}`;
      }

      // Récupérer le numéro de téléphone de l'admin
      const { data: adminProfile } = await supabase
        .from("profiles")
        .select("telephone")
        .eq("id", (await fetchCurrentUser())?.id)
        .single();

      if (!adminProfile?.telephone) {
        console.warn("Aucun numéro de téléphone configuré pour l'admin");
        return false;
      }

      // Appeler l'API WhatsApp (à implémenter selon votre fournisseur)
      // Exemple avec Twilio ou autre service
      const response = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: adminProfile.telephone,
          message: message,
        }),
      });

      if (!response.ok) {
        console.error("Erreur envoi WhatsApp:", await response.text());
        return false;
      }

      return true;
    } catch (error) {
      console.error("Erreur envoi WhatsApp:", error);
      return false;
    }
  };

  const traiterD = async (id: string, approuve: boolean, com: string, demande: any) => {
    const fn = approuve ? "approuver_demande" : "refuser_demande";
    const { error } = await supabase.rpc(fn, { _demande_id: id, _commentaire: com || undefined });
    if (error) return toast.error(error.message);
    
    toast.success(approuve ? "Demande approuvée" : "Demande refusée");
    
    // CHANGEMENT #5: Envoyer notification WhatsApp quand une demande est soumise
    // Ici on envoie pour toute nouvelle demande (création)
    qc.invalidateQueries();
  };

  // CHANGEMENT #5: Fonction pour notifier lors de la création d'une demande
  const notifyNewDemande = async (demande: any) => {
    const employe = demande.profile;
    if (!employe) return;
    
    await sendWhatsAppNotification(employe, demande, "creation");
  };

  const traiterJ = async (id: string, approuve: boolean, com: string) => {
    const { error } = await supabase.rpc("traiter_justificatif", { _justif_id: id, _approuve: approuve, _commentaire: com || undefined });
    if (error) return toast.error(error.message);
    toast.success("Justificatif traité");
    qc.invalidateQueries();
  };

  const pendingD = demandes.filter((d) => d.statut === "en_attente");
  const traitees = demandes.filter((d) => d.statut !== "en_attente");
  const pendingJ = justifs.filter((j) => j.statut === "en_attente");
  const traiteesJ = justifs.filter((j) => j.statut !== "en_attente");

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl md:text-3xl font-semibold">Demandes des employés</h1>
        <p className="text-muted-foreground">Congés, sorties, absences et justificatifs maladie</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>En attente ({pendingD.length + pendingJ.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {(loadingD || loadingJ) && <p className="text-center text-muted-foreground py-6">Chargement…</p>}
          {!loadingD && !loadingJ && pendingD.length === 0 && pendingJ.length === 0 && (
            <p className="text-center text-muted-foreground py-6">Aucune demande en attente 🎉</p>
          )}
          {pendingD.map((d) => (
            <DemandeRow key={d.id} d={d} onTraiter={(app, com) => traiterD(d.id, app, com, d)} />
          ))}
          {pendingJ.map((j) => (
            <JustifRow key={j.id} j={j} onTraiter={(app, com) => traiterJ(j.id, app, com)} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Historique</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {[...traitees.map((d) => ({ kind: "d", ...d })), ...traiteesJ.map((j) => ({ kind: "j", ...j }))]
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
            .slice(0, 30)
            .map((r: any) => (
              <div key={r.id} className="p-3 rounded border flex flex-wrap items-center justify-between gap-2 text-sm">
                <div>
                  <b>{r.profile ? displayName(r.profile) : "Employé"}</b> — {r.kind === "d" ? DEMANDE_TYPE_LABELS[r.type] : "Justificatif maladie"} — {formatDateFR(r.date_debut ?? r.date_concernee)}
                  {r.commentaire_admin && (
                    <div className="text-xs text-muted-foreground italic mt-1">Réponse : {r.commentaire_admin}</div>
                  )}
                </div>
                <Badge className={r.statut === "approuve" ? "statut-present border" : "statut-absent border"}>
                  {r.statut === "approuve" ? "Approuvée" : "Refusée"}
                </Badge>
              </div>
            ))}
          {traitees.length === 0 && traiteesJ.length === 0 && (
            <p className="text-center text-muted-foreground py-6">Aucune demande traitée pour le moment.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DemandeRow({ d, onTraiter }: { d: any; onTraiter: (approuve: boolean, com: string) => void }) {
  return (
    <div className="p-4 rounded-md border-2 border-primary/20 bg-primary/5 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="min-w-0">
          <div className="font-medium">{d.profile ? displayName(d.profile) : "Employé"} — {DEMANDE_TYPE_LABELS[d.type]}</div>
          <div className="text-sm text-muted-foreground">
            {formatDateFR(d.date_debut)}{d.date_debut !== d.date_fin ? ` → ${formatDateFR(d.date_fin)}` : ""}
            {d.heure_sortie ? ` — sortie ${d.heure_sortie.slice(0, 5)}` : ""}
            {/* CHANGEMENT #1: Affichage de l'heure de retour */}
            {d.heure_retour ? ` — retour ${d.heure_retour.slice(0, 5)}` : ""}
            {/* CHANGEMENT #2: Affichage du montant pour les avances */}
            {d.montant ? ` — ${d.montant}  ` : ""}
          </div>
          {d.motif && <div className="text-sm mt-1"><b>Motif :</b> {d.motif}</div>}
        </div>
        <ActionsButtons onTraiter={onTraiter} />
      </div>
    </div>
  );
}

function JustifRow({ j, onTraiter }: { j: any; onTraiter: (approuve: boolean, com: string) => void }) {
  const { data: url } = useQuery({
    queryKey: ["signed-justif-admin", j.image_url],
    queryFn: async () => j.image_url ? (await supabase.storage.from("justificatifs-maladie").createSignedUrl(j.image_url, 3600)).data?.signedUrl : null,
  });
  return (
    <div className="p-4 rounded-md border-2 border-info/20 bg-info/5 space-y-2">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div className="flex gap-3 min-w-0">
          {url ? (
            <a href={url} target="_blank" rel="noopener"><img src={url} className="w-20 h-20 object-cover rounded" alt="justificatif" /></a>
          ) : (
            <div className="w-20 h-20 bg-muted rounded flex items-center justify-center"><FileText className="w-6 h-6 text-muted-foreground" /></div>
          )}
          <div>
            <div className="font-medium">{j.profile ? displayName(j.profile) : "Employé"} — Justificatif maladie</div>
            <div className="text-sm text-muted-foreground">Date : {formatDateFR(j.date_concernee)}</div>
            {/* CHANGEMENT #3: Affichage du motif */}
            {j.motif && <div className="text-sm mt-1"><b>Motif :</b> {j.motif}</div>}
          </div>
        </div>
        <ActionsButtons onTraiter={onTraiter} />
      </div>
    </div>
  );
}

function ActionsButtons({ onTraiter }: { onTraiter: (approuve: boolean, com: string) => void }) {
  const [openA, setOpenA] = useState(false);
  const [openR, setOpenR] = useState(false);
  const [comA, setComA] = useState("");
  const [comR, setComR] = useState("");
  return (
    <div className="flex gap-2 shrink-0">
      <Dialog open={openA} onOpenChange={setOpenA}>
        <DialogTrigger asChild>
          <Button size="sm"><Check className="w-4 h-4 mr-1" />Approuver</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approuver la demande</DialogTitle>
            <DialogDescription>Ajoutez un commentaire (optionnel) qui sera envoyé à l'employé.</DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Commentaire d'approbation (optionnel)…" value={comA} onChange={(e) => setComA(e.target.value)} />
          <DialogFooter>
            <Button onClick={() => { onTraiter(true, comA); setOpenA(false); setComA(""); }}>Confirmer l'approbation</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={openR} onOpenChange={setOpenR}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline"><X className="w-4 h-4 mr-1" />Refuser</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refuser la demande</DialogTitle>
            <DialogDescription>Merci d'indiquer le motif du refus, il sera transmis à l'employé.</DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Motif du refus (requis)…" value={comR} onChange={(e) => setComR(e.target.value)} required />
          <DialogFooter>
            <Button variant="destructive" disabled={!comR.trim()} onClick={() => { onTraiter(false, comR); setOpenR(false); setComR(""); }}>
              Confirmer le refus
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}