// src/lib/whatsapp.ts

interface WhatsAppResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

export class WhatsAppService {
  // Envoyer une alerte d'absence
  static async sendAbsenceAlert(
    employeeName: string,
    employeeEmail: string,
    date: string
  ): Promise<WhatsAppResponse> {
    try {
      const response = await fetch("/.netlify/functions/send-whatsapp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "absence",
          employeeName,
          employeeEmail,
          date,
        }),
      });

      return await response.json();
    } catch (error: any) {
      console.error("Erreur WhatsApp:", error);
      return { success: false, error: error.message };
    }
  }
  
  // Envoyer une notification de demande
  static async sendDemandeNotification(
    employeeName: string,
    demandeType: string,
    details: string,
    date?: string
  ): Promise<WhatsAppResponse> {
    try {
      const response = await fetch("/.netlify/functions/send-whatsapp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "demande",
          employeeName,
          demandeType,
          details,
          date: date || new Date().toLocaleDateString("fr-FR"),
        }),
      });

      return await response.json();
    } catch (error: any) {
      console.error("Erreur WhatsApp:", error);
      return { success: false, error: error.message };
    }
  }

  // Tester la connexion WhatsApp
  static async test(): Promise<WhatsAppResponse> {
    try {
      const response = await fetch("/.netlify/functions/send-whatsapp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "test",
        }),
      });

      return await response.json();
    } catch (error: any) {
      console.error("Erreur WhatsApp:", error);
      return { success: false, error: error.message };
    }
  }

  // Envoyer un message personnalisé (admin seulement)
  static async sendMessage(to: string, message: string): Promise<WhatsAppResponse> {
    try {
      const response = await fetch("/.netlify/functions/send-whatsapp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "message",
          to,
          message,
        }),
      });

      return await response.json();
    } catch (error: any) {
      console.error("Erreur WhatsApp:", error);
      return { success: false, error: error.message };
    }
  }
}
export const whatsappService = WhatsAppService;