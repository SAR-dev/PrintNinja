import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  Printer,
  FileText,
  Settings,
  History,
  Pencil,
  Menu,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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

  const handleNavigate = (path: string) => {
    navigate(path);
    setMobileMenuOpen(false);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-64 flex-col border-r bg-card">
        <div className="flex h-16 items-center gap-2 border-b px-6">
          <Printer className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold">PrintNinja</span>
        </div>
        <nav className="flex-1 space-y-1 p-4">
          {navItems.map((item) => {
            const active = isActivePath(location.pathname, item.path);
            return (
              <Button
                key={item.path}
                variant={active ? "secondary" : "ghost"}
                className={cn(
                  "w-full justify-start gap-3",
                  active && "bg-secondary font-medium",
                )}
                onClick={() => handleNavigate(item.path)}
              >
                <item.icon className="h-5 w-5" />
                {t(item.labelKey)}
              </Button>
            );
          })}
        </nav>
      </aside>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t bg-card">
        <div className="flex items-center justify-around h-16">
          {navItems.map((item) => {
            const active = isActivePath(location.pathname, item.path);
            return (
              <button
                key={item.path}
                onClick={() => handleNavigate(item.path)}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 w-16 h-full text-xs transition-colors",
                  active
                    ? "text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground",
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
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        >
          {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>
      </header>

      {/* Mobile Sheet Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/50" onClick={() => setMobileMenuOpen(false)}>
          <div
            className="absolute right-0 top-16 h-full w-64 bg-card shadow-xl p-4 space-y-1"
            onClick={(e) => e.stopPropagation()}
          >
            {navItems.map((item) => {
              const active = isActivePath(location.pathname, item.path);
              return (
                <Button
                  key={item.path}
                  variant={active ? "secondary" : "ghost"}
                  className={cn("w-full justify-start gap-3")}
                  onClick={() => handleNavigate(item.path)}
                >
                  <item.icon className="h-5 w-5" />
                  {t(item.labelKey)}
                </Button>
              );
            })}
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto pt-16 pb-16 md:pt-0 md:pb-0">
        <div className="container mx-auto p-4 md:p-8 max-w-7xl">
          {children}
        </div>
      </main>
    </div>
  );
}
