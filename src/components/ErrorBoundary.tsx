import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { diagnostics } from "@/lib/diagnostics";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Short label recorded in the diagnostics log when a crash is caught. */
  context: string;
  /** Rendered instead of the children after a crash. */
  fallback: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render errors in its subtree. The parent decides what the
 * fallback looks like and can reset the boundary (a "Try again").
 * Remounting the boundary (a new `key`) resets it too — the app uses
 * that so navigating away from a broken page always works.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    diagnostics.error(this.props.context, {
      message: error.message,
      componentStack: info.componentStack ?? "",
    });
  }

  private readonly reset = () => this.setState({ error: null });

  override render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return <>{this.props.fallback(error, this.reset)}</>;
  }
}

// Vite and webpack word chunk-load failures differently; matching both
// keeps the "Reload" path honest.
const CHUNK_ERROR =
  /failed to fetch dynamically imported module|loading chunk \S+ failed|unable to preload|error loading dynamically imported module/i;

/** A failed lazy() import: re-rendering cannot fix it, a reload can. */
export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_ERROR.test(error.message);
}

/** "Copy diagnostics" with a small confirmation; falls back to a download. */
function CopyDiagnosticsButton() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      onClick={() => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(diagnostics.export());
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          } catch {
            diagnostics.download();
          }
        })();
      }}
    >
      {copied ? t("shell.error_copied") : t("shell.error_copy_diagnostics")}
    </Button>
  );
}

/**
 * Fallback for a single page. The navigation around it (the Layout) is
 * outside the boundary, so "Back to Print" always works. When a chunk
 * failed to load, the retry is a full reload instead — re-fetching the
 * same missing file fails the same way.
 */
export function RouteErrorFallback({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const chunk = isChunkLoadError(error);
  return (
    <div className="flex min-h-[50dvh] items-center justify-center p-6">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-lg font-semibold">
          {chunk ? t("shell.error_chunk_title") : t("shell.error_title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {chunk ? t("shell.error_chunk_body") : t("shell.error_body")}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {chunk ? (
            <Button onClick={() => window.location.reload()}>
              {t("shell.error_reload")}
            </Button>
          ) : (
            <>
              <Button onClick={onRetry}>{t("shell.error_try_again")}</Button>
              <Button variant="outline" onClick={() => navigate("/print")}>
                {t("shell.error_back_to_print")}
              </Button>
            </>
          )}
          <CopyDiagnosticsButton />
        </div>
      </div>
    </div>
  );
}

/**
 * Fallback for the whole app. No router is left, so there is no
 * navigation — a reload is the way back.
 */
export function AppErrorFallback({ error }: { error: Error }) {
  const { t } = useTranslation();
  const chunk = isChunkLoadError(error);
  return (
    <div className="flex min-h-dvh-safe flex-col items-center justify-center bg-background p-6">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-lg font-semibold">
          {chunk ? t("shell.error_chunk_title") : t("shell.app_error_title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("shell.app_error_body")}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => window.location.reload()}>
            {t("shell.error_reload")}
          </Button>
          <CopyDiagnosticsButton />
        </div>
      </div>
    </div>
  );
}
