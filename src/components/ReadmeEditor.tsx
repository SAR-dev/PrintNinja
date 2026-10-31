import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { currentLanguage } from "@/lib/i18n";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bold,
  Code,
  Heading2,
  Link2,
  List,
  Quote,
  RotateCcw,
  SquareCode,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

const README_MAX_BYTES = 64 * 1024;

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * Remark plugin: drop HTML comments (`<!-- … -->`) from `html` nodes so
 * scaffold guidance never renders in the preview. Fenced code is a
 * `code` node, not `html`, so documented comment syntax in samples keeps
 * rendering verbatim; every other raw-HTML node keeps the existing
 * escaped-as-text behavior, so the no-rehype-raw XSS posture is unchanged.
 */
function stripHtmlComments() {
  const strip = (node: MdastNode): void => {
    const children = node.children;
    if (!children) return;
    for (const child of children) strip(child);
    node.children = children.filter((child) => {
      if (child.type !== "html" || typeof child.value !== "string") return true;
      const rest = child.value.replace(HTML_COMMENT_RE, "");
      if (rest.trim() === "") return false;
      child.value = rest;
      return true;
    });
  };
  return (tree: MdastNode): void => {
    strip(tree);
  };
}

interface ReadmeEditorProps {
  value: string;
  onChange: (value: string) => void;
  templateName: string;
  onReset?: () => void;
  scaffoldForName?: string;
  /** A saved copy: the text shows, but nothing can change it. */
  readOnly?: boolean;
}

function scaffoldFor(templateName: string): string {
  return `# ${templateName}

<!-- One line: what is this template for? -->

## What it prints
<!-- e.g. An 80mm thermal receipt with items, totals and a QR code. -->

## Data contract
<!-- The JSON keys this template reads. Keep in sync with Placeholders. -->

\`\`\`json
{
  "store":  { "name": "", "address": "" },
  "order":  { "number": "", "date": "" },
  "items":  [ { "name": "", "qty": 1, "price": 0.0, "total": 0.0 } ],
  "totals": { "subtotal": 0.0, "tax": 0.0, "total": 0.0 }
}
\`\`\`

## Placeholders
<!-- Which {{helper}} produces which field. -->

## Printer requirements
- Paper:
- Language:
- DPI:
- Margins:

## Changelog
- v1 — initial version
`;
}

function wrapSelection(
  textarea: HTMLTextAreaElement,
  before: string,
  after: string,
  placeholder: string = "",
): string {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end) || placeholder;
  const next =
    textarea.value.slice(0, start) +
    before +
    selected +
    after +
    textarea.value.slice(end);
  return next;
}

