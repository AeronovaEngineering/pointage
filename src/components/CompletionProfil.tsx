import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { 
  User, Mail, Phone, MapPin, Heart, CreditCard, 
  Calendar, IdCard, MessageCircle, AlertCircle,
  CheckCircle, ArrowRight, ArrowLeft, Upload,
  Building, Users, Briefcase, Home
} from "lucide-react";
import { formatDateFR } from "@/lib/format";
// Ajouter en haut du fichier
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

interface CompletionProfilProps {
  open: boolean;
  onComplete: () => void;
  userId: string;
  userEmail: string;
  userData: any;
}

export function CompletionProfil({ 
  open, 
  onComplete, 
  userId, 
  userEmail,
  userData 
}: CompletionProfilProps) {
  const qc = useQueryClient();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(33);
  
  // Données du formulaire
  const [formData, setFormData] = useState({
    // Step 1 - Identité & Contact
    photo_url: "",
    prenom: userData?.prenom || "",
    nom: userData?.nom || "",
    telephone: userData?.telephone || "",
    email_personnel: userData?.email_personnel || "",
    whatsapp: userData?.whatsapp || "",
    adresse: userData?.adresse || "",
    date_naissance: userData?.date_naissance || "",
    nationalite: userData?.nationalite || "",
    
    // Step 2 - Infos administratives
    cni: userData?.cni || "",
    rib: userData?.rib || "",
    urgence_nom: userData?.urgence_nom || "",
    urgence_relation: userData?.urgence_relation || "",
    urgence_telephone: userData?.urgence_telephone || "",
    mutuelle: userData?.mutuelle || "",
    num_secu: userData?.num_secu || "",
    groupe_sanguin: userData?.groupe_sanguin || "",
    allergies: userData?.allergies || "",
    
    // Step 3 - Profil professionnel
    poste: userData?.poste || "",
    departement: userData?.departement || "",
    manager: userData?.manager || "",
    type_contrat: userData?.type_contrat || "CDI",
    politique_horaire: userData?.politique_horaire || "Standard (35h/semaine)",
  });

  // Mise à jour du progrès
  useEffect(() => {
    setProgress(step === 1 ? 33 : step === 2 ? 66 : 100);
  }, [step]);

  const handleChange = (field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${userId}-${Date.now()}.${fileExt}`;
      const filePath = `photos/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('profiles')
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('profiles')
        .getPublicUrl(filePath);

      handleChange('photo_url', publicUrl);
      toast.success("Photo téléchargée avec succès");
    } catch (error) {
      console.error('Upload error:', error);
      toast.error("Erreur lors du téléchargement de la photo");
    }
  };

  const validateStep = () => {
    if (step === 1) {
      // Vérifier les champs obligatoires
      if (!formData.prenom || !formData.nom) {
        toast.error("Le prénom et le nom sont obligatoires");
        return false;
      }
      if (!formData.telephone) {
        toast.error("Le numéro de téléphone est obligatoire");
        return false;
      }
      if (!formData.adresse) {
        toast.error("L'adresse est obligatoire");
        return false;
      }
      if (!formData.date_naissance) {
        toast.error("La date de naissance est obligatoire");
        return false;
      }
      return true;
    }
    
    if (step === 2) {
      // Vérifier les champs obligatoires
      if (!formData.cni) {
        toast.error("Le numéro CNI est obligatoire");
        return false;
      }
      if (!formData.rib) {
        toast.error("Le RIB est obligatoire");
        return false;
      }
      if (!formData.urgence_nom || !formData.urgence_telephone) {
        toast.error("Les coordonnées de contact d'urgence sont obligatoires");
        return false;
      }
      return true;
    }
    
    if (step === 3) {
      // Vérifier les champs obligatoires
      if (!formData.poste) {
        toast.error("Le poste est obligatoire");
        return false;
      }
      if (!formData.departement) {
        toast.error("Le département est obligatoire");
        return false;
      }
      return true;
    }
    
    return true;
  };

  const nextStep = () => {
    if (validateStep()) {
      if (step < 3) {
        setStep(step + 1);
      }
    }
  };

  const prevStep = () => {
    if (step > 1) {
      setStep(step - 1);
    }
  };

  const submitForm = async () => {
    if (!validateStep()) return;
    
    setLoading(true);
    try {
      // Mettre à jour le profil
      const { error } = await supabase
        .from("profiles")
        .update({
          photo_url: formData.photo_url || null,
          prenom: formData.prenom,
          nom: formData.nom,
          telephone: formData.telephone,
          email_personnel: formData.email_personnel || null,
          whatsapp: formData.whatsapp || null,
          adresse: formData.adresse,
          date_naissance: formData.date_naissance,
          nationalite: formData.nationalite || null,
          cni: formData.cni,
          rib: formData.rib,
          urgence_nom: formData.urgence_nom,
          urgence_relation: formData.urgence_relation || null,
          urgence_telephone: formData.urgence_telephone,
          mutuelle: formData.mutuelle || null,
          num_secu: formData.num_secu || null,
          groupe_sanguin: formData.groupe_sanguin || null,
          allergies: formData.allergies || null,
          poste: formData.poste,
          departement: formData.departement,
          manager: formData.manager || null,
          type_contrat: formData.type_contrat,
          politique_horaire: formData.politique_horaire,
          // Marquer le profil comme complété
          profil_completed: true
        })
        .eq("id", userId);

      if (error) throw error;

      toast.success("Profil complété avec succès !");
      qc.invalidateQueries({ queryKey: ["current-user"] });
      onComplete();
    } catch (error: any) {
      console.error('Submit error:', error);
      toast.error(error.message || "Erreur lors de l'enregistrement");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] overflow-y-auto"
        hideClose
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="space-y-3">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-xl font-bold">
              Complétez votre profil
            </DialogTitle>
            <Badge variant="outline" className="text-xs">
              Étape {step}/3
            </Badge>
          </div>
          <DialogDescription>
            Veuillez remplir toutes les informations obligatoires pour finaliser votre compte.
            Cette étape est nécessaire pour continuer.
          </DialogDescription>
          <Progress value={progress} className="h-2" />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span className={step >= 1 ? "text-primary font-medium" : ""}>
              {step === 1 && "⏳"} Identité & Contact
            </span>
            <span className={step >= 2 ? "text-primary font-medium" : ""}>
              {step === 2 && "⏳"} Infos admin & Urgence
            </span>
            <span className={step >= 3 ? "text-primary font-medium" : ""}>
              {step === 3 && "⏳"} Profil professionnel
            </span>
          </div>
        </DialogHeader>

        {/* Étape 1 - Identité & Contact */}
        {step === 1 && (
          <div className="space-y-4 py-4">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <User className="w-4 h-4" />
              Identité et coordonnées
            </div>

            {/* Photo */}
            <div className="flex items-center gap-4 p-4 border rounded-lg">
              <Avatar className="w-20 h-20">
                <AvatarImage src={formData.photo_url || undefined} />
                <AvatarFallback className="text-2xl">
                  {formData.prenom?.[0]}{formData.nom?.[0]}
                </AvatarFallback>
              </Avatar>
              <div>
                <Label htmlFor="photo" className="cursor-pointer">
                  <div className="flex items-center gap-2 px-4 py-2 border rounded-lg hover:bg-muted transition-colors">
                    <Upload className="w-4 h-4" />
                    <span>Télécharger une photo</span>
                  </div>
                  <Input
                    id="photo"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handlePhotoUpload}
                  />
                </Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Format : JPG, PNG (max 5MB)
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Prénom *</Label>
                <Input
                  value={formData.prenom}
                  onChange={(e) => handleChange('prenom', e.target.value)}
                  placeholder="Votre prénom"
                />
              </div>
              <div className="space-y-2">
                <Label>Nom *</Label>
                <Input
                  value={formData.nom}
                  onChange={(e) => handleChange('nom', e.target.value)}
                  placeholder="Votre nom"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Email personnel</Label>
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-muted-foreground" />
                <Input
                  type="email"
                  value={formData.email_personnel}
                  onChange={(e) => handleChange('email_personnel', e.target.value)}
                  placeholder="Email personnel (optionnel)"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Téléphone *</Label>
                <div className="flex items-center gap-2">
                  <Phone className="w-4 h-4 text-muted-foreground" />
                  <Input
                    type="tel"
                    value={formData.telephone}
                    onChange={(e) => handleChange('telephone', e.target.value)}
                    placeholder="+216 00 000 000"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>WhatsApp (optionnel)</Label>
                <div className="flex items-center gap-2">
                  <MessageCircle className="w-4 h-4 text-green-500" />
                  <Input
                    type="tel"
                    value={formData.whatsapp}
                    onChange={(e) => handleChange('whatsapp', e.target.value)}
                    placeholder="+216 00 000 000"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Adresse *</Label>
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-muted-foreground" />
                <Input
                  value={formData.adresse}
                  onChange={(e) => handleChange('adresse', e.target.value)}
                  placeholder="Votre adresse complète"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Date de naissance *</Label>
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-muted-foreground" />
                  <Input
                    type="date"
                    value={formData.date_naissance}
                    onChange={(e) => handleChange('date_naissance', e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Nationalité (optionnel)</Label>
                <Input
                  value={formData.nationalite}
                  onChange={(e) => handleChange('nationalite', e.target.value)}
                  placeholder="Tunisienne, Française, etc."
                />
              </div>
            </div>
          </div>
        )}

        {/* Étape 2 - Infos admin & Urgence */}
        {step === 2 && (
          <div className="space-y-4 py-4">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <IdCard className="w-4 h-4" />
              Documents et sécurité
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Numéro CNI / CIN *</Label>
                <div className="flex items-center gap-2">
                  <IdCard className="w-4 h-4 text-muted-foreground" />
                  <Input
                    value={formData.cni}
                    onChange={(e) => handleChange('cni', e.target.value)}
                    placeholder="12345678"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>RIB *</Label>
                <div className="flex items-center gap-2">
                  <CreditCard className="w-4 h-4 text-muted-foreground" />
                  <Input
                    value={formData.rib}
                    onChange={(e) => handleChange('rib', e.target.value)}
                    placeholder="XX XXX XXX XXX XXXXXXXXXXXX XX"
                  />
                </div>
              </div>
            </div>

            <Separator className="my-4" />
            
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <Heart className="w-4 h-4" />
              Contact d'urgence
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Nom du contact *</Label>
                <Input
                  value={formData.urgence_nom}
                  onChange={(e) => handleChange('urgence_nom', e.target.value)}
                  placeholder="Nom complet"
                />
              </div>
              <div className="space-y-2">
                <Label>Relation *</Label>
                <Input
                  value={formData.urgence_relation}
                  onChange={(e) => handleChange('urgence_relation', e.target.value)}
                  placeholder="Conjoint, Parent, Ami..."
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Téléphone d'urgence *</Label>
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-muted-foreground" />
                <Input
                  type="tel"
                  value={formData.urgence_telephone}
                  onChange={(e) => handleChange('urgence_telephone', e.target.value)}
                  placeholder="+216 00 000 000"
                />
              </div>
            </div>

            <Separator className="my-4" />

            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <AlertCircle className="w-4 h-4" />
              Santé
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Mutuelle (optionnel)</Label>
                <Input
                  value={formData.mutuelle}
                  onChange={(e) => handleChange('mutuelle', e.target.value)}
                  placeholder="Nom de la mutuelle"
                />
              </div>
              <div className="space-y-2">
                <Label>Numéro sécurité sociale (optionnel)</Label>
                <Input
                  value={formData.num_secu}
                  onChange={(e) => handleChange('num_secu', e.target.value)}
                  placeholder="Numéro SS"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Groupe sanguin (optionnel)</Label>
                <Input
                  value={formData.groupe_sanguin}
                  onChange={(e) => handleChange('groupe_sanguin', e.target.value)}
                  placeholder="A+, B-, O+, etc."
                />
              </div>
              <div className="space-y-2">
                <Label>Allergies (optionnel)</Label>
                <Input
                  value={formData.allergies}
                  onChange={(e) => handleChange('allergies', e.target.value)}
                  placeholder="Aucune, Penicilline, etc."
                />
              </div>
            </div>
          </div>
        )}

        {/* Étape 3 - Profil professionnel */}
        {step === 3 && (
          <div className="space-y-4 py-4">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <Briefcase className="w-4 h-4" />
              Poste et organisation
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Poste *</Label>
                <div className="flex items-center gap-2">
                  <Briefcase className="w-4 h-4 text-muted-foreground" />
                  <Input
                    value={formData.poste}
                    onChange={(e) => handleChange('poste', e.target.value)}
                    placeholder="Développeur Senior, etc."
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Département *</Label>
                <div className="flex items-center gap-2">
                  <Building className="w-4 h-4 text-muted-foreground" />
                  <Input
                    value={formData.departement}
                    onChange={(e) => handleChange('departement', e.target.value)}
                    placeholder="R&D, Ventes, etc."
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Manager / Superviseur (optionnel)</Label>
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-muted-foreground" />
                <Input
                  value={formData.manager}
                  onChange={(e) => handleChange('manager', e.target.value)}
                  placeholder="Nom de votre manager"
                />
              </div>
            </div>

            <Separator className="my-4" />

            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <Home className="w-4 h-4" />
              Contrat et horaires
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Type de contrat</Label>
                <select
                  className="w-full p-2 border rounded-lg bg-background"
                  value={formData.type_contrat}
                  onChange={(e) => handleChange('type_contrat', e.target.value)}
                >
                  <option value="CDI">CDI</option>
                  <option value="CDD">CDD</option>
                  <option value="Intern">Stagiaire</option>
                  <option value="Freelance">Freelance</option>
                  <option value="CIVP">CIVP</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>Politique horaire</Label>
                <select
                  className="w-full p-2 border rounded-lg bg-background"
                  value={formData.politique_horaire}
                  onChange={(e) => handleChange('politique_horaire', e.target.value)}
                >
                  <option value="Standard (35h/semaine)">Standard (35h/semaine)</option>
                  <option value="Flexible">Flexible</option>
                  <option value="Night shift">Night shift</option>
                  <option value="40h/semaine">40h/semaine</option>
                </select>
              </div>
            </div>

            <div className="p-4 bg-muted rounded-lg text-sm">
              <div className="flex items-start gap-2">
                <CheckCircle className="w-4 h-4 text-green-500 mt-0.5" />
                <div>
                  <p className="font-medium">Votre profil est presque complet !</p>
                  <p className="text-muted-foreground">
                    Une fois validé, vous pourrez accéder à toutes les fonctionnalités
                    de l'application de pointage.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            {step > 1 && (
              <Button type="button" variant="outline" onClick={prevStep} disabled={loading}>
                <ArrowLeft className="w-4 h-4 mr-2" />
                Précédent
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            {step < 3 ? (
              <Button type="button" onClick={nextStep}>
                Suivant
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            ) : (
              <Button 
                type="button" 
                onClick={submitForm} 
                disabled={loading}
                className="bg-green-600 hover:bg-green-700"
              >
                {loading ? "Enregistrement..." : "Terminer"}
                {!loading && <CheckCircle className="w-4 h-4 ml-2" />}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}