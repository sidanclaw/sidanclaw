import type {
  DeckChart,
  DeckColumn,
  DeckImage,
  DeckSlide,
  DeckSpec,
  DeckStat,
  DeckStep,
  DeckTable,
} from './spec.js';
import { TEXT_INSET, fitOneLine, widthInEm } from './text-metrics.js';
import type { DeckStyle } from './theme.js';

/**
 * Shared deck layout engine — parity by construction.
 * Spec: docs/architecture/features/deck-generation.md → "Live preview".
 *
 * layoutDeck(spec, style) emits a display list of primitives per slide.
 * The core pptx writer maps primitives → pptxgenjs calls; the app-web
 * preview maps the same primitives → HTML/SVG. Neither side computes
 * layout on its own — layout math changes ONLY in this module.
 *
 * Units: inches on a 13.33 × 7.5 page; font sizes in points; colors hex
 * without '#'. Ported from sidanclaw-pptx-mcp deck.ts with the negative-
 * value bar fix and heading/body font split.
 */

export const DECK_PAGE_W = 13.33;
export const DECK_PAGE_H = 7.5;
const MARGIN = 0.9;
const BODY_W = DECK_PAGE_W - 2 * MARGIN;

/**
 * The type scale. Every font size in this module comes from here — no literals
 * in the layout functions, so the relationships stay visible and adjustable.
 *
 * What reads as "designed" is the *spread* between display and body (~5x), not
 * absolute size. Sizes are points on the 13.33in canvas; tools that export at
 * 20in (Canva) run roughly 1.5x these numbers for the same optical size.
 *
 * `LAYOUT_LIMITS` in spec.ts is measured against these values. The two move
 * together: retune a display size here and the character budget that keeps it
 * on the slide is no longer the measured one.
 */
export const TYPE = {
  deckTitle: 72,
  deckSubtitle: 15,
  statement: 60,
  section: 56,
  hero: 56,
  /** Supporting line under a display headline (section / statement / hero). */
  displaySub: 14,
  header: 30,
  body: 17,
  /** Body set beside a chart or image, where the column is ~5.3in not 11.5in. */
  bodyTight: 15,
  statValue: 54,
  // Floor for the measured fit: below this a "big number" stops reading as one.
  // Only reachable at 4 tiles with a value near the schema's 20-char cap.
  statValueMin: 26,
  statLabel: 11,
  statSupport: 12,
  quote: 28,
  quoteAttr: 14,
  quoteMark: 120,
  columnHeading: 19,
  stepLabel: 17,
  stepDetail: 12,
  agendaNum: 16,
  agendaItem: 16,
  tableCell: 13,
  chartValue: 10,
  chartLabel: 11,
  caption: 12,
  footer: 9,
} as const;

/** Body area under the header rule, shared by every header-bearing layout. */
const BODY_TOP = 1.85;
const BODY_H = DECK_PAGE_H - BODY_TOP - 0.75;

// Hero text sits over an arbitrary photo, so its scrim and text are fixed
// rather than themed — a light theme's dark-on-light would vanish over a
// dark image.
const HERO_SCRIM = '000000';
const HERO_SCRIM_TRANSPARENCY = 55;
const HERO_TEXT = 'FFFFFF';
const HERO_SUBTEXT = 'E5E7EB';

export interface DeckBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DeckTextRun {
  text: string;
  color: string;
  bold?: boolean;
  italic?: boolean;
}

export interface DeckParagraph {
  runs: DeckTextRun[];
  bullet?: boolean;
}

export type DeckPrimitive =
  | {
      kind: 'text';
      box: DeckBox;
      paragraphs: DeckParagraph[];
      fontFace: string;
      fontSizePt: number;
      align: 'left' | 'center' | 'right';
      valign: 'top' | 'middle' | 'bottom';
      /** pptx `fit: shrink`; the preview approximates with CSS clamping. */
      shrinkToFit?: boolean;
      lineSpacingMultiple?: number;
      paraSpaceAfterPt?: number;
      bulletIndentPt?: number;
    }
  | {
      kind: 'rect';
      box: DeckBox;
      fill: string;
      radiusIn?: number;
      /** 0-100. pptx `transparency`; the preview maps it to the same alpha. */
      transparencyPct?: number;
    }
  | { kind: 'lineSeg'; x1: number; y1: number; x2: number; y2: number; color: string; widthPt: number }
  /** `fill` omitted = outline only (the `arc` motif's concentric rings). */
  | { kind: 'ellipse'; box: DeckBox; fill?: string; outline?: { color: string; widthPt: number } }
  | {
      kind: 'pieArc';
      box: DeckBox;
      /** Degrees, 0 = 3 o'clock, clockwise (pptx angleRange convention). */
      startDeg: number;
      sweepDeg: number;
      /** Present for doughnut arcs (pptx blockArc arcThicknessRatio). */
      thicknessRatio?: number;
      fill: string;
      outline: { color: string; widthPt: number };
    }
  | {
      kind: 'image';
      /** The frame to fit the image into. */
      frame: DeckBox;
      source: { url?: string; path?: string };
      /**
       * `contain` (default) centre-fits inside the frame, preserving aspect and
       * leaving letterbox gaps. `cover` fills the frame and crops the overflow —
       * required for full-bleed hero backgrounds, where letterboxing would show
       * the slide background through.
       */
      fit?: 'contain' | 'cover';
    };

