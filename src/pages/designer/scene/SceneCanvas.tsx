/**
 * The scene designer's canvas: the label page drawn to scale, with the
 * elements draggable and resizable, barcodes and QR codes rendered the
 * way the label pipeline encodes them (asked of the backend, which is
 * the ground truth for what prints). Ported from PrintNinja-Next's
 * `app/ui/src/scene/scene-canvas.tsx`.
 */
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { agent } from "@/lib/agent/commands";
import type { SymbolEncoding } from "@/lib/agent/types";
import {
  boundsMm,
  getAt,
  pageDims,
  resizeBox,
  rowHeightMm,
  type Path,
  type Selection,
} from "@/lib/scene/editor-model";
import {
  bindingNames,
  substituteBindings,
  type Element,
  type Template,
} from "@/lib/scene/schema";

const INK = "#18181b";
const FAINT = "#71717a";
const DASH = "4 3";
const WARN = "#f59e0b";

const round1 = (v: number) => Math.round(v * 10) / 10;

/** The backend encodes the symbols the canvas draws; cache the answers
 * so a re-render (a drag, a selection) does not re-ask for every bar. */
const symbolCache = new Map<string, SymbolEncoding | null>();

/**
 * The encoding of one symbol, the way the label pipeline renders it.
 * Debounced: while a value is being typed the canvas shows the
 * placeholder instead of asking per keystroke.
 */
