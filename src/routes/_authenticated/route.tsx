import { createFileRoute, redirect, Outlet, Link, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentUser, displayName, initials } from "@/lib/current-user";
import { CompletionProfil } from "@/components/CompletionProfil";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Clock, LayoutDashboard, Calendar, Users, FileCheck, LogOut, User, CalendarDays, Bell, QrCode } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: user } = useQuery({ queryKey: ["current-user"], queryFn: fetchCurrentUser });
  const { data: notifCount = 0 } = useQuery({
    queryKey: ["notif-count"],
    queryFn: async () => {
      const { count } = await supabase.from("notifications").select("*", { count: "exact", head: true }).eq("lue", false);
      return count ?? 0;
    },
    refetchInterval: 30000,
  });

  if (!user) return null;

  const needsCompletion = user.role !== "admin" && !user.profil_completed;

  const handleCompletionComplete = () => {
    qc.invalidateQueries({ queryKey: ["current-user"] });
  };

  const signOut = async () => {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    toast.success("Déconnecté");
    router.navigate({ to: "/auth", replace: true });
  };

  const isAdmin = user.role === "admin";
  const empNav = [
    { to: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
    { to: "/mes-demandes", label: "Mes demandes", icon: FileCheck },
    { to: "/profil", label: "Profil", icon: User },
  ];
  const adminNav = [
    { to: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
    { to: "/admin/calendrier", label: "Calendrier", icon: Calendar },
    { to: "/admin/employes", label: "Employés", icon: Users },
    { to: "/admin/demandes", label: "Demandes", icon: FileCheck },
    { to: "/admin/feries", label: "Jours fériés", icon: CalendarDays },
    { to: "/admin/qr-code", label: "QR Pointage", icon: QrCode },
    { to: "/profil", label: "Profil", icon: User },
  ];
  const nav = isAdmin ? adminNav : empNav;

  return (
    <div className={`min-h-screen flex bg-background${needsCompletion ? " pointer-events-none select-none" : ""}`}>
      <aside className="hidden md:flex md:w-64 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
        <div className="h-16 flex items-center gap-2 px-6 border-b border-sidebar-border">
          <div className="w-9 h-9 rounded-lg bg-sidebar-primary flex items-center justify-center">
            <Clock className="w-4 h-4 text-sidebar-primary-foreground" />
          </div>
          <div>
            <div className="font-semibold">Pointage Pro</div>
            <div className="text-xs text-sidebar-foreground/60">
              {isAdmin ? "Administrateur" : "Employé"}
            </div>
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
              activeProps={{ className: "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium bg-sidebar-accent text-sidebar-accent-foreground" }}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b bg-card flex items-center justify-between px-4 md:px-6 gap-4">
          <div className="md:hidden font-semibold flex items-center gap-2">
            <Clock className="w-4 h-4" /> Pointage Pro
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <Link to="/notifications">
              <Button variant="ghost" size="icon" className="relative">
                <Bell className="w-4 h-4" />
                {notifCount > 0 && (
                  <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-destructive text-destructive-foreground text-[10px] flex items-center justify-center">
                    {notifCount}
                  </span>
                )}
              </Button>
            </Link>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 h-10">
                  <Avatar className="w-8 h-8">
                    <AvatarImage src={user.photo_url ?? undefined} />
                    <AvatarFallback>{initials(user)}</AvatarFallback>
                  </Avatar>
                  <div className="text-left hidden sm:block">
                    <div className="text-sm font-medium leading-tight">{displayName(user)}</div>
                    <div className="text-xs text-muted-foreground leading-tight">{user.email}</div>
                  </div>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="flex flex-col">
                    <span>{displayName(user)}</span>
                    <Badge variant="outline" className="mt-1 w-fit">{isAdmin ? "Admin" : "Employé"}</Badge>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild><Link to="/profil"><User className="w-4 h-4 mr-2" />Mon profil</Link></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={signOut}><LogOut className="w-4 h-4 mr-2" />Se déconnecter</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <nav className="md:hidden bg-card border-b flex overflow-x-auto">
          {nav.map((item) => (
            <Link key={item.to} to={item.to} className="px-4 py-3 text-sm whitespace-nowrap text-muted-foreground"
              activeProps={{ className: "px-4 py-3 text-sm whitespace-nowrap text-primary border-b-2 border-primary font-medium" }}>
              {item.label}
            </Link>
          ))}
        </nav>

        <main className="flex-1 p-4 md:p-8 overflow-x-hidden">
          <Outlet />
        </main>
      </div>

      <CompletionProfil
        open={needsCompletion}
        onComplete={handleCompletionComplete}
        userId={user.id}
        userEmail={user.email}
        userData={user}
      />
    </div>
  );
}