import { supabase } from "@/integrations/supabase/client";

export type ArriveeResult =
  | { status: "success"; heure: string | null }
  | { status: "already" }
  | { status: "location_denied" }
  | { status: "error"; message: string };

export function getPosition(): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  });
}

// Requests the device's GPS position (if available/authorized) and pointe l'arrivée.
// The distance-to-office check itself happens server-side in pointer_action, so this
// works whether the office location has been configured yet or not.
export async function pointerArriveeAvecPosition(): Promise<ArriveeResult> {
  const pos = await getPosition();

  const { data, error } = await supabase.rpc("pointer_action", {
    _action: "arrivee",
    _lat: pos?.coords.latitude ?? undefined,
    _lng: pos?.coords.longitude ?? undefined,
  });
  if (error) {
    if (error.message.includes("déjà pointé")) return { status: "already" };
    if (error.message.includes("Localisation requise")) return { status: "location_denied" };
    return { status: "error", message: error.message };
  }

  return { status: "success", heure: (data as { heure_pointage?: string } | null)?.heure_pointage ?? null };
}
