import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  Printer,
  FileText,
  Settings,
  History,
  Pencil,
  Menu,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useTranslation } from "react-i18next";

const navItems = [
  { path: "/", icon: Pencil, labelKey: "nav.designer" },
  { path: "/print", icon: Printer, labelKey: "nav.print" },
  { path: "/printers", icon: FileText, labelKey: "nav.printers" },
  { path: "/history", icon: History, labelKey: "nav.history" },
  { path: "/settings", icon: Settings, labelKey: "nav.settings" },
] as const;

function isActivePath(currentPath: string, itemPath: string): boolean {
  if (itemPath === "/") return currentPath === "/" || currentPath.startsWith("/template");
  return currentPath.startsWith(itemPath);
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile drawer whenever route changes
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  const handleNavigate = (path: string) => {
    navigate(path);
    setMobileMenuOpen(false);
  };

  const NavList = ({ variant = "desktop" as "desktop" | "mobile" }) => (
    <nav
      className={cn(
        "flex flex-col gap-1",
        variant === "desktop" ? "p-4" : "p-2",
      )}
    >
      {navItems.map((item) => {
        const active = isActivePath(location.pathname, item.path);
        return (
          <Button
            key={item.path}
            variant={active ? "secondary" : "ghost"}
            className={cn(
              "w-full justify-start gap-3 touch-target min-h-11",
              active && "bg-secondary font-medium",
            )}
            onClick={() => handleNavigate(item.path)}
            aria-current={active ? "page" : undefined}
            type="button"
          >
            <item.icon className="h-5 w-5" />
            {t(item.labelKey)}
          </Button>
        );
      })}
    </nav>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-64 flex-col border-r bg-card">
        <div className="flex h-16 items-center gap-2 border-b px-6">
          <Printer className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold">PrintNinja</span>
        </div>
        <NavList variant="desktop" />
      </aside>

      {/* Mobile Bottom Navigation */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t bg-card"
        aria-label="Primary"
      >
        <div className="flex items-center justify-around h-16">
          {navItems.map((item) => {
            const active = isActivePath(location.pathname, item.path);
            return (
              <button
                key={item.path}
                type="button"
                onClick={() => handleNavigate(item.path)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 w-16 h-full text-xs transition-colors min-h-11",
                  active ? "text-primary font-medium" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <item.icon className="h-5 w-5" />
                <span>{t(item.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 left-0 right-0 z-50 flex h-16 items-center justify-between border-b bg-card px-4">
        <div className="flex items-center gap-2">
          <Printer className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold">PrintNinja</span>
        </div>
        <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" type="button" aria-label="Open menu">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-72 max-w-[80vw]">
            <div className="mt-4 flex flex-col gap-2">
              {navItems.map((item) => {
                const active = isActivePath(location.pathname, item.path);
                return (
                  <Button
                    key={item.path}
                    variant={active ? "secondary" : "ghost"}
                    className={cn("w-full justify-start gap-3", active && "font-medium")}
                    onClick={() => handleNavigate(item.path)}
                    type="button"
                    aria-current={active ? "page" : undefined}
                  >
                    <item.icon className="h-5 w-5" />
                    {t(item.labelKey)}
                    {active && <ChevronRight className="ml-auto h-4 w-4" />}
                  </Button>
                );
              })}
            </div>
          </SheetContent>
        </Sheet>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto pt-16 pb-16 md:pt-0 md:pb-0">
        <div className="container mx-auto p-4 md:p-8 max-w-7xl">
          {children}
        </div>
      </main>
    </div>
  );
}
