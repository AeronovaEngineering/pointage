import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentUser, initials } from "@/lib/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { 
  Upload, Shield, Eye, EyeOff, Key, CheckCircle, LogOut,
  Phone, MapPin, Mail, Calendar, Building, Briefcase, User,
  MessageCircle, Edit2, Save, X
} from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/profil")({
  component: ProfilPage,
});

function ProfilPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: user } = useQuery({ queryKey: ["current-user"], queryFn: fetchCurrentUser });

  const { data: profile } = useQuery({
    queryKey: ["profile-full", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("*").eq("id", user!.id).maybeSingle();
      return data;
    },
  });

  const [form, setForm] = useState<any>({});
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => { 
    if (profile) setForm(profile); 
  }, [profile]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    
    const { error } = await supabase.from("profiles").update({
      nom: form.nom, 
      prenom: form.prenom, 
      telephone: form.telephone, 
      adresse: form.adresse,
      poste: form.poste,
      departement: form.departement,
      whatsapp: form.whatsapp,
      date_naissance: form.date_naissance,
    }).eq("id", user!.id);
    
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("✅ Profil mis à jour avec succès !");
    setIsEditing(false);
    qc.invalidateQueries({ queryKey: ["current-user"] });
    qc.invalidateQueries({ queryKey: ["profile-full"] });
  };

  const changerMDP = async () => {
    if (!password) return toast.error("Saisissez un mot de passe");
    if (password.length < 6) return toast.error("Minimum 6 caractères");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) return toast.error(error.message);
    toast.success("🔐 Mot de passe mis à jour avec succès !");
    setPassword("");
  };

  const uploadPhoto = async (file: File) => {
    const ext = file.name.split(".").pop();
    const path = `${user!.id}/avatar-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from("photos-profil").upload(path, file, { upsert: true });
    if (error) return toast.error(error.message);
    const { data: signed } = await supabase.storage.from("photos-profil").createSignedUrl(path, 60 * 60 * 24 * 365);
    await supabase.from("profiles").update({ photo_url: signed?.signedUrl }).eq("id", user!.id);
    toast.success("🖼️ Photo mise à jour avec succès !");
    qc.invalidateQueries({ queryKey: ["current-user"] });
    qc.invalidateQueries({ queryKey: ["profile-full"] });
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/" });
  };

  if (!user || !profile) return null;

  const isAdmin = user.role === "admin";

  return (
    <div className="space-y-6 max-w-3xl">
      {/* ===== EN-TÊTE ===== */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold flex items-center gap-2">
            {isAdmin && <Shield className="w-6 h-6 text-primary" />}
            Mon profil
          </h1>
          <p className="text-muted-foreground">
            {isAdmin ? "Gérez vos informations administrateur" : "Gérez vos informations personnelles"}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={isAdmin ? "default" : "outline"}>
            {isAdmin ? "Administrateur" : "Employé"}
          </Badge>
          <Button variant="ghost" size="sm" onClick={handleLogout} className="text-destructive hover:text-destructive">
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* ===== PHOTO & IDENTITÉ ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="w-4 h-4" />
            Photo et identité
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-6">
          <Avatar className="w-24 h-24 border-2 border-muted">
            <AvatarImage src={profile.photo_url ?? undefined} />
            <AvatarFallback className="text-2xl">{initials(user)}</AvatarFallback>
          </Avatar>
          <div>
            <div className="text-xl font-semibold">
              {profile.prenom} {profile.nom}
            </div>
            <div className="text-muted-foreground">
              {profile.poste || (isAdmin ? "Administrateur" : "Poste non défini")}
            </div>
            <div className="mt-2">
              <input type="file" id="photo" hidden accept="image/*" onChange={(e) => e.target.files?.[0] && uploadPhoto(e.target.files[0])} />
              <Button asChild variant="outline" size="sm">
                <label htmlFor="photo" className="cursor-pointer">
                  <Upload className="w-4 h-4 mr-2" />Changer
                </label>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ===== INFORMATIONS PERSONNELLES ===== */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <User className="w-4 h-4" />
            Informations personnelles
          </CardTitle>
          {!isEditing ? (
            <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
              <Edit2 className="w-4 h-4 mr-2" />
              Modifier
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => {
                setIsEditing(false);
                setForm(profile);
              }}>
                <X className="w-4 h-4 mr-1" />
                Annuler
              </Button>
              <Button variant="outline" size="sm" onClick={save} disabled={saving}>
                <Save className="w-4 h-4 mr-1" />
                {saving ? "Enregistrement..." : "Enregistrer"}
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          <form className="space-y-4">
            {/* Prénom & Nom */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Prénom</Label>
                <Input 
                  value={form.prenom ?? ""} 
                  onChange={(e) => setForm({ ...form, prenom: e.target.value })}
                  disabled={!isEditing}
                  className={!isEditing ? "bg-muted/30" : ""}
                />
              </div>
              <div className="space-y-2">
                <Label>Nom</Label>
                <Input 
                  value={form.nom ?? ""} 
                  onChange={(e) => setForm({ ...form, nom: e.target.value })}
                  disabled={!isEditing}
                  className={!isEditing ? "bg-muted/30" : ""}
                />
              </div>
            </div>

            {/* Email (non modifiable) */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Mail className="w-4 h-4" />
                Email
              </Label>
              <Input value={profile.email} disabled className="bg-muted/50" />
              <p className="text-xs text-muted-foreground">L'email ne peut pas être modifié</p>
            </div>

            {/* Téléphone */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Phone className="w-4 h-4" />
                Téléphone
              </Label>
              <Input 
                value={form.telephone ?? ""} 
                onChange={(e) => setForm({ ...form, telephone: e.target.value })}
                disabled={!isEditing}
                placeholder="+216 00 000 000"
                className={!isEditing ? "bg-muted/30" : ""}
              />
            </div>

            {/* WhatsApp */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-green-500" />
                WhatsApp
              </Label>
              <Input 
                value={form.whatsapp ?? ""} 
                onChange={(e) => setForm({ ...form, whatsapp: e.target.value })}
                disabled={!isEditing}
                placeholder="+216 00 000 000"
                className={!isEditing ? "bg-muted/30" : ""}
              />
            </div>

            {/* Adresse */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <MapPin className="w-4 h-4" />
                Adresse
              </Label>
              <Input 
                value={form.adresse ?? ""} 
                onChange={(e) => setForm({ ...form, adresse: e.target.value })}
                disabled={!isEditing}
                placeholder="Votre adresse complète"
                className={!isEditing ? "bg-muted/30" : ""}
              />
            </div>

            {/* Date de naissance */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                Date de naissance
              </Label>
              <Input 
                type="date"
                value={form.date_naissance ?? ""} 
                onChange={(e) => setForm({ ...form, date_naissance: e.target.value })}
                disabled={!isEditing}
                className={!isEditing ? "bg-muted/30" : ""}
              />
            </div>

            {/* Poste & Département - Admin seulement */}
            {isAdmin && (
              <div className="grid grid-cols-2 gap-4 pt-2 border-t">
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Briefcase className="w-4 h-4" />
                    Poste
                  </Label>
                  <Input 
                    value={form.poste ?? "Administrateur"} 
                    onChange={(e) => setForm({ ...form, poste: e.target.value })}
                    disabled={!isEditing}
                    className={!isEditing ? "bg-muted/30" : ""}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Building className="w-4 h-4" />
                    Département
                  </Label>
                  <Input 
                    value={form.departement ?? "Administration"} 
                    onChange={(e) => setForm({ ...form, departement: e.target.value })}
                    disabled={!isEditing}
                    className={!isEditing ? "bg-muted/30" : ""}
                  />
                </div>
              </div>
            )}

            {/* Poste & Département - Employés (lecture seule) */}
            {!isAdmin && (
              <div className="grid grid-cols-2 gap-4 pt-2 border-t">
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Briefcase className="w-4 h-4" />
                    Poste
                  </Label>
                  <Input value={profile.poste ?? "—"} disabled className="bg-muted/30" />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Building className="w-4 h-4" />
                    Département
                  </Label>
                  <Input value={profile.departement ?? "—"} disabled className="bg-muted/30" />
                </div>
              </div>
            )}

            {!isEditing && (
              <div className="text-sm text-muted-foreground flex items-center gap-2">
                <span>🔒</span>
                {isAdmin ? "Cliquez sur 'Modifier' pour changer vos informations" : "Certaines informations sont gérées par l'administrateur"}
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      {/* ===== CHANGER LE MOT DE PASSE ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="w-5 h-5" />
            Sécurité
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label>Nouveau mot de passe</Label>
            <div className="relative">
              <Input 
                type={showPassword ? "text" : "password"} 
                value={password} 
                onChange={(e) => setPassword(e.target.value)} 
                minLength={6} 
                placeholder="Min. 6 caractères"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <Button onClick={changerMDP} variant="outline" disabled={!password}>
            Mettre à jour le mot de passe
          </Button>
          <p className="text-xs text-muted-foreground">
            🔐 Utilisez un mot de passe fort et unique
          </p>
        </CardContent>
      </Card>

      {/* ===== STATUT ADMIN ===== */}
      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Informations administrateur
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 grid-cols-2 text-sm">
              <div>
                <span className="text-muted-foreground">Rôle</span>
                <p className="font-medium flex items-center gap-1">
                  <CheckCircle className="w-3 h-3 text-green-500" />
                  Administrateur
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Accès</span>
                <p className="font-medium text-primary">Total</p>
              </div>
              <div>
                <span className="text-muted-foreground">Compte créé</span>
                <p className="font-medium">
                  {profile.created_at 
                    ? new Date(profile.created_at).toLocaleDateString("fr-FR", {
                        day: "2-digit",
                        month: "2-digit",
                        year: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit"
                      })
                    : "—"}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Statut</span>
                <p className="font-medium text-green-600 flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" />
                  Actif
                </p>
              </div>
            </div>

            <Separator className="my-4" />
            
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Actions rapides</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href="/admin/employes">👥 Gérer les employés</a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href="/admin/dashboard">📊 Tableau de bord</a>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}