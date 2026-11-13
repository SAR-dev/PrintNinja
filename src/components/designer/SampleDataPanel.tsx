import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Pencil, Search } from "lucide-react";
import { notifySuccess } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface Dataset {
  /**
   * Stored name. The account has one dataset, and the app always saves it
   * under this fixed name, so the name never appears in the UI.
   */
  name: string;
  json: string;
}

/** One variable a template can use, read from the chosen dataset. */
export interface Variable {
  /** Dotted path, e.g. `order.total`. */
  path: string;
  kind: "value" | "list";
  /** Short preview of the sample value, shown beside the path. */
  preview: string;
}

/**
 * The stored name of the account's single sample dataset. It is sync
 * data, so it stays this exact string everywhere it is saved or
 * compared.
 */
export const SAMPLE_ORDER_NAME = "Sample Order";

/** Variables the engine provides even when the dataset has no such key. */
const EXTRA_VARIABLES = ["barcode", "qr"];

const MAX_DEPTH = 4;

function previewOf(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  }
  return String(value);
}

/** Flatten a dataset into the paths a template can print. Objects are walked;
 * a list is one entry (it needs `{{#each}}`), not one per element. */
export function flattenVariables(
  data: unknown,
  prefix = "",
  depth = 0,
): Variable[] {
  if (Array.isArray(data)) {
    return prefix
      ? [{ path: prefix, kind: "list", preview: `[${data.length}]` }]
      : [];
  }
  if (data !== null && typeof data === "object") {
    if (depth >= MAX_DEPTH) return [];
    return Object.entries(data as Record<string, unknown>).flatMap(([k, v]) =>
      flattenVariables(v, prefix ? `${prefix}.${k}` : k, depth + 1),
    );
  }
  return prefix
    ? [{ path: prefix, kind: "value", preview: previewOf(data) }]
    : [];
}

/** What clicking a variable inserts, and where the cursor lands afterwards. */
export function variableSnippet(v: Variable): { text: string; back: number } {
  if (v.kind === "list") {
    const close = "\n{{/each}}";
    return { text: `{{#each ${v.path}}}\n  ${close}`, back: close.length };
  }
  return { text: `{{${v.path}}}`, back: 0 };
}

async function copyToken(token: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(token);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = token;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

/** Pretty-print the dataset JSON; fall back to the raw text if it is invalid. */
function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

interface Props {
  /** The account's single sample dataset. */
  dataset: Dataset;
  /** Open the JSON editor dialog. */
  onEdit: () => void;
  /** Insert text at the editor's cursor. Without it a click copies the token. */
  onInsert?: (text: string, back?: number) => void;
}

/**
 * The account's single sample dataset: the variables it offers (click to
 * insert or copy) and its raw JSON. The JSON is edited in a dialog the
 * parent owns. On desktop the panel sits in an accordion section; on a
 * phone it is a tab.
 */
export function SampleDataPanel({ dataset, onEdit, onInsert }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [showJson, setShowJson] = useState(false);

  const variables = useMemo<Variable[]>(() => {
    let found: Variable[] = [];
    try {
      found = flattenVariables(JSON.parse(dataset.json));
    } catch {
      found = [];
    }
    const have = new Set(found.map((v) => v.path));
    const extras = EXTRA_VARIABLES.filter((p) => !have.has(p)).map(
      (path): Variable => ({ path, kind: "value", preview: "" }),
    );
    return [...found, ...extras];
  }, [dataset.json]);

  const q = query.trim().toLowerCase();
  const visible = q
    ? variables.filter(
        (v) =>
          v.path.toLowerCase().includes(q) ||
          v.preview.toLowerCase().includes(q),
      )
    : variables;

  // Group by the first path segment so `store.*` and `order.*` read as sections.
  const groups = useMemo(() => {
    const map = new Map<string, Variable[]>();
    for (const v of visible) {
      const key = v.path.includes(".") ? v.path.split(".")[0] : "";
      map.set(key, [...(map.get(key) ?? []), v]);
    }
    return [...map.entries()];
  }, [visible]);

  const applyVariable = async (v: Variable) => {
    const { text, back } = variableSnippet(v);
    if (onInsert) {
      onInsert(text, back);
      notifySuccess(t("designer.inserted_token", { token: text }));
    } else {
      await copyToken(text);
      notifySuccess(t("designer.copied_token", { token: text }));
    }
  };

  return (
    <div className="space-y-4">
      {/* Variables: the dataset's paths, with sample values, click to insert */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold">
            {t("designer.sample_variables")}
          </h3>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {onInsert
                ? t("designer.sample_click_insert")
                : t("designer.sample_click_copy")}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={onEdit}
            >
              <Pencil className="h-3 w-3" aria-hidden="true" />
              {t("designer.sample_edit")}
            </Button>
          </div>
        </div>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("designer.sample_filter")}
            aria-label={t("designer.sample_filter")}
            className="h-8 pl-7 text-xs"
          />
        </div>
        {visible.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("designer.sample_no_match")}
          </p>
        ) : (
          <div className="space-y-2">
            {groups.map(([group, list]) => (
              <div key={group || "_root"} className="space-y-0.5">
                {group && (
                  <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {group}
                  </p>
                )}
                {list.map((v) => (
                  <button
                    key={v.path}
                    type="button"
                    title={
                      onInsert
                        ? t("designer.sample_insert_title")
                        : t("designer.sample_copy")
                    }
                    onClick={() => void applyVariable(v)}
                    className="flex w-full items-baseline justify-between gap-2 rounded px-1.5 py-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
                  >
                    <code className="shrink-0 font-mono text-xs">
                      {`{{${v.path}}}`}
                    </code>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {v.kind === "list" ? `${v.preview} ↻` : v.preview}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Raw JSON: collapsed, wrapped (no sideways scroll), one scroll area */}
      <div className="space-y-1 border-t pt-3 text-xs">
        <div className="flex items-center justify-between">
          <button
            type="button"
            aria-expanded={showJson}
            onClick={() => setShowJson((s) => !s)}
            className="cursor-pointer text-muted-foreground hover:text-foreground"
          >
            {showJson ? "▼" : "▶"} {t("designer.sample_json")}
          </button>
          {showJson && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={() => {
                void copyToken(prettyJson(dataset.json));
                notifySuccess(t("designer.copied_json"));
              }}
            >
              <Copy className="h-3 w-3" aria-hidden="true" />
              {t("designer.sample_copy_json")}
            </Button>
          )}
        </div>
        {showJson && (
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">
            {prettyJson(dataset.json)}
          </pre>
        )}
      </div>
    </div>
  );
}
