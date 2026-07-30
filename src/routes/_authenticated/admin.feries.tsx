import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentUser } from "@/lib/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { formatDateFR } from "@/lib/format";
import { Trash2, Plus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/feries")({
  beforeLoad: async () => {
    const u = await fetchCurrentUser();
    if (!u || u.role !== "admin") throw new Error("Accès admin requis");
  },
  component: AdminFeries,
});

function AdminFeries() {
  const qc = useQueryClient();
  const [date, setDate] = useState("");
  const [libelle, setLibelle] = useState("");
  const [recurrent, setRecurrent] = useState(false);

  const { data: feries = [] } = useQuery({
    queryKey: ["feries-list"],
    queryFn: async () => (await supabase.from("jours_feries").select("*").order("date")).data ?? [],
  });

  const ajouter = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.from("jours_feries").insert({ date, libelle, recurrent });
    if (error) return toast.error(error.message);
    toast.success("Ajouté");
    setDate(""); setLibelle(""); setRecurrent(false);
    qc.invalidateQueries({ queryKey: ["feries-list"] });
  };

  const supprimer = async (id: string) => {
    if (!confirm("Supprimer ?")) return;
    await supabase.from("jours_feries").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["feries-list"] });
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl md:text-3xl font-semibold">Jours fériés</h1>
        <p className="text-muted-foreground">Gérez le calendrier des jours fériés (fêtes religieuses à ajouter chaque année)</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Ajouter un jour férié</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={ajouter} className="grid gap-3 md:grid-cols-4 md:items-end">
            <div className="space-y-2"><Label>Date</Label><Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="space-y-2 md:col-span-2"><Label>Libellé</Label><Input required value={libelle} onChange={(e) => setLibelle(e.target.value)} placeholder="Aïd El Fitr" /></div>
            <div className="space-y-2 flex flex-col">
              <Label>Récurrent</Label>
              <div className="h-10 flex items-center"><Checkbox checked={recurrent} onCheckedChange={(v) => setRecurrent(!!v)} /></div>
            </div>
            <Button type="submit" className="md:col-span-4"><Plus className="w-4 h-4 mr-2" />Ajouter</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Liste ({feries.length})</CardTitle></CardHeader>
        <CardContent>
          <div className="divide-y">
            {feries.map((f) => (
              <div key={f.id} className="py-3 flex items-center justify-between">
                <div>
                  <div className="font-medium">{f.libelle}</div>
                  <div className="text-sm text-muted-foreground">{formatDateFR(f.date)}</div>
                </div>
                <div className="flex items-center gap-2">
                  {f.recurrent && <Badge variant="outline">Fixe</Badge>}
                  <Button variant="ghost" size="icon" onClick={() => supprimer(f.id)}><Trash2 className="w-4 h-4" /></Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
