import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { notifySuccess } from "@/lib/notify";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface Dataset {
  name: string;
  json: string;
  isDefault: boolean;
}

/** One variable a template can use, read from the chosen dataset. */
export interface Variable {
  /** Dotted path, e.g. `order.total`. */
  path: string;
  kind: "value" | "list";
  /** Short preview of the sample value, shown beside the path. */
  preview: string;
}

/** Longest dataset name the Designer accepts. */
export const DATASET_NAME_MAX = 15;

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
  datasets: Dataset[];
  selectedName: string;
  onSelect: (name: string) => void;
  onAdd: () => void;
  onEdit: (dataset: Dataset) => void;
  onDelete: (dataset: Dataset) => void;
  /** Insert text at the editor's cursor. Without it a click copies the token. */
  onInsert?: (text: string, back?: number) => void;
}

/**
 * The sample datasets the canvas is rendered with, and the variables of the
 * chosen one. It controls what the canvas shows, so on desktop it is an
 * accordion section, and on a phone a tab.
 */
export function SampleDataPanel({
  datasets,
  selectedName,
  onSelect,
  onAdd,
  onEdit,
  onDelete,
  onInsert,
}: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [showJson, setShowJson] = useState(false);

  const selected =
    datasets.find((d) => d.name === selectedName) ?? datasets[0] ?? null;

  const variables = useMemo<Variable[]>(() => {
    if (!selected) return [];
    let found: Variable[] = [];
    try {
      found = flattenVariables(JSON.parse(selected.json));
    } catch {
      found = [];
    }
    const have = new Set(found.map((v) => v.path));
    const extras = EXTRA_VARIABLES.filter((p) => !have.has(p)).map(
      (path): Variable => ({ path, kind: "value", preview: "" }),
    );
    return [...found, ...extras];
  }, [selected]);

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
      {/* Datasets */}
      <div className="space-y-2">
        {datasets.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("designer.sample_empty")}
          </p>
        ) : (
          datasets.map((ds) => {
            const active = selected?.name === ds.name;
            return (
              <div
                key={ds.name}
                className={cn(
                  "rounded-md border p-2 transition-colors",
                  active ? "border-primary bg-accent/40" : "hover:bg-muted/50",
                )}
              >
                <div className="flex items-center gap-2">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name="dataset"
                      aria-label={t("designer.sample_use", { name: ds.name })}
                      checked={active}
                      onChange={() => onSelect(ds.name)}
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-sm font-medium"
                      title={ds.name}
                    >
                      {ds.name}
                    </span>
                    {ds.isDefault && (
                      <Badge variant="secondary" className="shrink-0 text-xs">
                        {t("designer.sample_default")}
                      </Badge>
                    )}
                  </label>
                  <div className="flex shrink-0 gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label={t("common.edit")}
                      title={t("common.edit")}
                      onClick={() => onEdit(ds)}
                    >
                      <Pencil className="h-3 w-3" aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label={t("designer.sample_delete", {
                        name: ds.name,
                      })}
                      title={t("common.delete")}
                      onClick={() => onDelete(ds)}
                      disabled={ds.isDefault}
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full border-dashed text-xs"
          onClick={onAdd}
        >
          <Plus className="h-3 w-3" />
          {t("designer.sample_add")}
        </Button>
      </div>

      {/* Variables: the dataset's paths, with sample values, click to insert */}
      {selected && (
        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold">
              {t("designer.sample_variables")}
            </h3>
            <span className="text-xs text-muted-foreground">
              {onInsert
                ? t("designer.sample_click_insert")
                : t("designer.sample_click_copy")}
            </span>
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
      )}

      {/* Raw JSON: collapsed, wrapped (no sideways scroll), one scroll area */}
      {selected && (
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
                  void copyToken(prettyJson(selected.json));
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
              {prettyJson(selected.json)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
