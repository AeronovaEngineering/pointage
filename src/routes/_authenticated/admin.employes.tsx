import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentUser, displayName, initials } from "@/lib/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Download, Edit, UserX, UserCheck, Plus, Trash2,
  User, Mail, Phone, MapPin, Calendar, Briefcase,
  Building, CreditCard, IdCard, Heart, Users,
  Clock, Award, FileText, CheckCircle, XCircle,
  AlertCircle, ChevronLeft, ChevronRight, Home,
  CalendarDays, MessageCircle, DollarSign, Wallet, Pencil,
  Shield, Stethoscope, FileSignature, Coins, Banknote
} from "lucide-react";
import { toast } from "sonner";
import { formatDateFR, DEMANDE_TYPE_LABELS, DEMANDE_STATUT_LABELS } from "@/lib/format";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

// ---- helper: calls a secure Netlify function with the current session token ----
async function callAdminFn(fn: string, body: any) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`/api/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token}`,
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let json: any = {};
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = {};
    }
  }

  if (!res.ok) {
    throw new Error(json?.error || `Erreur serveur (${res.status})`);
  }
  return json;
}

// ---- helper: export a single employee's full presence report as PDF ----
async function exportSingleEmployeePDF(employee: any) {
  const { data } = await supabase
    .from("pointages")
    .select("date,heure_pointage,heure_sortie,statut,retard_minutes,taches_realisees,user_id")
    .eq("user_id", employee.id)
    .order("date", { ascending: true })
    .limit(10000);

  const doc = new jsPDF("landscape", "mm", "a4");
  const pageWidth = doc.internal.pageSize.getWidth();
  const nom = displayName(employee);

  doc.setFontSize(16);
  doc.text(`Rapport de présence — ${nom}`, pageWidth / 2, 15, { align: "center" });
  doc.setFontSize(10);
  doc.text(`Poste : ${employee.poste || "—"}  •  Département : ${employee.departement || "—"}`, pageWidth / 2, 22, { align: "center" });

  autoTable(doc, {
    head: [["Date", "Arrivée", "Sortie", "Statut", "Retard", "Tâches"]],
    body: (data ?? []).map((r: any) => [
      formatDateFR(r.date),
      r.heure_pointage ?? "—",
      r.heure_sortie ?? "—",
      r.statut === "present" ? "Présent" :
      r.statut === "retard" ? "Retard" :
      r.statut === "absent" ? "Absent" :
      r.statut === "absent_justifie" ? "Absent justifié" : "Congé",
      r.retard_minutes ? `${Math.floor(r.retard_minutes / 60)}h${(r.retard_minutes % 60).toString().padStart(2, "0")}` : "—",
      (r.taches_realisees ?? "").substring(0, 50),
    ]),
    startY: 30,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [41, 128, 185], fontSize: 9, fontStyle: "bold" },
  });

  doc.save(`fiche_${nom.replace(/\s+/g, "_")}.pdf`);
  toast.success("Rapport PDF téléchargé");
}

export const Route = createFileRoute("/_authenticated/admin/employes")({
  beforeLoad: async () => {
    const u = await fetchCurrentUser();
    if (!u || u.role !== "admin") throw new Error("Accès admin requis");
  },
  component: AdminEmployes,
});

function AdminEmployes() {
  const qc = useQueryClient();
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);

  const { data: employeesRaw = [] } = useQuery({
    queryKey: ["admin-employes"],
    queryFn: async () => {
      const [{ data: profs }, { data: roles }, { data: soldes }] = await Promise.all([
        supabase.from("profiles").select("*").order("nom"),
        supabase.from("user_roles").select("user_id,role"),
        supabase.from("solde_conges").select("user_id,solde_actuel"),
      ]);
      const rMap = new Map((roles ?? []).map((r) => [r.user_id, r.role]));
      const sMap = new Map((soldes ?? []).map((s) => [s.user_id, s.solde_actuel]));
      return (profs ?? []).map((p) => ({ ...p, role: rMap.get(p.id) ?? "employe", solde: sMap.get(p.id) ?? 0 }));
    },
  });

  // L'admin n'est pas un employé
  const employees = employeesRaw.filter((e) => e.role !== "admin");

  const selectedEmployee = employees.find((e) => e.id === selectedEmployeeId) ?? employees[0] ?? null;
  if (selectedEmployee && selectedEmployeeId !== selectedEmployee.id) {
    queueMicrotask(() => setSelectedEmployeeId(selectedEmployee.id));
  }

  const deleteEmployee = async (userId: string) => {
    await callAdminFn("admin-delete-employee", { userId });
  };

  const toggleActif = async (id: string, actif: boolean) => {
    await supabase.from("profiles").update({ actif: !actif }).eq("id", id);
    toast.success(actif ? "Employé désactivé" : "Employé activé");
    qc.invalidateQueries({ queryKey: ["admin-employes"] });
  };

  const supprimer = async (id: string) => {
    try {
      await deleteEmployee(id);
      toast.success("Employé supprimé");
      qc.invalidateQueries({ queryKey: ["admin-employes"] });
      if (selectedEmployeeId === id) {
        setSelectedEmployeeId(employees.length > 1 ? employees.find((e) => e.id !== id)?.id || null : null);
      }
    } catch (e: any) {
      toast.error(e.message ?? "Erreur");
    }
  };

  return (
    <div className="space-y-4 max-w-full">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold">Gestion des employés</h1>
          <p className="text-muted-foreground">{employees.length} employé{employees.length > 1 ? "s" : ""} au total</p>
        </div>
        <div className="grid grid-cols-2 sm:flex gap-2 w-full sm:w-auto">
          <ExportPDFDialog employees={employees} />
          <CreerEmployeDialog onDone={() => qc.invalidateQueries({ queryKey: ["admin-employes"] })} />
        </div>
      </div>

      <FicheEmploye
        employee={selectedEmployee}
        allEmployees={employees}
        onSelectEmployee={setSelectedEmployeeId}
        onRefresh={() => qc.invalidateQueries({ queryKey: ["admin-employes"] })}
        onToggleActif={toggleActif}
        onDelete={supprimer}
      />
    </div>
  );
}