export interface DeckSlideLayout {
  background: string;
  primitives: DeckPrimitive[];
  notes?: string;
  /**
   * Lay a paper grain over `background` before any primitive.
   *
   * A slide-level surface treatment, NOT a primitive — the same category as
   * `background` itself, which each renderer already realises its own way. It
   * has to be: the grain is a generated PNG (OOXML has no noise fill) and
   * encoding one needs `node:zlib`, which cannot live in this module because
   * app-web bundles it for the browser. So core generates a real PNG and the
   * preview approximates with an SVG noise overlay — an acknowledged
   * approximation, in the same class as text wrapping, and invisible at
   * preview scale by design (±3/255 amplitude).
   */
  backgroundTexture?: boolean;
}

export function layoutDeck(spec: DeckSpec, style: DeckStyle): DeckSlideLayout[] {
  const slides: DeckSlideLayout[] = [layoutTitleSlide(spec, style)];
  spec.slides.forEach((slide, i) => {
    const pageNum = i + 2;
    let out: DeckSlideLayout;
    switch (slide.layout) {
      case 'section':
        out = layoutSectionSlide(slide, style);
        break;
      case 'statement':
        out = layoutStatementSlide(slide, style);
        break;
      case 'stats':
        out = withFooter(layoutStatsSlide(slide, style), style, spec.title, pageNum);
        break;
      case 'quote':
        out = withFooter(layoutQuoteSlide(slide, style), style, spec.title, pageNum);
        break;
      case 'hero':
        // No footer: it would sit on the photo, and the scrim is tuned for the
        // headline block, not for legible 9pt text at the page edge.
        out = layoutHeroSlide(slide, style);
        break;
      case 'comparison':
        out = withFooter(layoutComparisonSlide(slide, style), style, spec.title, pageNum);
        break;
      case 'timeline':
        out = withFooter(layoutTimelineSlide(slide, style), style, spec.title, pageNum);
        break;
      case 'agenda':
        out = withFooter(layoutAgendaSlide(slide, style), style, spec.title, pageNum);
        break;
      case 'table':
        out = withFooter(layoutTableSlide(slide, style), style, spec.title, pageNum);
        break;
      default:
        out = withFooter(layoutContentSlide(slide, style), style, spec.title, pageNum);
    }
    if (slide.notes) out.notes = slide.notes;
    slides.push(out);
  });
  if (style.texture) for (const s of slides) s.backgroundTexture = true;
  return slides;
}

// ---------------------------------------------------------------------------
// Decorative motifs — a corner mark on the title and section slides only
// ---------------------------------------------------------------------------

const SUNBURST_RAYS = 9;

/** Radiating half-fan, anchored on a baseline. */
function sunburst(color: string, cx: number, cy: number, radius: number): DeckPrimitive[] {
  const rays: DeckPrimitive[] = [];
  for (let i = 0; i < SUNBURST_RAYS; i++) {
    const angle = Math.PI + (Math.PI * i) / (SUNBURST_RAYS - 1);
    rays.push({
      kind: 'lineSeg',
      x1: cx + Math.cos(angle) * radius * 0.18,
      y1: cy + Math.sin(angle) * radius * 0.18,
      x2: cx + Math.cos(angle) * radius,
      y2: cy + Math.sin(angle) * radius,
      color,
      widthPt: 0.75,
    });
  }
  rays.push({ kind: 'lineSeg', x1: cx - radius, y1: cy, x2: cx + radius, y2: cy, color, widthPt: 1 });
  return rays;
}

/** Thin concentric rings, quieter than the sunburst. */
function arcRings(color: string, cx: number, cy: number, radius: number): DeckPrimitive[] {
  return [1, 0.72, 0.44].map((scale) => {
    const r = radius * scale;
    return {
      kind: 'ellipse' as const,
      box: { x: cx - r, y: cy - r, w: r * 2, h: r * 2 },
      outline: { color, widthPt: 0.75 },
    };
  });
}

