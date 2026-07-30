import { WhatsAppService } from "./whatsapp";
import { supabase } from "@/integrations/supabase/client";

export class NotificationService {
  static async notifyAdmin(message: string, type: "notification" | "alert" | "report" = "notification") {
    try {
      // Récupérer l'admin via user_roles
      const { data: adminRole } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "admin")
        .single();

      if (!adminRole) {
        console.warn("Aucun admin trouvé");
        return;
      }

      const { data: adminProfile } = await supabase
        .from("profiles")
        .select("whatsapp, telephone")
        .eq("id", adminRole.user_id)
        .single();

      const phoneNumber = adminProfile?.whatsapp || adminProfile?.telephone;
      
      if (!phoneNumber) {
        console.warn("Aucun numéro WhatsApp configuré pour l'admin");
        return;
      }

      const service = new WhatsAppService();
      await service.sendMessage(phoneNumber, message);
    } catch (error) {
      console.error("Erreur d'envoi de notification:", error);
    }
  }
}