// ============================================================
// InlineCardEdit - Reusable per-card inline edit
// ============================================================
type FieldConfig = {
  key: string;
  label: string;
  type?: "text" | "date" | "number" | "boolean" | "textarea";
};

function InlineCardEdit({
  employee,
  title,
  fields,
  onDone,
}: {
  employee: any;
  title: string;
  fields: FieldConfig[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<any>({});
  const [saving, setSaving] = useState(false);

  const openDialog = (o: boolean) => {
    setOpen(o);
    if (o) {
      setValues(Object.fromEntries(fields.map((f) => [f.key, employee?.[f.key] ?? (f.type === "boolean" ? false : "")])));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload: any = {};
      fields.forEach((f) => {
        const v = values[f.key];
        payload[f.key] = v === "" || v === undefined ? null : v;
      });
      const { error } = await supabase.from("profiles").update(payload).eq("id", employee.id);
      if (error) throw error;
      toast.success(`${title} enregistré`);
      setOpen(false);
      onDone();
    } catch (e: any) {
      toast.error(e.message ?? "Erreur lors de l'enregistrement");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="absolute top-2 right-2 h-7 w-7 text-muted-foreground hover:text-foreground z-10"
          aria-label={`Éditer ${title}`}
        >
          <Pencil className="w-3.5 h-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Éditer — {title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {fields.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label>{f.label}</Label>
              {f.type === "boolean" ? (
                <Select
                  value={values[f.key] ? "oui" : "non"}
                  onValueChange={(v) => setValues({ ...values, [f.key]: v === "oui" })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="oui">Oui</SelectItem>
                    <SelectItem value="non">Non</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={saving}>{saving ? "Enregistrement…" : "Enregistrer"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// FICHE EMPLOYÉ COMPLÈTE — avec onglets
// ============================================================
function FicheEmploye({
  employee,
  allEmployees,
  onSelectEmployee,
  onRefresh,
  onToggleActif,
  onDelete,
}: {
  employee: any;
  allEmployees: any[];
  onSelectEmployee: (id: string) => void;
  onRefresh: () => void;
  onToggleActif: (id: string, actif: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [activeTab, setActiveTab] = useState("informations");

  // ---- Données récupérées depuis la DB ----
  const { data: demandes = [] } = useQuery({
    queryKey: ["employee-demandes", employee?.id],
    enabled: !!employee,
    queryFn: async () => {
      const { data } = await supabase.from("demandes").select("*").eq("user_id", employee.id).order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const { data: primesData = [] } = useQuery({
    queryKey: ["employee-primes", employee?.id],
    enabled: !!employee,
    queryFn: async () => {
      const { data } = await supabase.from("primes").select("*").eq("user_id", employee.id).order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const { data: justifsData = [] } = useQuery({
    queryKey: ["employee-justifs", employee?.id],
    enabled: !!employee,
    queryFn: async () => {
      const { data } = await supabase.from("justificatifs_maladie").select("*").eq("user_id", employee.id).order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const { data: pointagesData = [] } = useQuery({
    queryKey: ["employee-pointages", employee?.id],
    enabled: !!employee,
    queryFn: async () => {
      const monthAgo = new Date();
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      const { data } = await supabase
        .from("pointages")
        .select("*")
        .eq("user_id", employee.id)
        .gte("date", monthAgo.toISOString().split("T")[0])
        .order("date", { ascending: false });
      return data ?? [];
    },
  });

  if (!employee) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Aucun employé pour le moment. Cliquez sur <b>Nouvel employé</b>.
        </CardContent>
      </Card>
    );
  }

  // ---- Catégories ----
  const congesData = demandes.filter((d: any) => d.type === "conge_annuel");
  const avancesData = demandes.filter((d: any) => d.type === "avance");
  const autresData = demandes.filter((d: any) => d.type === "sortie_anticipee" || d.type === "absence_exceptionnelle");

  const nextEmployee = () => {
    const currentIndex = allEmployees.findIndex((e) => e.id === employee.id);
    const nextIndex = (currentIndex + 1) % allEmployees.length;
    onSelectEmployee(allEmployees[nextIndex].id);
  };

  const prevEmployee = () => {
    const currentIndex = allEmployees.findIndex((e) => e.id === employee.id);
    const prevIndex = (currentIndex - 1 + allEmployees.length) % allEmployees.length;
    onSelectEmployee(allEmployees[prevIndex].id);
  };

  const statutBadge = (statut: string) => (
    <Badge variant={statut === "approuve" ? "default" : statut === "refuse" ? "destructive" : "secondary"}>
      {DEMANDE_STATUT_LABELS[statut] ?? statut}
    </Badge>
  );

  const demandeRow = (c: any, amountLabel?: (c: any) => string) => (
    <div key={c.id} className="flex items-start justify-between p-3 border rounded-lg gap-3">
      <div className="min-w-0">
        <div className="font-medium flex items-center gap-1">
          {c.statut === "approuve" ? <CheckCircle className="w-4 h-4 text-green-500" /> :
           c.statut === "refuse" ? <XCircle className="w-4 h-4 text-red-500" /> :
           <AlertCircle className="w-4 h-4 text-yellow-500" />}
          {DEMANDE_TYPE_LABELS[c.type] ?? c.type}
        </div>
        {amountLabel ? (
          <div className="text-sm text-muted-foreground">{amountLabel(c)}</div>
        ) : (
          <div className="text-sm text-muted-foreground">
            Du {formatDateFR(c.date_debut)} au {formatDateFR(c.date_fin)}
            {c.jours_deduits ? ` (${c.jours_deduits} jour${c.jours_deduits > 1 ? "s" : ""})` : c.nb_jours ? ` (${c.nb_jours} jour${c.nb_jours > 1 ? "s" : ""})` : ""}
          </div>
        )}
        {c.motif && <div className="text-sm text-muted-foreground truncate">Motif : {c.motif}</div>}
      </div>
      {statutBadge(c.statut)}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Ribbon de sélection + actions */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <Button variant="outline" size="icon" className="shrink-0" onClick={prevEmployee}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Select value={employee.id} onValueChange={(value) => onSelectEmployee(value)}>
                <SelectTrigger className="w-[180px] sm:w-[250px]">
                  <SelectValue>
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar className="w-6 h-6 shrink-0">
                        <AvatarImage src={employee.photo_url ?? undefined} />
                        <AvatarFallback>{initials(employee)}</AvatarFallback>
                      </Avatar>
                      <span className="truncate">{displayName(employee)}</span>
                    </div>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {allEmployees.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      <div className="flex items-center gap-2">
                        <Avatar className="w-6 h-6">
                          <AvatarImage src={e.photo_url ?? undefined} />
                          <AvatarFallback>{initials(e)}</AvatarFallback>
                        </Avatar>
                        <span>{displayName(e)}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" className="shrink-0" onClick={nextEmployee}>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
            <div className="grid grid-cols-2 sm:flex items-center gap-2 w-full sm:w-auto">
              {!employee.actif && <Badge variant="destructive" className="col-span-2 justify-center sm:col-span-1">Inactif</Badge>}
              <EditerDialog emp={employee} onDone={onRefresh} />
              <Button size="sm" variant="outline" onClick={() => onToggleActif(employee.id, employee.actif)}>
                {employee.actif ? <UserX className="w-4 h-4 mr-2" /> : <UserCheck className="w-4 h-4 mr-2" />}
                {employee.actif ? "Désactiver" : "Activer"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => exportSingleEmployeePDF(employee)}>
                <Download className="w-4 h-4 mr-2" />
                Export PDF
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="outline" className="text-destructive hover:text-destructive">
                    <Trash2 className="w-4 h-4 mr-2" />
                    Supprimer
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Supprimer {displayName(employee)} ?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Cette action est irréversible. L'utilisateur, son profil, ses pointages, demandes et solde de congés seront supprimés.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Annuler</AlertDialogCancel>
                    <AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={() => onDelete(employee.id)}>
                      Supprimer définitivement
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* En-tête de la fiche avec photo et infos principales */}
      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col md:flex-row gap-6">
            <div className="flex-shrink-0">
              <div className="w-32 h-32 md:w-40 md:h-40 rounded-lg overflow-hidden border-2 border-muted mx-auto md:mx-0">
                <Avatar className="w-full h-full rounded-none">
                  <AvatarImage src={employee.photo_url ?? undefined} className="object-cover" />
                  <AvatarFallback className="text-4xl font-bold">{initials(employee)}</AvatarFallback>
                </Avatar>
              </div>
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-2xl font-bold">{employee.prenom} {employee.nom}</h2>
                  <p className="text-lg text-muted-foreground">{employee.poste || "Poste non défini"}</p>
                  <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                    <Building className="w-4 h-4" />
                    <span>{employee.departement || "Département non défini"}</span>
                  </div>
                </div>
                <div className="text-sm text-right">
                  <div>Employé depuis : <span className="font-medium">{employee.date_embauche ? formatDateFR(employee.date_embauche) : "—"}</span></div>
                  <div>Solde congés : <span className="font-bold text-primary">{Number(employee.solde).toFixed(2)} jours</span></div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4 pt-4 border-t">
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                  <span className="truncate">{employee.email}</span>
                </div>
                {employee.telephone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="w-4 h-4 text-muted-foreground" />
                    <span>{employee.telephone}</span>
                  </div>
                )}
                {employee.whatsapp && (
                  <div className="flex items-center gap-2 text-sm">
                    <MessageCircle className="w-4 h-4 text-green-500" />
                    <span>{employee.whatsapp}</span>
                  </div>
                )}
                {employee.manager && (
                  <div className="flex items-center gap-2 text-sm">
                    <Users className="w-4 h-4 text-muted-foreground" />
                    <span>Manager : {employee.manager}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ===== ONGLETS ===== */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          <TabsTrigger value="informations" className="text-xs lg:text-sm">
            <User className="w-4 h-4 mr-2" />
            Infos
          </TabsTrigger>
          <TabsTrigger value="conges" className="text-xs lg:text-sm">
            <Calendar className="w-4 h-4 mr-2" />
            Congés
          </TabsTrigger>
          <TabsTrigger value="contrat" className="text-xs lg:text-sm">
            <FileSignature className="w-4 h-4 mr-2" />
            Contrat
          </TabsTrigger>
          <TabsTrigger value="presence" className="text-xs lg:text-sm">
            <Clock className="w-4 h-4 mr-2" />
            Présence
          </TabsTrigger>
          <TabsTrigger value="primes" className="text-xs lg:text-sm">
            <Coins className="w-4 h-4 mr-2" />
            Primes
          </TabsTrigger>
          <TabsTrigger value="sante" className="text-xs lg:text-sm">
            <Stethoscope className="w-4 h-4 mr-2" />
            Santé
          </TabsTrigger>
          <TabsTrigger value="banque" className="text-xs lg:text-sm">
            <Banknote className="w-4 h-4 mr-2" />
            Banque
          </TabsTrigger>
          <TabsTrigger value="urgence" className="text-xs lg:text-sm">
            <Heart className="w-4 h-4 mr-2" />
            Urgence
          </TabsTrigger>
        </TabsList>

        {/* ===== ONGLET INFORMATIONS ===== */}
        <TabsContent value="informations" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="relative">
              <InlineCardEdit
                employee={employee}
                title="Identité"
                onDone={onRefresh}
                fields={[
                  { key: "date_naissance", label: "Date de naissance", type: "date" },
                  { key: "nationalite", label: "Nationalité" },
                  { key: "cni", label: "CIN" },
                ]}
              />
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><User className="w-4 h-4" />Identité</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Nom complet</span><span className="font-medium">{employee.prenom} {employee.nom}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Date de naissance</span><span className="font-medium">{employee.date_naissance ? formatDateFR(employee.date_naissance) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Nationalité</span><span className="font-medium">{employee.nationalite || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">CIN</span><span className="font-medium">{employee.cni || "—"}</span></div>
              </CardContent>
            </Card>

            <Card className="relative">
              <InlineCardEdit
                employee={employee}
                title="Coordonnées"
                onDone={onRefresh}
                fields={[
                  { key: "email_personnel", label: "Email personnel" },
                  { key: "telephone", label: "Téléphone" },
                  { key: "whatsapp", label: "WhatsApp" },
                  { key: "adresse", label: "Adresse" },
                ]}
              />
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><MapPin className="w-4 h-4" />Coordonnées</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Email personnel</span><span className="font-medium">{employee.email_personnel || employee.email}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Téléphone</span><span className="font-medium">{employee.telephone || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">WhatsApp</span><span className="font-medium">{employee.whatsapp || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Adresse</span><span className="font-medium">{employee.adresse || "—"}</span></div>
              </CardContent>
            </Card>

            <Card className="relative">
              <InlineCardEdit
                employee={employee}
                title="Poste & Département"
                onDone={onRefresh}
                fields={[
                  { key: "poste", label: "Poste" },
                  { key: "departement", label: "Département" },
                  { key: "manager", label: "Manager / Superviseur" },
                  { key: "date_embauche", label: "Date d'embauche", type: "date" },
                ]}
              />
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><Briefcase className="w-4 h-4" />Poste & Département</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Poste</span><span className="font-medium">{employee.poste || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Département</span><span className="font-medium">{employee.departement || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Manager / Superviseur</span><span className="font-medium">{employee.manager || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Date d'embauche</span><span className="font-medium">{employee.date_embauche ? formatDateFR(employee.date_embauche) : "—"}</span></div>
              </CardContent>
            </Card>

            <Card className="relative">
              <InlineCardEdit
                employee={employee}
                title="Politique horaire"
                onDone={onRefresh}
                fields={[
                  { key: "politique_horaire", label: "Type" },
                  { key: "heures_semaine", label: "Heures/semaine", type: "number" },
                  { key: "heures_jour", label: "Heures/jour", type: "number" },
                  { key: "jours_repos", label: "Jours de repos" },
                ]}
              />
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><Clock className="w-4 h-4" />Politique horaire</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Type</span><span className="font-medium">{employee.politique_horaire || "Standard (35h/semaine)"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Heures/semaine</span><span className="font-medium">{employee.heures_semaine || "35"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Heures/jour</span><span className="font-medium">{employee.heures_jour || "7"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Jours de repos</span><span className="font-medium">{employee.jours_repos || "Samedi-Dimanche"}</span></div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ===== ONGLET CONGÉS ===== */}
        <TabsContent value="conges" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle className="text-sm font-medium flex items-center gap-2"><Calendar className="w-4 h-4" />Congés</CardTitle></CardHeader>
              <CardContent>
                <ScrollArea className="h-[260px]">
                  {congesData.length === 0 ? (
                    <p className="text-center text-muted-foreground py-8">Aucune demande de congé</p>
                  ) : (
                    <div className="space-y-3">
                      {congesData.map((c: any) => demandeRow(c))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-sm font-medium">Solde actuel</CardTitle></CardHeader>
              <CardContent>
                <div className="text-center">
                  <div className="text-4xl font-bold text-primary">{Number(employee.solde).toFixed(2)}</div>
                  <div className="text-sm text-muted-foreground">jours restants</div>
                  <div className="mt-4 p-3 bg-muted rounded-lg text-sm text-left space-y-1">
                    <div>Congés pris : <b>{congesData.filter((c: any) => c.statut === "approuve").reduce((sum: number, c: any) => sum + (c.jours_deduits || 0), 0)}</b> jours</div>
                    <div>Congés en attente : <b>{congesData.filter((c: any) => c.statut === "en_attente").length}</b></div>
                    <div>Avances en attente : <b>{avancesData.filter((c: any) => c.statut === "en_attente").length}</b></div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Avances */}
          <Card>
            <CardHeader><CardTitle className="text-sm font-medium flex items-center gap-2"><Wallet className="w-4 h-4" />Avances</CardTitle></CardHeader>
            <CardContent>
              <ScrollArea className="h-[200px]">
                {avancesData.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">Aucune demande d'avance</p>
                ) : (
                  <div className="space-y-3">
                    {avancesData.map((c: any) => demandeRow(c, (c) => `Montant : ${c.montant ?? "—"} TND`))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Autres demandes */}
          <Card>
            <CardHeader><CardTitle className="text-sm font-medium flex items-center gap-2"><AlertCircle className="w-4 h-4" />Autres demandes</CardTitle></CardHeader>
            <CardContent>
              <ScrollArea className="h-[200px]">
                {autresData.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">Aucune autre demande</p>
                ) : (
                  <div className="space-y-3">
                    {autresData.map((c: any) => demandeRow(c))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ===== ONGLET CONTRAT ===== */}
        <TabsContent value="contrat" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="relative">
              <InlineCardEdit
                employee={employee}
                title="Contrat"
                onDone={onRefresh}
                fields={[
                  { key: "type_contrat", label: "Type de contrat" },
                  { key: "date_fin_contrat", label: "Date de fin", type: "date" },
                  { key: "periode_essai", label: "Période d'essai", type: "boolean" },
                  { key: "salaire_base", label: "Salaire mensuel (TND)", type: "number" },
                ]}
              />
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><FileText className="w-4 h-4" />Contrat</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Type de contrat</span><span className="font-medium">{employee.type_contrat || "CDI"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Date de fin</span><span className="font-medium">{employee.date_fin_contrat ? formatDateFR(employee.date_fin_contrat) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Période d'essai</span><span className="font-medium">{employee.periode_essai ? "Oui" : "Non"}</span></div>
                <Separator className="my-1" />
                <div className="flex justify-between"><span className="text-muted-foreground">Salaire mensuel</span><span className="font-bold">{employee.salaire_base ? `${Number(employee.salaire_base).toFixed(2)} TND` : "—"}</span></div>
              </CardContent>
            </Card>

            <Card className="relative">
              <InlineCardEdit
                employee={employee}
                title="Informations bancaires"
                onDone={onRefresh}
                fields={[
                  { key: "rib", label: "RIB" },
                  { key: "iban", label: "IBAN" },
                  { key: "banque", label: "Banque" },
                ]}
              />
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><CreditCard className="w-4 h-4" />Informations bancaires</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">RIB</span><span className="font-medium font-mono">{employee.rib || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">IBAN</span><span className="font-medium font-mono">{employee.iban || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Banque</span><span className="font-medium">{employee.banque || "—"}</span></div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ===== ONGLET PRÉSENCE ===== */}
        <TabsContent value="presence" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle className="text-sm font-medium">Calendrier de présence</CardTitle></CardHeader>
              <CardContent>
                <div className="grid grid-cols-7 gap-1 text-center">
                  {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => (
                    <div key={d} className="text-xs font-medium text-muted-foreground p-1">{d}</div>
                  ))}
                  {Array.from({ length: 35 }, (_, i) => {
                    const date = new Date();
                    date.setDate(1);
                    const firstDay = date.getDay();
                    const day = i - firstDay + 1;
                    if (day < 1 || day > 31) return <div key={i} className="p-2 text-sm opacity-0">-</div>;
                    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const pointage = pointagesData.find((p: any) => p.date === dateStr);
                    const status = pointage?.statut;

                    const cellBg =
                      status === "conge" ? "bg-purple-100 border-purple-300" :
                      status === "present" ? "bg-green-50 border-green-200" :
                      status === "retard" ? "bg-yellow-50 border-yellow-200" :
                      status === "absent" ? "bg-red-50 border-red-200" :
                      status === "absent_justifie" ? "bg-orange-50 border-orange-200" :
                      "";

                    return (
                      <div key={i} className={`p-2 border rounded-lg text-sm ${cellBg}`}>
                        <div className="font-medium">{day}</div>
                        <div className="text-xs">
                          {status === "present" && <span className="text-green-600">✓</span>}
                          {status === "retard" && <span className="text-yellow-600">⏰</span>}
                          {status === "absent" && <span className="text-red-600">✗</span>}
                          {status === "absent_justifie" && <span className="text-orange-600">📋</span>}
                          {status === "conge" && <span className="text-purple-600 font-medium">🌴</span>}
                          {!status && <span className="text-gray-300">·</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-3 mt-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-50 border border-green-200 inline-block" />✓ Présent</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-yellow-50 border border-yellow-200 inline-block" />Retard</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-red-50 border border-red-200 inline-block" />✗ Absent</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-orange-50 border border-orange-200 inline-block" />Justifié</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-purple-100 border border-purple-300 inline-block" /> Congé</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-sm font-medium">Résumé du mois</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm p-2 border-b"><span className="text-muted-foreground">Présents</span><span className="font-medium">{pointagesData.filter((p: any) => p.statut === "present").length}</span></div>
                  <div className="flex justify-between text-sm p-2 border-b"><span className="text-muted-foreground">Retards</span><span className="font-medium text-yellow-600">{pointagesData.filter((p: any) => p.statut === "retard").length}</span></div>
                  <div className="flex justify-between text-sm p-2 border-b"><span className="text-muted-foreground">Absences</span><span className="font-medium text-red-500">{pointagesData.filter((p: any) => p.statut === "absent").length}</span></div>
                  <div className="flex justify-between text-sm p-2 border-b"><span className="text-muted-foreground">Absences justifiées</span><span className="font-medium text-orange-600">{pointagesData.filter((p: any) => p.statut === "absent_justifie").length}</span></div>
                  <div className="flex justify-between text-sm p-2 border-b"><span className="text-muted-foreground">Congés</span><span className="font-medium text-purple-600">{pointagesData.filter((p: any) => p.statut === "conge").length}</span></div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ===== ONGLET PRIMES ===== */}
        <TabsContent value="primes" className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm font-medium flex items-center gap-2"><Award className="w-4 h-4" />Historique des primes</CardTitle></CardHeader>
            <CardContent>
              <ScrollArea className="h-[300px]">
                {primesData.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">Aucune prime enregistrée</p>
                ) : (
                  <div className="space-y-3">
                    {primesData.map((p: any) => (
                      <div key={p.id} className="flex items-start justify-between p-3 border rounded-lg gap-3">
                        <div className="min-w-0">
                          <div className="font-medium">Prime accordée</div>
                          <div className="text-sm text-muted-foreground">Date : {formatDateFR(p.created_at)}</div>
                          {p.commentaire && <div className="text-sm text-muted-foreground truncate">Commentaire : {p.commentaire}</div>}
                          {p.type && <div className="text-sm text-muted-foreground">Type : {p.type}</div>}
                        </div>
                        <div className="text-lg font-bold text-green-600 shrink-0">+{Number(p.montant).toFixed(2)} TND</div>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ===== ONGLET SANTÉ ===== */}
        <TabsContent value="sante" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-sm font-medium flex items-center gap-2"><Heart className="w-4 h-4" />Justificatifs maladie</CardTitle></CardHeader>
              <CardContent>
                <ScrollArea className="h-[250px]">
                  {justifsData.length === 0 ? (
                    <p className="text-center text-muted-foreground py-8">Aucun justificatif</p>
                  ) : (
                    <div className="space-y-2">
                      {justifsData.map((j: any) => (
                        <div key={j.id} className="p-3 border rounded-lg flex items-center justify-between gap-3">
                          <div>
                            <div className="font-medium">🏥 Arrêt maladie</div>
                            <div className="text-sm text-muted-foreground">Le {formatDateFR(j.date_concernee)}</div>
                            {j.commentaire && <div className="text-sm text-muted-foreground">{j.commentaire}</div>}
                          </div>
                          {statutBadge(j.statut)}
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>

            <Card className="relative">
              <InlineCardEdit
                employee={employee}
                title="Informations santé"
                onDone={onRefresh}
                fields={[
                  { key: "mutuelle", label: "Mutuelle" },
                  { key: "num_secu", label: "Numéro sécurité sociale" },
                  { key: "groupe_sanguin", label: "Groupe sanguin" },
                  { key: "allergies", label: "Allergies" },
                ]}
              />
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><Stethoscope className="w-4 h-4" />Informations santé</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Mutuelle</span><span className="font-medium">{employee.mutuelle || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Numéro sécurité sociale</span><span className="font-medium">{employee.num_secu || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Groupe sanguin</span><span className="font-medium">{employee.groupe_sanguin || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Allergies</span><span className="font-medium">{employee.allergies || "Aucune"}</span></div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ===== ONGLET BANQUE ===== */}
        <TabsContent value="banque" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="relative">
              <InlineCardEdit
                employee={employee}
                title="Coordonnées bancaires"
                onDone={onRefresh}
                fields={[
                  { key: "rib", label: "RIB" },
                  { key: "iban", label: "IBAN" },
                  { key: "banque", label: "Banque" },
                  { key: "bic", label: "Code BIC/SWIFT" },
                ]}
              />
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><CreditCard className="w-4 h-4" />Coordonnées bancaires</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">RIB</span><span className="font-medium font-mono">{employee.rib || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">IBAN</span><span className="font-medium font-mono">{employee.iban || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Banque</span><span className="font-medium">{employee.banque || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Code BIC/SWIFT</span><span className="font-medium font-mono">{employee.bic || "—"}</span></div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><DollarSign className="w-4 h-4" />Résumé</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Salaire mensuel</span><span className="font-bold">{employee.salaire_base ? `${Number(employee.salaire_base).toFixed(2)} TND` : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Total primes reçues</span><span className="font-medium text-green-600">{primesData.reduce((sum, p) => sum + Number(p.montant), 0).toFixed(2)} TND</span></div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ===== ONGLET URGENCE ===== */}
        <TabsContent value="urgence" className="space-y-4">
          <Card className="relative">
            <InlineCardEdit
              employee={employee}
              title="Contact d'urgence"
              onDone={onRefresh}
              fields={[
                { key: "urgence_nom", label: "Nom du contact" },
                { key: "urgence_relation", label: "Relation" },
                { key: "urgence_telephone", label: "Téléphone" },
                { key: "urgence_adresse", label: "Adresse" },
              ]}
            />
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><Heart className="w-4 h-4" />Contact d'urgence</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Nom</span><span className="font-medium">{employee.urgence_nom || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Relation</span><span className="font-medium">{employee.urgence_relation || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Téléphone</span><span className="font-medium">{employee.urgence_telephone || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Adresse</span><span className="font-medium">{employee.urgence_adresse || "—"}</span></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><AlertCircle className="w-4 h-4" />Notes</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              En cas d'urgence, ce contact doit être prévenu en priorité.
              Vérifiez que les coordonnées sont à jour.
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================
// Export PDF Dialog (unchanged)
// ============================================================
function ExportPDFDialog({ employees }: { employees: any[] }) {
  const [open, setOpen] = useState(false);
  const [debut, setDebut] = useState("");
  const [fin, setFin] = useState("");
  const [empId, setEmpId] = useState("tous");

  const generate = async () => {
    let query = supabase
      .from("pointages")
      .select("date,heure_pointage,heure_sortie,statut,retard_minutes,taches_realisees,user_id")
      .order("date", { ascending: true });
    if (debut) query = query.gte("date", debut);
    if (fin) query = query.lte("date", fin);
    if (empId !== "tous") query = query.eq("user_id", empId);
    const { data } = await query.limit(10000);

    const profMap = new Map(employees.map((e) => [e.id, `${e.prenom ?? ""} ${e.nom ?? ""}`.trim() || e.email]));
    const doc = new jsPDF("landscape", "mm", "a4");
    const pageWidth = doc.internal.pageSize.getWidth();

    const rowsByEmployee = new Map<string, any[]>();
    (data ?? []).forEach((r: any) => {
      if (!rowsByEmployee.has(r.user_id)) rowsByEmployee.set(r.user_id, []);
      rowsByEmployee.get(r.user_id)!.push(r);
    });

    const period = `${debut || "début"} au ${fin || "aujourd'hui"}`;
    let first = true;
    for (const [uid, rows] of rowsByEmployee) {
      if (!first) doc.addPage();
      first = false;
      doc.setFontSize(16);
      doc.text(`Rapport de présence — ${profMap.get(uid) ?? uid}`, pageWidth / 2, 15, { align: "center" });
      doc.setFontSize(10);
      doc.text(`Période : ${period}`, pageWidth / 2, 22, { align: "center" });

      autoTable(doc, {
        head: [["Date", "Arrivée", "Sortie", "Statut", "Retard", "Tâches"]],
        body: rows.map((r) => [
          formatDateFR(r.date),
          r.heure_pointage ?? "—",
          r.heure_sortie ?? "—",
          r.statut === "present" ? "Présent" :
          r.statut === "retard" ? "Retard" :
          r.statut === "absent" ? "Absent" :
          r.statut === "absent_justifie" ? "Absent justifié" : "Congé",
          r.retard_minutes ? `${Math.floor(r.retard_minutes / 60)}h${(r.retard_minutes % 60).toString().padStart(2, "0")}` : "—",
          (r.taches_realisees ?? "").substring(0, 50),
        ]),
        startY: 30,
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [41, 128, 185], fontSize: 9, fontStyle: "bold" },
      });
    }

    doc.save(`presence_${debut || "all"}_${fin || "all"}${empId !== "tous" ? "_" + (profMap.get(empId) ?? "") : ""}.pdf`);
    toast.success("Export PDF généré");
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline"><Download className="w-4 h-4 mr-2" />Export PDF</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Exporter le rapport de présence</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Du</Label><Input type="date" value={debut} onChange={(e) => setDebut(e.target.value)} /></div>
            <div className="space-y-1"><Label>Au</Label><Input type="date" value={fin} onChange={(e) => setFin(e.target.value)} /></div>
          </div>
          <div className="space-y-1">
            <Label>Employé</Label>
            <Select value={empId} onValueChange={setEmpId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="tous">Tous les employés</SelectItem>
                {employees.map((e) => <SelectItem key={e.id} value={e.id}>{`${e.prenom ?? ""} ${e.nom ?? ""}`.trim() || e.email}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter><Button onClick={generate}>Générer le PDF</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// CreerEmployeDialog (unchanged)
// ============================================================
function CreerEmployeDialog({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<any>({
    prenom: "",
    nom: "",
    email: "",
    password: "",
    poste: "",
    departement: "",
    role: "employe",
    date_embauche: "",
  });
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await callAdminFn("admin-create-employee", {
        email: f.email,
        password: f.password,
        nom: f.nom,
        prenom: f.prenom,
        poste: f.poste,
        departement: f.departement,
        role: f.role,
        date_embauche: f.date_embauche,
      });

      toast.success(`Employé ${f.prenom} ${f.nom} créé`);
      setF({ prenom: "", nom: "", email: "", password: "", poste: "", departement: "", role: "employe", date_embauche: "" });
      setOpen(false);
      onDone();
    } catch (err: any) {
      toast.error(err.message ?? "Erreur lors de la création");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus className="w-4 h-4 mr-2" />Nouvel employé</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Créer un employé</DialogTitle>
          <DialogDescription>L'employé recevra un compte immédiatement actif avec le mot de passe défini.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Prénom *</Label><Input required value={f.prenom} onChange={(e) => setF({ ...f, prenom: e.target.value })} /></div>
            <div className="space-y-1"><Label>Nom *</Label><Input required value={f.nom} onChange={(e) => setF({ ...f, nom: e.target.value })} /></div>
          </div>
          <div className="space-y-1"><Label>Email *</Label><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="space-y-1"><Label>Mot de passe temporaire *</Label><Input type="text" required minLength={6} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="Min. 6 caractères" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Date d'embauche *</Label><Input type="date" required value={f.date_embauche} onChange={(e) => setF({ ...f, date_embauche: e.target.value })} /></div>
            <div className="space-y-1"><Label>Poste</Label><Input value={f.poste} onChange={(e) => setF({ ...f, poste: e.target.value })} /></div>
          </div>
          <div className="space-y-1"><Label>Département</Label><Input value={f.departement} onChange={(e) => setF({ ...f, departement: e.target.value })} /></div>
          <div className="space-y-1"><Label>Rôle</Label>
            <Select value={f.role} onValueChange={(v) => setF({ ...f, role: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="employe">Employé</SelectItem><SelectItem value="admin">Admin</SelectItem></SelectContent>
            </Select>
          </div>
          <DialogFooter><Button type="submit" disabled={loading}>{loading ? "Création…" : "Créer"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// EditerDialog - FIXED: solde congé is absolute (SET, not ADD)
// ============================================================
function EditerDialog({ emp, onDone }: { emp: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<any>({
    prenom: emp.prenom ?? "", nom: emp.nom ?? "",
    telephone: emp.telephone ?? "", adresse: emp.adresse ?? "",
    poste: emp.poste ?? "", departement: emp.departement ?? "",
    date_embauche: emp.date_embauche ?? "", role: emp.role,
    nouveau_solde: emp.solde ?? 0, motif: "",
  });

  const save = async () => {
    // Update profile
    await supabase.from("profiles").update({
      prenom: f.prenom, nom: f.nom, telephone: f.telephone || null, adresse: f.adresse || null,
      poste: f.poste || null, departement: f.departement || null,
      date_embauche: f.date_embauche || null,
    }).eq("id", emp.id);
    
    // Update role if changed
    if (f.role !== emp.role) {
      await supabase.rpc("definir_role", { _user_id: emp.id, _role: f.role });
    }
    
    // FIXED: Set solde to EXACT value (absolute), not additive
    // We use ajuster_solde but with delta = (new_value - current_value)
    // This way it becomes SET instead of ADD
    const currentSolde = emp.solde ?? 0;
    const newSolde = Number(f.nouveau_solde);
    const delta = newSolde - currentSolde;
    
    if (delta !== 0) {
      await supabase.rpc("ajuster_solde", { 
        _user_id: emp.id, 
        _delta: delta, 
        _motif: f.motif || `Ajustement admin: ${currentSolde} → ${newSolde} jours` 
      });
    }
    
    toast.success("Enregistré");
    setOpen(false);
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><Edit className="w-4 h-4 mr-2" />Éditer</Button></DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Éditer {displayName(emp)}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Prénom</Label><Input value={f.prenom} onChange={(e) => setF({ ...f, prenom: e.target.value })} /></div>
            <div className="space-y-1"><Label>Nom</Label><Input value={f.nom} onChange={(e) => setF({ ...f, nom: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Téléphone</Label><Input value={f.telephone} onChange={(e) => setF({ ...f, telephone: e.target.value })} /></div>
            <div className="space-y-1"><Label>Date d'embauche</Label><Input type="date" value={f.date_embauche ?? ""} onChange={(e) => setF({ ...f, date_embauche: e.target.value })} /></div>
          </div>
          <div className="space-y-1"><Label>Adresse</Label><Input value={f.adresse} onChange={(e) => setF({ ...f, adresse: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Poste</Label><Input value={f.poste} onChange={(e) => setF({ ...f, poste: e.target.value })} /></div>
            <div className="space-y-1"><Label>Département</Label><Input value={f.departement} onChange={(e) => setF({ ...f, departement: e.target.value })} /></div>
          </div>
          <div className="space-y-1"><Label>Rôle</Label>
            <Select value={f.role} onValueChange={(v) => setF({ ...f, role: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="employe">Employé</SelectItem><SelectItem value="admin">Admin</SelectItem></SelectContent>
            </Select>
          </div>
          
          {/* FIXED: Solde congé - absolute value, not additive */}
          <div className="pt-3 border-t space-y-1">
            <Label>Solde de congés (jours)</Label>
            <div className="flex gap-2">
              <Input 
                type="number" 
                step="0.5" 
                value={f.nouveau_solde} 
                onChange={(e) => setF({ ...f, nouveau_solde: e.target.value })} 
                placeholder="Nouveau solde exact"
                className="flex-1"
              />
              <Input 
                placeholder="Motif" 
                value={f.motif} 
                onChange={(e) => setF({ ...f, motif: e.target.value })}
                className="flex-1"
              />
            </div>
            <div className="text-xs text-muted-foreground">
              Solde actuel: <span className="font-medium">{Number(emp.solde).toFixed(2)} jours</span> → 
              Nouveau: <span className="font-medium text-primary">{Number(f.nouveau_solde).toFixed(2)} jours</span>
            </div>
          </div>
        </div>
        <DialogFooter><Button onClick={save}>Enregistrer</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}