function motif(style: DeckStyle, color: string): DeckPrimitive[] {
  const radius = 1.15;
  const cx = DECK_PAGE_W - MARGIN - radius;
  const cy = DECK_PAGE_H - MARGIN - 0.15;
  if (style.motif === 'sunburst') return sunburst(color, cx, cy, radius);
  if (style.motif === 'arc') return arcRings(color, cx, cy - radius * 0.55, radius * 0.75);
  return [];
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function plainText(
  text: string,
  color: string,
  box: DeckBox,
  opts: {
    fontFace: string;
    fontSizePt: number;
    bold?: boolean;
    italic?: boolean;
    align?: 'left' | 'center' | 'right';
    valign?: 'top' | 'middle' | 'bottom';
    shrinkToFit?: boolean;
    lineSpacingMultiple?: number;
  },
): DeckPrimitive {
  return {
    kind: 'text',
    box,
    paragraphs: [{ runs: [{ text, color, bold: opts.bold, italic: opts.italic }] }],
    fontFace: opts.fontFace,
    fontSizePt: opts.fontSizePt,
    align: opts.align ?? 'left',
    valign: opts.valign ?? 'top',
    shrinkToFit: opts.shrinkToFit,
    lineSpacingMultiple: opts.lineSpacingMultiple,
  };
}

function bulletBlock(style: DeckStyle, bullets: string[], box: DeckBox, fontSizePt: number = TYPE.body): DeckPrimitive {
  return {
    kind: 'text',
    box,
    paragraphs: bullets.map((text) => ({ runs: [{ text, color: style.text }], bullet: true })),
    fontFace: style.bodyFont,
    fontSizePt,
    align: 'left',
    valign: 'top',
    shrinkToFit: true,
    lineSpacingMultiple: 1.15,
    paraSpaceAfterPt: 14,
    bulletIndentPt: 14,
  };
}

// ---------------------------------------------------------------------------
// Slide chrome
// ---------------------------------------------------------------------------

function layoutTitleSlide(spec: DeckSpec, style: DeckStyle): DeckSlideLayout {
  const primitives: DeckPrimitive[] = [
    // Motif first: it is a background mark, so the headline sits over it.
    ...motif(style, style.accent),
    { kind: 'rect', box: { x: MARGIN, y: 2.35, w: 1.1, h: 0.14 }, fill: style.accent },
    plainText(spec.title, style.text, { x: MARGIN, y: 2.65, w: BODY_W, h: 1.9 }, {
      fontFace: style.headingFont,
      fontSizePt: TYPE.deckTitle,
      bold: true,
      shrinkToFit: true,
    }),
  ];
  if (spec.subtitle) {
    primitives.push(
      plainText(spec.subtitle, style.muted, { x: MARGIN, y: 4.55, w: BODY_W, h: 0.9 }, {
        fontFace: style.bodyFont,
        fontSizePt: TYPE.deckSubtitle,
      }),
    );
  }
  return { background: style.background, primitives };
}

function header(style: DeckStyle, title: string): DeckPrimitive[] {
  return [
    plainText(title, style.text, { x: MARGIN, y: 0.5, w: BODY_W, h: 0.85 }, {
      fontFace: style.headingFont,
      fontSizePt: TYPE.header,
      bold: true,
      shrinkToFit: true,
    }),
    { kind: 'rect', box: { x: MARGIN + 0.02, y: 1.42, w: 0.75, h: 0.09 }, fill: style.accent },
  ];
}

function withFooter(slide: DeckSlideLayout, style: DeckStyle, deckTitle: string, pageNum: number): DeckSlideLayout {
  slide.primitives.push(
    plainText(deckTitle, style.muted, { x: MARGIN, y: DECK_PAGE_H - 0.5, w: 6, h: 0.3 }, {
      fontFace: style.bodyFont,
      fontSizePt: TYPE.footer,
    }),
    plainText(String(pageNum), style.muted, { x: DECK_PAGE_W - MARGIN - 1, y: DECK_PAGE_H - 0.5, w: 1, h: 0.3 }, {
      fontFace: style.bodyFont,
      fontSizePt: TYPE.footer,
      align: 'right',
    }),
  );
  return slide;
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

function layoutContentSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const primitives = header(style, slide.title);
  const top = BODY_TOP;
  const bodyH = BODY_H;
  const hasBullets = !!slide.bullets?.length;
  const sideBox: DeckBox = { x: 6.6, y: top, w: DECK_PAGE_W - 6.6 - MARGIN, h: bodyH };
  const fullBox: DeckBox = { x: MARGIN, y: top, w: BODY_W, h: bodyH };

  if (slide.chart && hasBullets) {
    primitives.push(bulletBlock(style, slide.bullets!, { x: MARGIN, y: top + 0.1, w: 5.3, h: bodyH }, TYPE.bodyTight));
    primitives.push(...layoutChart(slide.chart, style, sideBox));
  } else if (slide.chart) {
    primitives.push(...layoutChart(slide.chart, style, fullBox));
  } else if (slide.image && hasBullets) {
    primitives.push(bulletBlock(style, slide.bullets!, { x: MARGIN, y: top + 0.1, w: 5.3, h: bodyH }, TYPE.bodyTight));
    primitives.push(...layoutImage(slide.image, style, sideBox));
  } else if (slide.image) {
    primitives.push(...layoutImage(slide.image, style, fullBox));
  } else if (hasBullets) {
    primitives.push(bulletBlock(style, slide.bullets!, { x: MARGIN, y: top + 0.1, w: BODY_W, h: bodyH }));
  }
  return { background: style.background, primitives };
}

function layoutImage(image: DeckImage, style: DeckStyle, box: DeckBox): DeckPrimitive[] {
  const captionH = image.caption ? 0.45 : 0;
  const primitives: DeckPrimitive[] = [
    {
      kind: 'image',
      frame: { ...box, h: box.h - captionH },
      source: { url: image.url, path: image.path },
    },
  ];
  if (image.caption) {
    primitives.push(
      plainText(image.caption, style.muted, { x: box.x, y: box.y + box.h - captionH, w: box.w, h: captionH }, {
        fontFace: style.bodyFont,
        fontSizePt: TYPE.caption,
        align: 'center',
      }),
    );
  }
  return primitives;
}

function layoutSectionSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const primitives: DeckPrimitive[] = [
    // Inverted slide, so the mark takes the background colour to stay legible.
    ...motif(style, style.background),
    plainText(slide.title, style.background, { x: MARGIN, y: 2.75, w: BODY_W, h: 1.6 }, {
      fontFace: style.headingFont,
      fontSizePt: TYPE.section,
      bold: true,
      align: 'center',
      shrinkToFit: true,
    }),
  ];
  if (slide.subtext) {
    primitives.push(
      plainText(slide.subtext, style.background, { x: MARGIN, y: 4.4, w: BODY_W, h: 0.8 }, {
        fontFace: style.bodyFont,
        fontSizePt: TYPE.displaySub,
        align: 'center',
      }),
    );
  }
  // Inverted: accent background, background-colored text.
  return { background: style.accent, primitives };
}

function layoutStatementSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const primitives: DeckPrimitive[] = [
    { kind: 'rect', box: { x: DECK_PAGE_W / 2 - 0.55, y: 2.1, w: 1.1, h: 0.12 }, fill: style.accent },
    plainText(slide.title, style.text, { x: MARGIN, y: 2.5, w: BODY_W, h: 2.0 }, {
      fontFace: style.headingFont,
      fontSizePt: TYPE.statement,
      bold: true,
      align: 'center',
      shrinkToFit: true,
    }),
  ];
  if (slide.subtext) {
    primitives.push(
      plainText(slide.subtext, style.muted, { x: MARGIN + 1.2, y: 4.6, w: BODY_W - 2.4, h: 0.9 }, {
        fontFace: style.bodyFont,
        fontSizePt: TYPE.displaySub,
        align: 'center',
      }),
    );
  }
  return { background: style.background, primitives };
}

function layoutStatsSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const primitives = header(style, slide.title);
  const stats: DeckStat[] = slide.stats ?? [];
  const gap = 0.4;
  const tileW = (BODY_W - gap * (stats.length - 1)) / stats.length;
  const tileY = 2.35;
  const tileH = 2.7;
  // ONE measured size for every tile in the row. Sizing each box on its own —
  // which is all `shrinkToFit` can do — renders "47,000" visibly smaller than
  // "68%" beside it, and only in PowerPoint. See text-metrics.ts.
  const valueSize = fitOneLine(
    stats.map((s) => s.value),
    tileW,
    style.headingFont,
    TYPE.statValue,
    TYPE.statValueMin,
  );
  stats.forEach((stat, i) => {
    const x = MARGIN + i * (tileW + gap);
    primitives.push(
      { kind: 'rect', box: { x, y: tileY, w: tileW, h: tileH }, fill: style.panel, radiusIn: 0.08 },
      plainText(stat.value, style.accent, { x, y: tileY + 0.45, w: tileW, h: 1.2 }, {
        fontFace: style.headingFont,
        fontSizePt: valueSize,
        bold: true,
        align: 'center',
        // Net for the TYPE.statValueMin clamp only; never engages for input
        // the schema admits.
        shrinkToFit: true,
      }),
      plainText(stat.label, style.muted, { x: x + 0.15, y: tileY + 1.7, w: tileW - 0.3, h: 0.8 }, {
        fontFace: style.bodyFont,
        fontSizePt: TYPE.statLabel,
        align: 'center',
      }),
    );
  });
  if (slide.bullets?.length) {
    primitives.push(
      bulletBlock(style, slide.bullets, { x: MARGIN, y: tileY + tileH + 0.35, w: BODY_W, h: 1.4 }, TYPE.statSupport),
    );
  }
  return { background: style.background, primitives };
}