function useSymbol(
  kind: string,
  value: string,
): SymbolEncoding | null | undefined {
  const cacheKey = `${kind}:${value}`;
  const [enc, setEnc] = useState<SymbolEncoding | null | undefined>(() =>
    symbolCache.has(cacheKey) ? symbolCache.get(cacheKey) : undefined,
  );
  useEffect(() => {
    const hit = symbolCache.get(cacheKey);
    if (hit !== undefined) {
      setEnc(hit);
      return;
    }
    setEnc(undefined);
    let live = true;
    const timer = setTimeout(() => {
      agent("label_encode_symbol", { kind, value })
        .then((r) => {
          if (!live) return;
          symbolCache.set(cacheKey, r);
          setEnc(r);
        })
        .catch(() => {
          if (!live) return;
          symbolCache.set(cacheKey, null);
          setEnc(null);
        });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [kind, value, cacheKey]);
  return enc;
}

/** Would the symbol fit its box at the printer's DPI, one module per dot? */
function symbolFits(
  enc: SymbolEncoding,
  box_mm: number,
  dpi: number | null,
): boolean {
  if (dpi === null || box_mm <= 0) return true;
  const total = enc.side
    ? enc.side + 2 * enc.quiet
    : enc.modules.length + 2 * enc.quiet;
  return (box_mm * dpi) / 25.4 / total >= 1;
}

/** The amber "!" marking a symbol the printer cannot fit. */
function FitBadge({ x, y }: { x: number; y: number }) {
  return (
    <g pointerEvents="none">
      <circle cx={x} cy={y} r={2.6} fill={WARN} />
      <text
        x={x}
        y={y + 1}
        textAnchor="middle"
        fontSize={3.6}
        fill="#ffffff"
        fontWeight={700}
      >
        !
      </text>
    </g>
  );
}

/** Why a value cannot be encoded in its symbology. */
function symbolReason(kind: string, value: string): string {
  const { t } = useTranslation();
  if (value.trim() === "") return t("scene.sym_empty");
  if (kind === "ean13") return t("scene.sym_ean13");
  if (kind === "upca") return t("scene.sym_upca");
  if (kind === "itf") return t("scene.sym_itf");
  if (kind === "code128") return t("scene.sym_code128");
  return t("scene.sym_generic");
}

/** The dashed grey box a not-yet-renderable element stands in for. */
function Placeholder({
  x,
  y,
  w,
  h,
  label,
  scale,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  scale: number;
}) {
  return (
    <g>
      <rect
        x={x * scale}
        y={y * scale}
        width={w * scale}
        height={h * scale}
        fill="none"
        stroke={FAINT}
        strokeWidth={1}
        strokeDasharray={DASH}
      />
      <text
        x={(x + w / 2) * scale}
        y={(y + h / 2) * scale}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={Math.max(8, 2.2 * scale)}
        fill={FAINT}
      >
        {label}
      </text>
    </g>
  );
}

function BarcodeGlyph({
  el,
  x,
  y,
  scale,
  record,
  showSample,
  dpi,
}: {
  el: Extract<Element, { type: "barcode" }>;
  x: number;
  y: number;
  scale: number;
  record: Record<string, unknown> | null;
  showSample: boolean;
  dpi: number | null;
}) {
  const { t } = useTranslation();
  const kind = el.kind ?? "code128";
  const shown = showSample ? substituteBindings(el.value, record) : el.value;
  const pending = bindingNames(shown).length > 0;
  const enc = useSymbol(kind, pending ? "" : shown);
  const w = el.size.w_mm;
  const h = el.size.h_mm;
  if (pending || enc === undefined || enc === null) {
    const label = pending
      ? t("scene.sym_pending_barcode", { kind })
      : enc === undefined
        ? t("scene.sym_encoding")
        : symbolReason(kind, el.value);
    return <Placeholder x={x} y={y} w={w} h={h} label={label} scale={scale} />;
  }
  const showText = el.show_text !== false;
  const text_mm = showText ? Math.min(0.3 * h, 2.5) : 0;
  const bar_h = h - text_mm;
  const mod_w = w / (enc.modules.length + 2 * enc.quiet);
  // Runs of dark modules, one rect each.
  const runs: [number, number][] = [];
  let runStart = -1;
  enc.modules.forEach((m, i) => {
    if (m === 1 && runStart === -1) runStart = i;
    if (m === 0 && runStart !== -1) {
      runs.push([runStart, i - runStart]);
      runStart = -1;
    }
  });
  if (runStart !== -1) runs.push([runStart, enc.modules.length - runStart]);
  return (
    <g>
      {runs.map(([start, len], i) => (
        <rect
          key={i}
          x={(x + (start + enc.quiet) * mod_w) * scale}
          y={y * scale}
          width={len * mod_w * scale}
          height={bar_h * scale}
          fill={INK}
        />
      ))}
      {showText && (
        <text
          x={(x + w / 2) * scale}
          y={(y + bar_h + 0.75 * text_mm) * scale}
          textAnchor="middle"
          fontSize={Math.max(1.2, Math.min(0.2 * h, 2.5)) * scale}
          fill={INK}
        >
          {shown}
        </text>
      )}
      {!symbolFits(enc, w, dpi) && (
        <FitBadge x={(x + w - 2.5) * scale} y={(y + 2.5) * scale} />
      )}
    </g>
  );
}

function QrGlyph({
  el,
  x,
  y,
  scale,
  record,
  showSample,
  dpi,
}: {
  el: Extract<Element, { type: "qr" }>;
  x: number;
  y: number;
  scale: number;
  record: Record<string, unknown> | null;
  showSample: boolean;
  dpi: number | null;
}) {
  const { t } = useTranslation();
  const h = el.h_mm;
  const shown = showSample ? substituteBindings(el.value, record) : el.value;
  const pending = bindingNames(shown).length > 0;
  const enc = useSymbol("qr", pending ? "" : shown);
  if (pending || enc === undefined || enc === null) {
    const label = pending
      ? t("scene.sym_pending_qr")
      : enc === undefined
        ? t("scene.sym_encoding")
        : symbolReason("qr", el.value);
    return <Placeholder x={x} y={y} w={h} h={h} label={label} scale={scale} />;
  }
  const side = enc.side ?? 1;
  const cell = h / (side + 2 * enc.quiet);
  let d = "";
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      if (enc.modules[r * side + c] === 0) continue;
      const px = x + (c + enc.quiet) * cell;
      const py = y + (r + enc.quiet) * cell;
      d += `M${px * scale} ${py * scale}h${cell * scale}v${cell * scale}h${-cell * scale}Z`;
    }
  }
  return (
    <g>
      <path d={d} fill={INK} />
      {!symbolFits(enc, h, dpi) && (
        <FitBadge x={(x + h - 2.5) * scale} y={(y + 2.5) * scale} />
      )}
    </g>
  );
}

function GroupGlyph({
  el,
  scale,
  record,
  showSample,
  dpi,
}: {
  el: Extract<Element, { type: "group" }>;
  scale: number;
  record: Record<string, unknown> | null;
  showSample: boolean;
  dpi: number | null;
}) {
  const { t } = useTranslation();
  const x = el.at.x_mm;
  const y = el.at.y_mm;
  let cursor = 0;
  const rows = el.items.map((item) => {
    const top = cursor;
    cursor += rowHeightMm(item) + el.item_gap_mm;
    return { item, top };
  });
  const totalH = Math.max(
    4,
    el.items.reduce((sum, it) => sum + rowHeightMm(it), 0) +
      Math.max(0, el.items.length - 1) * el.item_gap_mm,
  );
  return (
    <g>
      <rect
        x={x * scale}
        y={y * scale}
        width={el.w_mm * scale}
        height={totalH * scale}
        fill="none"
        stroke={FAINT}
        strokeWidth={1}
        strokeDasharray={DASH}
      />
      <text
        x={(x + 1) * scale}
        y={(y + 2.5) * scale}
        fontSize={Math.max(8, 2.2 * scale)}
        fill={FAINT}
      >
        {t("scene.group_row_per", { name: el.bind })}
      </text>
      {rows.map(({ item, top }, i) => (
        <g
          key={i}
          transform={`translate(${x * scale}, ${(y + top + 4) * scale})`}
        >
          {glyph(item, { scale, record, showSample, dpi })}
        </g>
      ))}
    </g>
  );
}

interface GlyphArgs {
  scale: number;
  record: Record<string, unknown> | null;
  showSample: boolean;
  dpi: number | null;
}

/** The static drawing of one element (no selection chrome). */
function glyph(el: Element, { scale, record, showSample, dpi }: GlyphArgs) {
  const { t } = useTranslation();
  const [x, y, w, h] = boundsMm(el);
  switch (el.type) {
    case "text": {
      const align = el.style.align ?? "left";
      const anchor =
        align === "center" ? "middle" : align === "right" ? "end" : "start";
      const tx = x + (align === "center" ? w / 2 : align === "right" ? w : 0);
      return (
        <text
          x={tx * scale}
          y={(el.at.y_mm + el.style.size_mm) * scale}
          textAnchor={anchor}
          fontSize={el.style.size_mm * scale}
          fontWeight={el.style.bold ? 700 : 400}
          fontStyle={el.style.italic ? "italic" : undefined}
          fill={INK}
        >
          {showSample ? substituteBindings(el.content, record) : el.content}
        </text>
      );
    }
    case "line":
      return (
        <line
          x1={x * scale}
          y1={y * scale}
          x2={(x + (el.vertical ? 0 : el.length_mm)) * scale}
          y2={(y + (el.vertical ? el.length_mm : 0)) * scale}
          stroke={INK}
          strokeWidth={Math.max(0.5, el.thickness_mm * scale)}
        />
      );
    case "rect":
      return (
        <rect
          x={x * scale}
          y={y * scale}
          width={w * scale}
          height={h * scale}
          fill={el.fill ? INK : "none"}
          stroke={INK}
          strokeWidth={0.75}
        />
      );
    case "barcode":
      return (
        <BarcodeGlyph
          el={el}
          x={x}
          y={y}
          scale={scale}
          record={record}
          showSample={showSample}
          dpi={dpi}
        />
      );
    case "qr":
      return (
        <QrGlyph
          el={el}
          x={x}
          y={y}
          scale={scale}
          record={record}
          showSample={showSample}
          dpi={dpi}
        />
      );
    case "image":
      if (el.src.startsWith("data:")) {
        return (
          <image
            href={el.src}
            x={x * scale}
            y={y * scale}
            width={w * scale}
            height={h * scale}
            preserveAspectRatio="xMidYMid meet"
          />
        );
      }
      return (
        <Placeholder
          x={x}
          y={y}
          w={w}
          h={h}
          label={t("scene.image_file", { src: el.src })}
          scale={scale}
        />
      );
    case "frame":
      return (
        <FrameGlyph
          el={el}
          scale={scale}
          record={record}
          showSample={showSample}
          dpi={dpi}
        />
      );
    case "group":
      return null;
  }
}

function FrameGlyph({
  el,
  scale,
  record,
  showSample,
  dpi,
  path,
  isSelected,
  beginDrag,
  beginResize,
}: {
  el: Extract<Element, { type: "frame" }>;
  scale: number;
  record: Record<string, unknown> | null;
  showSample: boolean;
  dpi: number | null;
  path?: Path;
  isSelected?: boolean;
  beginDrag?: (path: Path, e: ReactPointerEvent) => void;
  beginResize?: (path: Path, handle: string, e: ReactPointerEvent) => void;
}) {
  const interactive = path !== undefined && beginDrag !== undefined;
  const x = el.at.x_mm;
  const y = el.at.y_mm;
  return (
    <g
      transform={`translate(${x * scale}, ${y * scale})`}
      onPointerDown={
        interactive
          ? (e) => {
              e.stopPropagation();
              beginDrag(path, e);
            }
          : undefined
      }
      className={interactive ? "cursor-move" : undefined}
    >
      {interactive && (
        <rect
          width={el.size.w_mm * scale}
          height={el.size.h_mm * scale}
          fill="transparent"
        />
      )}
      {el.border_mm > 0 && (
        <rect
          x={0.75}
          y={0.75}
          width={Math.max(0, el.size.w_mm * scale - 1.5)}
          height={Math.max(0, el.size.h_mm * scale - 1.5)}
          fill="none"
          stroke={INK}
          strokeWidth={Math.max(0.5, el.border_mm * scale)}
        />
      )}
      {el.children.map((child, i) =>
        interactive ? (
          <ElementNode
            key={i}
            el={child}
            path={[...path, i]}
            scale={scale}
            record={record}
            showSample={showSample}
            dpi={dpi}
            isSelected={isSelected}
            beginDrag={beginDrag}
            beginResize={beginResize}
          />
        ) : (
          <g key={i}>{glyph(child, { scale, record, showSample, dpi })}</g>
        ),
      )}
    </g>
  );
}

const HANDLES: { h: string; fx: number; fy: number; cursor: string }[] = [
  { h: "nw", fx: 0, fy: 0, cursor: "nwse-resize" },
  { h: "n", fx: 0.5, fy: 0, cursor: "ns-resize" },
  { h: "ne", fx: 1, fy: 0, cursor: "nesw-resize" },
  { h: "e", fx: 1, fy: 0.5, cursor: "ew-resize" },
  { h: "se", fx: 1, fy: 1, cursor: "nwse-resize" },
  { h: "s", fx: 0.5, fy: 1, cursor: "ns-resize" },
  { h: "sw", fx: 0, fy: 1, cursor: "nesw-resize" },
  { h: "w", fx: 0, fy: 0.5, cursor: "ew-resize" },
];

function ElementNode({
  el,
  path,
  scale,
  record,
  showSample,
  dpi,
  isSelected,
  beginDrag,
  beginResize,
}: {
  el: Element;
  path: Path;
  scale: number;
  record: Record<string, unknown> | null;
  showSample: boolean;
  dpi: number | null;
  isSelected?: boolean;
  beginDrag?: (path: Path, e: ReactPointerEvent) => void;
  beginResize?: (path: Path, handle: string, e: ReactPointerEvent) => void;
}) {
  const [bx, by, bw, bh] = boundsMm(el);
  const glyphArgs: GlyphArgs = { scale, record, showSample, dpi };
  return (
    <g
      className={beginDrag ? "cursor-move" : undefined}
      onPointerDown={
        beginDrag
          ? (e) => {
              e.stopPropagation();
              beginDrag(path, e);
            }
          : undefined
      }
    >
      {el.type === "frame" ? (
        <FrameGlyph
          el={el}
          scale={scale}
          record={record}
          showSample={showSample}
          dpi={dpi}
          path={beginDrag ? path : undefined}
          isSelected={isSelected}
          beginDrag={beginDrag}
          beginResize={beginResize}
        />
      ) : el.type === "group" ? (
        <GroupGlyph
          el={el}
          scale={scale}
          record={record}
          showSample={showSample}
          dpi={dpi}
        />
      ) : (
        glyph(el, glyphArgs)
      )}
      {isSelected && (
        <rect
          x={(bx - 0.5) * scale}
          y={(by - 0.5) * scale}
          width={(bw + 1) * scale}
          height={(bh + 1) * scale}
          fill="none"
          stroke="#2563eb"
          strokeWidth={1.5}
          pointerEvents="none"
        />
      )}
      {isSelected &&
        beginResize &&
        "size" in el &&
        HANDLES.map(({ h, fx, fy, cursor }) => (
          <rect
            key={h}
            x={(bx + fx * bw) * scale - 3}
            y={(by + fy * bh) * scale - 3}
            width={6}
            height={6}
            fill="#ffffff"
            stroke="#2563eb"
            strokeWidth={1.5}
            style={{ cursor }}
            onPointerDown={(e) => {
              e.stopPropagation();
              beginResize(path, h, e);
            }}
          />
        ))}
    </g>
  );
}

interface Drag {
  path: Path;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  started: boolean;
}

interface Resize {
  path: Path;
  handle: string;
  startX: number;
  startY: number;
  ox: number;
  oy: number;
  ow: number;
  oh: number;
}

/**
 * The label page, drawn to scale. `record` is the sample data a bound
 * element fills from (only when `showSample` is on); `dpi` is the
 * chosen printer's, for the "does it fit" marks.
 */
export function SceneCanvas({
  template,
  selection,
  onSelect,
  onMove,
  onDragStart,
  onResize,
  record,
  showSample,
  dpi,
  scale: scaleOverride,
}: {
  template: Template;
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  onMove?: (path: Path, x_mm: number, y_mm: number) => void;
  onDragStart?: (path: Path) => void;
  onResize?: (
    path: Path,
    x_mm: number,
    y_mm: number,
    w_mm: number,
    h_mm: number,
  ) => void;
  record: Record<string, unknown> | null;
  showSample: boolean;
  dpi: number | null;
  /** Pixels per millimetre; the shared ZoomStage supplies it. */
  scale?: number;
}) {
  const { t } = useTranslation();
  const interactive = onMove !== undefined && onSelect !== undefined;
  const { w: wMm, h: hMm } = pageDims(template.media);
  const scale = scaleOverride ?? Math.min(12, 480 / wMm);
  const width = wMm * scale;
  const height = hMm * scale;
  const drag = useRef<Drag | null>(null);
  const resize = useRef<Resize | null>(null);

  const beginDrag = (path: Path, e: ReactPointerEvent) => {
    if (!onSelect || !onMove || !onDragStart) return;
    const el = getAt(template, path);
    if (!el) return;
    e.stopPropagation();
    onSelect({ path });
    drag.current = {
      path,
      startX: e.clientX,
      startY: e.clientY,
      origX: el.at.x_mm,
      origY: el.at.y_mm,
      started: false,
    };
    (e.target as SVGElement).setPointerCapture(e.pointerId);
  };

  const beginResize = (path: Path, handle: string, e: ReactPointerEvent) => {
    if (!onResize) return;
    const el = getAt(template, path);
    if (!el || !("size" in el)) return;
    e.stopPropagation();
    const [ox, oy, ow, oh] = boundsMm(el);
    resize.current = {
      path,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      ox,
      oy,
      ow,
      oh,
    };
    (e.target as SVGElement).setPointerCapture(e.pointerId);
  };

  const moveDrag = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || !onMove || !onDragStart) return;
    if (!d.started) {
      d.started = true;
      onDragStart(d.path);
    }
    onMove(
      d.path,
      round1(d.origX + (e.clientX - d.startX) / scale),
      round1(d.origY + (e.clientY - d.startY) / scale),
    );
  };

  const moveResize = (e: ReactPointerEvent) => {
    const r = resize.current;
    if (!r || !onResize) return;
    const [x, y, w, h] = resizeBox(
      r.ox,
      r.oy,
      r.ow,
      r.oh,
      r.handle,
      (e.clientX - r.startX) / scale,
      (e.clientY - r.startY) / scale,
    );
    onResize(r.path, x, y, w, h);
  };

  return (
    <div className="overflow-auto rounded-md border border-border bg-muted/40 p-4">
      <svg
        width={width}
        height={height}
        style={{ touchAction: "none" }}
        onPointerDown={() => interactive && onSelect(null)}
        onPointerMove={(e) => {
          moveDrag(e);
          moveResize(e);
        }}
        onPointerUp={() => {
          drag.current = null;
          resize.current = null;
        }}
        onPointerLeave={() => {
          drag.current = null;
          resize.current = null;
        }}
      >
        <rect
          x={0.75}
          y={0.75}
          width={width - 1.5}
          height={height - 1.5}
          fill="#ffffff"
          stroke="#a1a1aa"
        />
        {template.elements.map((el, i) => (
          <ElementNode
            key={i}
            el={el}
            path={[i]}
            scale={scale}
            record={record}
            showSample={showSample}
            dpi={dpi}
            isSelected={
              selection !== null &&
              selection.path.length === 1 &&
              selection.path[0] === i
            }
            beginDrag={interactive ? beginDrag : undefined}
            beginResize={interactive ? beginResize : undefined}
          />
        ))}
      </svg>
      <div className="mt-2 text-center text-caption text-muted-foreground">
        {t("scene.canvas_footer", { w: wMm, h: hMm })}
      </div>
    </div>
  );
}
