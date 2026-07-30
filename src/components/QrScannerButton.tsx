import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { QrCode, Loader2, CameraOff } from "lucide-react";
import { toast } from "sonner";
import { pointerArriveeAvecPosition } from "@/lib/pointage-arrivee";

// Uses the native browser BarcodeDetector API (no external library / no npm install needed).
// Supported on Chrome/Edge/Android out of the box. Not yet supported on all Safari/iOS versions —
// see the fallback message below for those cases.
declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats: string[] }) => {
      detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
    };
  }
}

export function QrScannerButton({ onArrivee }: { onArrivee?: () => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"starting" | "scanning" | "unsupported" | "denied" | "checking">("starting");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>();

  const stop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    if (!open) {
      stop();
      return;
    }

    if (!("BarcodeDetector" in window)) {
      setStatus("unsupported");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStatus("scanning");

        const detector = new window.BarcodeDetector!({ formats: ["qr_code"] });
        const scan = async () => {
          if (!videoRef.current || cancelled) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0) {
              const value = codes[0].rawValue;
              handleDetected(value);
              return;
            }
          } catch {
            // ignore transient decode errors, keep scanning
          }
          rafRef.current = requestAnimationFrame(scan);
        };
        rafRef.current = requestAnimationFrame(scan);
      } catch {
        if (!cancelled) setStatus("denied");
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleDetected = async (value: string) => {
    let isOfficeCode = false;
    try {
      const url = new URL(value, window.location.origin);
      isOfficeCode = url.origin === window.location.origin && url.pathname === "/pointage-scan";
    } catch {
      isOfficeCode = false;
    }
    if (!isOfficeCode) {
      toast.error("QR code non reconnu. Scannez le code affiché au bureau.");
      return;
    }

    stop();
    setStatus("checking");
    const result = await pointerArriveeAvecPosition();
    setOpen(false);

    if (result.status === "success") {
      toast.success(`Arrivée pointée${result.heure ? ` à ${result.heure}` : ""} !`);
      onArrivee?.();
    } else if (result.status === "already") {
      toast.info("Vous avez déjà pointé votre arrivée aujourd'hui.");
      onArrivee?.();
    } else if (result.status === "location_denied") {
      toast.error("Autorisez l'accès à votre position pour pointer votre arrivée depuis le bureau.");
    } else {
      toast.error(result.status === "error" ? result.message : "Erreur lors du pointage.");
    }
  };

  return (
    <>
      <Button variant="outline" className="w-full" onClick={() => setOpen(true)}>
        <QrCode className="w-4 h-4 mr-2" />
        Scanner le QR code d'arrivée
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Scanner le QR code</DialogTitle>
          </DialogHeader>

          {status === "unsupported" && (
            <div className="flex flex-col items-center gap-3 py-6 text-center text-sm text-muted-foreground">
              <CameraOff className="w-8 h-8" />
              <p>
                Le scan intégré n'est pas supporté par ce navigateur. Ouvrez l'appareil photo de votre
                téléphone et visez directement le QR code affiché au bureau.
              </p>
            </div>
          )}

          {status === "denied" && (
            <div className="flex flex-col items-center gap-3 py-6 text-center text-sm text-muted-foreground">
              <CameraOff className="w-8 h-8" />
              <p>Accès à la caméra refusé ou indisponible. Autorisez la caméra dans les réglages du navigateur puis réessayez.</p>
            </div>
          )}

          {status === "checking" && (
            <div className="flex flex-col items-center gap-3 py-6 text-center text-sm text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin" />
              <p>Vérification de votre position et enregistrement…</p>
            </div>
          )}

          <div className={status === "scanning" || status === "starting" ? "block" : "hidden"}>
            <div className="relative rounded-md overflow-hidden bg-black aspect-square">
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
              {status === "starting" && (
                <div className="absolute inset-0 flex items-center justify-center text-white">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              )}
              <div className="absolute inset-8 border-2 border-white/70 rounded-lg pointer-events-none" />
            </div>
            <p className="text-xs text-muted-foreground text-center mt-2">Visez le QR code affiché au bureau</p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