/**
 * Full-bleed image with the headline over it. The scrim is what makes the text
 * legible over an arbitrary photo, so it is not optional.
 */
function layoutHeroSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const primitives: DeckPrimitive[] = [];
  if (slide.image) {
    primitives.push({
      kind: 'image',
      frame: { x: 0, y: 0, w: DECK_PAGE_W, h: DECK_PAGE_H },
      source: { url: slide.image.url, path: slide.image.path },
      fit: 'cover',
    });
  }
  primitives.push(
    {
      kind: 'rect',
      box: { x: 0, y: 0, w: DECK_PAGE_W, h: DECK_PAGE_H },
      fill: HERO_SCRIM,
      transparencyPct: HERO_SCRIM_TRANSPARENCY,
    },
    { kind: 'rect', box: { x: MARGIN, y: DECK_PAGE_H - 3.25, w: 1.1, h: 0.14 }, fill: style.accent },
    plainText(slide.title, HERO_TEXT, { x: MARGIN, y: DECK_PAGE_H - 2.95, w: BODY_W - 1.5, h: 1.9 }, {
      fontFace: style.headingFont,
      fontSizePt: TYPE.hero,
      bold: true,
      shrinkToFit: true,
    }),
  );
  if (slide.subtext) {
    primitives.push(
      plainText(slide.subtext, HERO_SUBTEXT, { x: MARGIN, y: DECK_PAGE_H - 1.0, w: BODY_W - 1.5, h: 0.6 }, {
        fontFace: style.bodyFont,
        fontSizePt: TYPE.displaySub,
      }),
    );
  }
  return { background: style.background, primitives };
}

/** Two side-by-side panels. The headings take different accents so the two sides read as opposed, not sequential. */
function layoutComparisonSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const primitives = header(style, slide.title);
  const columns: DeckColumn[] = slide.columns ?? [];
  const gap = 0.5;
  const colW = (BODY_W - gap) / 2;
  const headingColors = [style.accent, style.accentAlt];

  columns.forEach((column, i) => {
    const x = MARGIN + i * (colW + gap);
    primitives.push(
      { kind: 'rect', box: { x, y: BODY_TOP, w: colW, h: BODY_H }, fill: style.panel, radiusIn: 0.06 },
      plainText(column.heading, headingColors[i], { x: x + 0.35, y: BODY_TOP + 0.3, w: colW - 0.7, h: 0.6 }, {
        fontFace: style.headingFont,
        fontSizePt: TYPE.columnHeading,
        bold: true,
        shrinkToFit: true,
      }),
      {
        kind: 'lineSeg',
        x1: x + 0.35,
        y1: BODY_TOP + 0.95,
        x2: x + colW - 0.35,
        y2: BODY_TOP + 0.95,
        color: style.grid,
        widthPt: 1,
      },
      bulletBlock(
        style,
        column.bullets,
        { x: x + 0.35, y: BODY_TOP + 1.15, w: colW - 0.7, h: BODY_H - 1.5 },
        TYPE.bodyTight,
      ),
    );
  });
  return { background: style.background, primitives };
}

/** 2-6 steps along a horizontal axis: label above the node, detail below. */
function layoutTimelineSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const primitives = header(style, slide.title);
  const steps: DeckStep[] = slide.steps ?? [];
  const axisY = BODY_TOP + BODY_H / 2 - 0.2;
  const slotW = BODY_W / steps.length;
  const node = 0.24;

  primitives.push({
    kind: 'lineSeg',
    x1: MARGIN + slotW / 2,
    y1: axisY,
    x2: MARGIN + BODY_W - slotW / 2,
    y2: axisY,
    color: style.grid,
    widthPt: 2,
  });

  steps.forEach((step, i) => {
    const cx = MARGIN + slotW * (i + 0.5);
    primitives.push(
      plainText(step.label, style.text, { x: cx - slotW / 2, y: axisY - 1.0, w: slotW, h: 0.6 }, {
        fontFace: style.headingFont,
        fontSizePt: TYPE.stepLabel,
        bold: true,
        align: 'center',
        valign: 'bottom',
        shrinkToFit: true,
      }),
      {
        kind: 'ellipse',
        box: { x: cx - node / 2, y: axisY - node / 2, w: node, h: node },
        fill: style.accent,
        // Surface-coloured ring so the node reads as sitting ON the axis.
        outline: { color: style.background, widthPt: 2 },
      },
    );
    if (step.detail) {
      primitives.push(
        plainText(step.detail, style.muted, { x: cx - slotW / 2 + 0.12, y: axisY + 0.35, w: slotW - 0.24, h: 1.1 }, {
          fontFace: style.bodyFont,
          fontSizePt: TYPE.stepDetail,
          align: 'center',
        }),
      );
    }
  });
  return { background: style.background, primitives };
}

