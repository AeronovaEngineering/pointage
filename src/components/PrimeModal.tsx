import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";

interface PrimeModalProps {
  employee: any;
  onClose: () => void;
  onSuccess: () => void;
}

export function PrimeModal({ employee, onClose, onSuccess }: PrimeModalProps) {
  const [montant, setMontant] = useState("");
  const [commentaire, setCommentaire] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!montant || parseFloat(montant) <= 0) {
      setError("Veuillez entrer un montant valide");
      return;
    }

    setError("");
    setLoading(true);
    try {
      // Use the donner_prime function from Claude's migration
      const { data, error: functionError } = await supabase
        .rpc('donner_prime', {
          _user_id: employee.id,
          _montant: parseFloat(montant),
          _commentaire: commentaire || null
        });

      if (functionError) throw functionError;

      onSuccess();
      onClose();
    } catch (error: any) {
      console.error(error);
      setError(error.message || "Impossible d'attribuer la prime");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Attribuer une prime</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <Label>Employé</Label>
            <div className="text-sm font-medium mt-1">{employee.prenom} {employee.nom}</div>
          </div>
          <div>
            <Label htmlFor="montant">Montant (DT)</Label>
            <Input
              id="montant"
              type="number"
              step="1"
              min="0"
              value={montant}
              onChange={(e) => {
                setMontant(e.target.value);
                setError("");
              }}
              placeholder="0"
            />
          </div>
          <div>
            <Label htmlFor="commentaire">Commentaire (optionnel)</Label>
            <Textarea
              id="commentaire"
              value={commentaire}
              onChange={(e) => setCommentaire(e.target.value)}
              placeholder="Raison de la prime..."
              rows={3}
            />
          </div>
          {error && (
            <div className="text-sm text-red-500 bg-red-50 p-2 rounded border border-red-200">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? "Attribution..." : "Attribuer la prime"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}