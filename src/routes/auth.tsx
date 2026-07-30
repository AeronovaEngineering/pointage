import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentUser } from "@/lib/current-user";
import { CompletionProfil } from '@/components/CompletionProfil';
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({ ssr: false, component: AuthPage });

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetMode, setResetMode] = useState(false);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;

      // Vérifier si le compte est actif
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("actif")
        .eq("id", data.user.id)
        .single();

      // Si le profil est trouvé et actif est false, déconnecter l'utilisateur
      if (profile && profile.actif === false) {
        await supabase.auth.signOut();
        toast.error("Votre compte est désactivé. Contactez votre administrateur.");
        return;
      }

      navigate({ to: "/dashboard" });
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + "/reset-password",
      });
      if (error) throw error;
      toast.success("Lien envoyé, vérifiez votre boîte mail");
      setResetMode(false);
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 card-elevated p-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Pointage Pro</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {resetMode ? "Réinitialisation du mot de passe" : "Connexion"}
          </p>
        </div>

        {!resetMode ? (
          <form onSubmit={handleSignIn} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="exemple@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Mot de passe</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Connexion..." : "Se connecter"}
            </Button>
            <button
              type="button"
              onClick={() => setResetMode(true)}
              className="w-full text-sm text-muted-foreground hover:text-primary transition-colors"
            >
              Mot de passe oublié ?
            </button>
          </form>
        ) : (
          <form onSubmit={handleResetPassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="reset-email">Email</Label>
              <Input
                id="reset-email"
                type="email"
                placeholder="exemple@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Envoi..." : "Envoyer le lien"}
            </Button>
            <button
              type="button"
              onClick={() => setResetMode(false)}
              className="w-full text-sm text-muted-foreground hover:text-primary transition-colors"
            >
              Retour
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [showCompletion, setShowCompletion] = useState(false);
  const [currentUser, setCurrentUser] = useState<any>(null);

  const { data: user, isLoading } = useQuery({
    queryKey: ["current-user"],
    queryFn: fetchCurrentUser,
  });

  useEffect(() => {
    if (user) {
      setCurrentUser(user);
      // Vérifier si le profil doit être complété
      // L'admin n'a pas besoin de compléter son profil
      if (user.role !== "admin" && !user.profil_completed) {
        setShowCompletion(true);
      }
    }
  }, [user]);

  const handleCompletionComplete = () => {
    setShowCompletion(false);
    // Rafraîchir les données de l'utilisateur
    window.location.reload();
  };

  if (isLoading) {
    return <div>Chargement...</div>;
  }

  return (
    <>
      {children}
      <CompletionProfil
        open={showCompletion}
        onComplete={handleCompletionComplete}
        userId={currentUser?.id}
        userEmail={currentUser?.email}
        userData={currentUser}
      />
    </>
  );
}