/** Numbered list; splits into two columns past 5 items so it never runs off the page. */
function layoutAgendaSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const primitives = header(style, slide.title);
  const items = slide.bullets ?? [];
  const twoCol = items.length > 5;
  const perCol = twoCol ? Math.ceil(items.length / 2) : items.length;
  const colGap = 0.7;
  const colW = twoCol ? (BODY_W - colGap) / 2 : BODY_W;
  const rowH = Math.min(0.78, BODY_H / perCol);
  const numW = 0.55;

  items.forEach((item, i) => {
    const col = twoCol && i >= perCol ? 1 : 0;
    const row = col === 1 ? i - perCol : i;
    const x = MARGIN + col * (colW + colGap);
    const y = BODY_TOP + row * rowH;
    primitives.push(
      plainText(String(i + 1).padStart(2, '0'), style.accent, { x, y, w: numW, h: rowH }, {
        fontFace: style.headingFont,
        fontSizePt: TYPE.agendaNum,
        bold: true,
        valign: 'middle',
      }),
      plainText(item, style.text, { x: x + numW, y, w: colW - numW, h: rowH }, {
        fontFace: style.bodyFont,
        fontSizePt: TYPE.agendaItem,
        valign: 'middle',
        shrinkToFit: true,
      }),
      { kind: 'lineSeg', x1: x, y1: y + rowH, x2: x + colW, y2: y + rowH, color: style.grid, widthPt: 1 },
    );
  });
  return { background: style.background, primitives };
}

/**
 * A grid drawn from rects + text, NOT pptxgenjs `addTable`.
 *
 * A native table computes its own row heights inside PowerPoint, which the
 * preview cannot see — the two would disagree the moment a cell wrapped, which
 * is exactly the drift the display list exists to prevent. (The connector also
 * had to pass `autoPage: false` to stop a native table silently spilling onto
 * extra slides and desyncing the footer page numbers.) Row heights here are
 * derived from measured text width, so both renderers get the same grid.
 */
function layoutTableSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const primitives = header(style, slide.title);
  const table: DeckTable = slide.table ?? { headers: [], rows: [] };
  const cols = table.headers.length;
  if (!cols) return { background: style.background, primitives };

  const colW = BODY_W / cols;
  const padX = 0.12;
  const usableW = colW - 2 * padX - 2 * TEXT_INSET;
  const lineH = (TYPE.tableCell * 1.25) / 72; // inches per rendered line
  const minRowH = 0.42;

  /** Lines a cell wraps to at tableCell size, from the same metrics fitOneLine uses. */
  const linesFor = (text: string, fontFace: string): number => {
    const widthIn = (widthInEm(text, fontFace) * TYPE.tableCell) / 72;
    return Math.max(1, Math.ceil(widthIn / usableW));
  };
  const rowHeight = (cells: readonly string[], fontFace: string): number =>
    Math.max(minRowH, Math.max(...cells.map((c) => linesFor(c, fontFace))) * lineH + 0.2);

  const bands: { cells: readonly string[]; head: boolean; h: number }[] = [
    { cells: table.headers, head: true, h: rowHeight(table.headers, style.headingFont) },
    ...table.rows.map((r) => ({ cells: r, head: false, h: rowHeight(r, style.bodyFont) })),
  ];

  // The metrics tables cover numerals, so letters are charged the widest
  // capital — deliberately conservative, but at the schema's maximum (8 rows of
  // 50-char cells) the estimate exceeds the body box. Scale the grid to fit
  // rather than running off the page; cell text keeps shrinkToFit as the net.
  const total = bands.reduce((sum, b) => sum + b.h, 0);
  if (total > BODY_H) {
    const k = BODY_H / total;
    for (const band of bands) band.h *= k;
  }

  let y = BODY_TOP;
  for (const band of bands) {
    if (band.head) {
      primitives.push({ kind: 'rect', box: { x: MARGIN, y, w: BODY_W, h: band.h }, fill: style.panel });
    }
    band.cells.forEach((cell, c) => {
      primitives.push(
        plainText(cell, style.text, { x: MARGIN + c * colW + padX, y, w: colW - 2 * padX, h: band.h }, {
          fontFace: band.head ? style.headingFont : style.bodyFont,
          fontSizePt: TYPE.tableCell,
          bold: band.head,
          valign: 'middle',
          // Net for the scaled-grid case above only.
          shrinkToFit: true,
        }),
      );
    });
    // Rule under every band, so the grid closes on the last row too.
    primitives.push({
      kind: 'lineSeg',
      x1: MARGIN,
      y1: y + band.h,
      x2: MARGIN + BODY_W,
      y2: y + band.h,
      color: style.grid,
      widthPt: 1,
    });
    y += band.h;
  }
  return { background: style.background, primitives };
}

function layoutQuoteSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const quote = slide.quote;
  const primitives = quote
    ? [
        plainText('“', style.accent, { x: MARGIN - 0.15, y: 0.9, w: 1.6, h: 1.6 }, {
          fontFace: 'Georgia',
          fontSizePt: TYPE.quoteMark,
          bold: true,
        }),
        plainText(quote.text, style.text, { x: MARGIN + 0.7, y: 2.4, w: BODY_W - 1.4, h: 2.5 }, {
          fontFace: style.bodyFont,
          fontSizePt: TYPE.quote,
          italic: true,
          shrinkToFit: true,
          lineSpacingMultiple: 1.2,
        }),
      ]
    : [];
  if (quote?.attribution) {
    primitives.push(
      plainText(quote.attribution, style.muted, { x: MARGIN + 0.7, y: 5.1, w: BODY_W - 1.4, h: 0.5 }, {
        fontFace: style.bodyFont,
        fontSizePt: TYPE.quoteAttr,
      }),
    );
  }
  return { background: style.background, primitives };
}

// ---------------------------------------------------------------------------
// Charts — drawn from primitives, never OOXML chart parts (Keynote drops them)
// ---------------------------------------------------------------------------

export function formatChartValue(value: number, unit?: string): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  let num: string;
  if (abs >= 1e9) num = `${trimZero(abs / 1e9)}B`;
  else if (abs >= 1e6) num = `${trimZero(abs / 1e6)}M`;
  else if (abs >= 1e4) num = `${trimZero(abs / 1e3)}K`;
  else num = abs % 1 === 0 ? String(abs) : abs.toFixed(1);
  const magnitude = `${sign}${num}`;
  if (!unit) return magnitude;
  if (unit === '%') return `${magnitude}%`;
  // Currency symbols read as a prefix; anything else (e.g. 'users') as a suffix.
  return /^[$€£¥₩₹]$/.test(unit) ? `${sign}${unit}${num}` : `${magnitude} ${unit}`;
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

function layoutChart(chart: DeckChart, style: DeckStyle, box: DeckBox): DeckPrimitive[] {
  if (chart.type === 'pie' || chart.type === 'doughnut') return layoutPieChart(chart, style, box);
  if (chart.type === 'line') return layoutLineChart(chart, style, box);
  return layoutBarChart(chart, style, box);
}

/**
 * Bars render a true min/max range: negative values hang below the zero
 * baseline with their value labels underneath (the source repo clamped
 * negatives to zero — silent misrepresentation).
 */
function layoutBarChart(chart: DeckChart, style: DeckStyle, box: DeckBox): DeckPrimitive[] {
  const n = chart.values.length;
  const maxVal = Math.max(...chart.values, 0);
  const minVal = Math.min(...chart.values, 0);
  const range = maxVal - minVal || 1;
  const labelH = 0.32; // category labels under the plot
  const valueH = 0.3; // value labels above/below bars
  const plot: DeckBox = { x: box.x, y: box.y + valueH, w: box.w, h: box.h - valueH - labelH };
  const zeroY = plot.y + (maxVal / range) * plot.h;

  const primitives: DeckPrimitive[] = [];
  const slotW = plot.w / n;
  const barW = Math.min(slotW * 0.62, 1.4);
  chart.values.forEach((value, i) => {
    const barH = Math.max((Math.abs(value) / range) * plot.h, 0.02);
    const x = plot.x + i * slotW + (slotW - barW) / 2;
    const barY = value >= 0 ? zeroY - barH : zeroY;
    primitives.push({ kind: 'rect', box: { x, y: barY, w: barW, h: barH }, fill: style.accent });
    primitives.push(
      plainText(
        formatChartValue(value, chart.unit),
        style.text,
        value >= 0
          ? { x: plot.x + i * slotW, y: barY - valueH, w: slotW, h: valueH }
          : { x: plot.x + i * slotW, y: barY + barH + 0.02, w: slotW, h: valueH },
        {
          fontFace: style.bodyFont,
          fontSizePt: TYPE.chartValue,
          align: 'center',
          valign: value >= 0 ? 'bottom' : 'top',
        },
      ),
    );
    primitives.push(
      plainText(chart.labels[i], style.muted, { x: plot.x + i * slotW, y: plot.y + plot.h + 0.06, w: slotW, h: labelH }, {
        fontFace: style.bodyFont,
        fontSizePt: TYPE.chartLabel,
        align: 'center',
      }),
    );
  });
  primitives.push({ kind: 'lineSeg', x1: plot.x, y1: zeroY, x2: plot.x + plot.w, y2: zeroY, color: style.grid, widthPt: 1 });
  return primitives;
}