export function ReadmeEditor({
  value,
  onChange,
  templateName,
  onReset,
  scaffoldForName,
  readOnly = false,
}: ReadmeEditorProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [showResetDialog, setShowResetDialog] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const bytes = new TextEncoder().encode(value).length;
  const overCap = bytes > README_MAX_BYTES;

  const applyWrap = (before: string, after: string, placeholder = "") => {
    const ta = textareaRef.current;
    if (!ta) return;
    const next = wrapSelection(ta, before, after, placeholder);
    onChange(next);
    // Restore focus and selection after React update
    requestAnimationFrame(() => {
      ta.focus();
      const start = ta.selectionStart;
      // Place cursor inside the wrapped placeholder if it was empty
      if (
        placeholder &&
        ta.value.slice(
          start - placeholder.length - after.length,
          start - after.length,
        ) === placeholder
      ) {
        ta.setSelectionRange(
          start - placeholder.length - after.length,
          start - after.length,
        );
      }
    });
  };

  const handleToolbar = (action: string) => {
    switch (action) {
      case "bold":
        applyWrap("**", "**", t("readme.ph_bold"));
        break;
      case "heading":
        applyWrap("\n## ", "", t("readme.ph_heading"));
        break;
      case "link":
        applyWrap("[", "](https://)", t("readme.ph_text"));
        break;
      case "code":
        applyWrap("`", "`", t("readme.ph_code"));
        break;
      case "codeblock":
        applyWrap("\n```\n", "\n```\n", t("readme.ph_code"));
        break;
      case "list":
        applyWrap("\n- ", "", t("readme.ph_item"));
        break;
      case "quote":
        applyWrap("\n> ", "", t("readme.ph_quote"));
        break;
      default:
        break;
    }
  };

  const handleReset = () => {
    const scaffold = scaffoldFor(scaffoldForName ?? templateName);
    if (onReset) {
      onReset();
    } else {
      onChange(scaffold);
    }
    setShowResetDialog(false);
  };

  const preview = (
    <div className="min-h-0 flex-1 overflow-auto bg-card px-6 py-5">
      <div className="readme-preview mx-auto max-w-[72ch]">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, stripHtmlComments]}
          // No rehype-raw: raw HTML stays as text, which is the XSS guarantee
          components={{
            a: ({ href, children, ...props }) => {
              const safe = href && /^(https?:\/\/|mailto:)/i.test(href);
              if (!safe) {
                return <span {...props}>{children}</span>;
              }
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  {...props}
                >
                  {children}
                </a>
              );
            },
          }}
        >
          {value || t("readme.empty_hint")}
        </ReactMarkdown>
      </div>
    </div>
  );

  const tools: Array<{
    action: string;
    label: string;
    icon: typeof Bold;
  }> = [
    { action: "bold", label: t("readme.tool_bold"), icon: Bold },
    { action: "heading", label: t("readme.tool_heading"), icon: Heading2 },
    { action: "link", label: t("readme.tool_link"), icon: Link2 },
    { action: "code", label: t("readme.tool_code"), icon: Code },
    {
      action: "codeblock",
      label: t("readme.tool_codeblock"),
      icon: SquareCode,
    },
    { action: "list", label: t("readme.tool_list"), icon: List },
    { action: "quote", label: t("readme.tool_quote"), icon: Quote },
  ];

  // Edge to edge, like the HTML and CSS editors: the pane's own border frames
  // it, so the text area carries none, and the size sits in a slim footer.
  const editor = (
    <>
      <textarea
        ref={textareaRef}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("readme.placeholder")}
        spellCheck={false}
        data-slot="textarea"
        className={`min-h-[240px] w-full flex-1 resize-none bg-card px-5 py-4 font-mono text-[13px] leading-6 [tab-size:2] placeholder:text-muted-foreground focus-visible:outline-none ${
          readOnly ? "cursor-default bg-muted/40" : ""
        }`}
      />
      <div
        className={`shrink-0 border-t px-4 py-1.5 text-xs tabular-nums ${overCap ? "font-medium text-destructive" : "text-muted-foreground"}`}
      >
        {t("readme.byte_count", {
          used: bytes.toLocaleString(currentLanguage()),
          max: README_MAX_BYTES.toLocaleString(currentLanguage()),
        })}
        {overCap && t("readme.over_cap")}
      </div>
    </>
  );

  // Formatting tools only act on the editor, so the preview shows none.
  const toolbar = (
    <div
      role="toolbar"
      aria-label={t("readme.edit")}
      className="flex items-center gap-0.5"
    >
      {tools.map(({ action, label, icon: Icon }) => (
        <Button
          key={action}
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          disabled={readOnly}
          onClick={() => handleToolbar(action)}
          title={label}
          aria-label={label}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </Button>
      ))}
    </div>
  );

  const resetButton = (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground hover:text-foreground"
      disabled={readOnly}
      onClick={() => setShowResetDialog(true)}
      title={t("readme.tool_reset")}
    >
      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
      {t("readme.reset")}
    </Button>
  );

  return (
    <>
      {/* Edit and preview share one pane: the preview renders on demand
        instead of live beside the editor. The pane fills the height it is
        given, so the text area grows with the window instead of ending
        halfway down. There is no Save here: the Designer's Save sends the
        README with the rest of the template. */}
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as typeof tab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-muted/30 px-3 py-1.5">
          <TabsList className="min-h-8 w-max shrink-0 gap-0.5 overflow-visible p-0.5">
            <TabsTrigger value="edit" className="h-7 px-3.5 text-sm">
              {t("readme.edit")}
            </TabsTrigger>
            <TabsTrigger value="preview" className="h-7 px-3.5 text-sm">
              {t("readme.preview")}
            </TabsTrigger>
          </TabsList>
          {tab === "edit" && (
            <div className="ml-auto">
              <DisabledReason
                reason={readOnly ? t("designer.reason_readonly") : undefined}
              >
                <div className="flex items-center gap-1">
                  {toolbar}
                  <span
                    className="mx-1 h-5 w-px bg-border"
                    aria-hidden="true"
                  />
                  {resetButton}
                </div>
              </DisabledReason>
            </div>
          )}
        </div>
        {tab === "edit" ? editor : preview}
      </Tabs>

      <Dialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("readme.reset_title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("readme.reset_body")}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowResetDialog(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={handleReset}>
              {t("readme.reset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export { README_MAX_BYTES, scaffoldFor };