function layoutLineChart(chart: DeckChart, style: DeckStyle, box: DeckBox): DeckPrimitive[] {
  const n = chart.values.length;
  const maxVal = Math.max(...chart.values, 0);
  const minVal = Math.min(...chart.values, 0);
  const range = maxVal - minVal || 1;
  const labelH = 0.32;
  const valueH = 0.3;
  const plot: DeckBox = { x: box.x + 0.2, y: box.y + valueH, w: box.w - 0.4, h: box.h - valueH - labelH };
  const baselineY = plot.y + plot.h;
  const showValues = n <= 8;

  const px = (i: number) => plot.x + (n === 1 ? plot.w / 2 : (i / (n - 1)) * plot.w);
  const py = (v: number) => baselineY - ((v - minVal) / range) * plot.h;

  const primitives: DeckPrimitive[] = [
    { kind: 'lineSeg', x1: plot.x, y1: baselineY, x2: plot.x + plot.w, y2: baselineY, color: style.grid, widthPt: 1 },
  ];
  for (let i = 0; i < n - 1; i++) {
    primitives.push({
      kind: 'lineSeg',
      x1: px(i),
      y1: py(chart.values[i]),
      x2: px(i + 1),
      y2: py(chart.values[i + 1]),
      color: style.accent,
      widthPt: 2.5,
    });
  }
  const marker = 0.11;
  chart.values.forEach((value, i) => {
    primitives.push({
      kind: 'ellipse',
      box: { x: px(i) - marker / 2, y: py(value) - marker / 2, w: marker, h: marker },
      fill: style.accent,
      outline: { color: style.background, widthPt: 1.5 }, // surface ring over crossing marks
    });
    if (showValues) {
      primitives.push(
        plainText(formatChartValue(value, chart.unit), style.text, { x: px(i) - 0.6, y: py(value) - marker / 2 - valueH, w: 1.2, h: valueH }, {
          fontFace: style.bodyFont,
          fontSizePt: TYPE.chartValue,
          align: 'center',
          valign: 'bottom',
        }),
      );
    }
    primitives.push(
      plainText(chart.labels[i], style.muted, { x: px(i) - 0.75, y: baselineY + 0.06, w: 1.5, h: labelH }, {
        fontFace: style.bodyFont,
        fontSizePt: TYPE.chartLabel,
        align: 'center',
      }),
    );
  });
  return primitives;
}

function layoutPieChart(chart: DeckChart, style: DeckStyle, box: DeckBox): DeckPrimitive[] {
  const total = chart.values.reduce((sum, v) => sum + Math.max(v, 0), 0) || 1;
  const legendW = 2.9;
  const side = Math.min(box.h, box.w - legendW - 0.3);
  const cx = box.x + (box.w - legendW - 0.3 - side) / 2;
  const cy = box.y + (box.h - side) / 2;

  const primitives: DeckPrimitive[] = [];
  let angle = 270; // start at 12 o'clock, sweep clockwise
  chart.values.forEach((value, i) => {
    const sweep = (Math.max(value, 0) / total) * 360;
    if (sweep <= 0) return;
    primitives.push({
      kind: 'pieArc',
      box: { x: cx, y: cy, w: side, h: side },
      startDeg: angle % 360,
      sweepDeg: sweep,
      thicknessRatio: chart.type === 'doughnut' ? 0.35 : undefined,
      fill: style.chartCategorical[i % style.chartCategorical.length],
      outline: { color: style.background, widthPt: 2 }, // surface gap between slices
    });
    angle += sweep;
  });

  const rows = chart.labels.length;
  const rowH = 0.34;
  const legendX = box.x + box.w - legendW;
  const legendY = box.y + Math.max((box.h - rows * rowH) / 2, 0);
  chart.labels.forEach((label, i) => {
    const y = legendY + i * rowH;
    primitives.push({
      kind: 'rect',
      box: { x: legendX, y: y + 0.09, w: 0.16, h: 0.16 },
      fill: style.chartCategorical[i % style.chartCategorical.length],
    });
    const pct = Math.round((Math.max(chart.values[i], 0) / total) * 100);
    const detail =
      chart.unit === '%' ? `${pct}%` : `${formatChartValue(chart.values[i], chart.unit)} · ${pct}%`;
    primitives.push({
      kind: 'text',
      box: { x: legendX + 0.28, y, w: legendW - 0.28, h: rowH },
      paragraphs: [
        {
          runs: [
            { text: `${label}  `, color: style.text },
            { text: detail, color: style.muted },
          ],
        },
      ],
      fontFace: style.bodyFont,
      fontSizePt: TYPE.chartLabel,
      align: 'left',
      valign: 'middle',
    });
  });
  return primitives;
}
