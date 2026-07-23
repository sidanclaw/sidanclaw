import { describe, expect, it } from 'vitest';
import {
  applyDeckOps,
  deckOpSchema,
  deckSlideInputSchema,
  deckSpecInputSchema,
  deckSpecSchema,
  type DeckOp,
  type DeckSpec,
} from '../decks/spec.js';
import {
  DECK_PRESET_STYLES,
  contrastRatio,
  deriveDeckStyle,
  resolveDeckStyle,
} from '../decks/theme.js';
import { DECK_PAGE_H, DECK_PAGE_W, TYPE, formatChartValue, layoutDeck, type DeckPrimitive } from '../decks/layout.js';

const baseSpec: DeckSpec = deckSpecSchema.parse({
  title: 'Quarterly Review',
  subtitle: 'Q2 2026',
  slides: [
    { title: 'Agenda', bullets: ['Numbers', 'Wins', 'Next quarter'], notes: 'Keep it brief' },
    { title: 'The Numbers', layout: 'section' },
    { title: 'Revenue', bullets: ['Up 12% QoQ'] },
  ],
});

describe('[COMP:decks/spec] Deck spec schema', () => {
  it('accepts a minimal valid spec', () => {
    const parsed = deckSpecSchema.parse({ title: 'T', slides: [{ title: 'S', bullets: ['b'] }] });
    expect(parsed.theme).toBeUndefined();
    expect(parsed.slides).toHaveLength(1);
  });

  it('rejects unknown slide fields instead of silently dropping them', () => {
    expect(() =>
      deckSpecSchema.parse({ title: 'T', slides: [{ title: 'S', content: 'body text here' }] }),
    ).toThrow(/[Uu]nrecognized/);
  });

  it('rejects a content slide with no body, allows title-only statement/section', () => {
    expect(() => deckSpecSchema.parse({ title: 'T', slides: [{ title: 'S' }] })).toThrow(/no body/);
    expect(() =>
      deckSpecSchema.parse({ title: 'T', slides: [{ title: 'S', layout: 'statement' }] }),
    ).not.toThrow();
  });

  it('requires exactly one of image.url / image.path', () => {
    const slide = (image: object) => ({ title: 'T', slides: [{ title: 'S', image }] });
    expect(() => deckSpecSchema.parse(slide({ url: 'https://x.com/a.png', path: 'uploads/a.png' }))).toThrow(
      /exactly one/,
    );
    expect(() => deckSpecSchema.parse(slide({ caption: 'no source' }))).toThrow(/exactly one/);
    expect(() => deckSpecSchema.parse(slide({ path: 'uploads/a.png' }))).not.toThrow();
    expect(() => deckSpecSchema.parse(slide({ url: 'https://x.com/a.png' }))).not.toThrow();
  });

  it('rejects negative values for pie/doughnut with an actionable message', () => {
    for (const type of ['pie', 'doughnut'] as const) {
      expect(() =>
        deckSpecSchema.parse({
          title: 'T',
          slides: [{ title: 'Loss', chart: { type, labels: ['a', 'b'], values: [5, -3] } }],
        }),
      ).toThrow(/bar chart/);
    }
    // bar accepts negatives — they render as a true range
    expect(() =>
      deckSpecSchema.parse({
        title: 'T',
        slides: [{ title: 'Loss', chart: { type: 'bar', labels: ['a', 'b'], values: [5, -3] } }],
      }),
    ).not.toThrow();
  });

  it('caps deck images at 10', () => {
    const slides = Array.from({ length: 11 }, (_, i) => ({
      title: `S${i}`,
      image: { url: `https://x.com/${i}.png` },
    }));
    expect(() => deckSpecSchema.parse({ title: 'T', slides })).toThrow(/max 10/);
  });

  it('rejects stats layout without stats and chart label/value mismatch', () => {
    expect(() => deckSpecSchema.parse({ title: 'T', slides: [{ title: 'S', layout: 'stats' }] })).toThrow(/stats/);
    expect(() =>
      deckSpecSchema.parse({
        title: 'T',
        slides: [{ title: 'S', chart: { type: 'bar', labels: ['a', 'b'], values: [1] } }],
      }),
    ).toThrow(/same length/);
  });
});

describe('[COMP:decks/spec] applyDeckOps', () => {
  it('replace / insert / delete / move / setMeta compose in order', () => {
    const ops: DeckOp[] = [
      { op: 'replaceSlide', index: 2, slide: { title: 'Revenue v2', bullets: ['Up 20% QoQ'] } },
      { op: 'insertSlide', index: 1, slide: { title: 'Wins', layout: 'statement', subtext: 'Big ones.' } },
      { op: 'moveSlide', from: 0, to: 3 },
      { op: 'setMeta', title: 'Quarterly Review v2', subtitle: null },
    ];
    const next = applyDeckOps(baseSpec, ops);
    expect(next.title).toBe('Quarterly Review v2');
    expect(next.subtitle).toBeUndefined();
    expect(next.slides.map((s) => s.title)).toEqual(['Wins', 'The Numbers', 'Revenue v2', 'Agenda']);
    // source spec untouched (pure)
    expect(baseSpec.slides.map((s) => s.title)).toEqual(['Agenda', 'The Numbers', 'Revenue']);
  });

  it('throws actionable errors on out-of-range and last-slide delete', () => {
    expect(() => applyDeckOps(baseSpec, [{ op: 'replaceSlide', index: 9, slide: { title: 'X', bullets: ['b'] } }])).toThrow(
      /out of range.*3 slides/,
    );
    const one = deckSpecSchema.parse({ title: 'T', slides: [{ title: 'S', bullets: ['b'] }] });
    expect(() => applyDeckOps(one, [{ op: 'deleteSlide', index: 0 }])).toThrow(/last remaining/);
  });

  it('re-validates the final spec so ops cannot construct an invalid deck', () => {
    const full = deckSpecSchema.parse({
      title: 'T',
      slides: Array.from({ length: 50 }, (_, i) => ({ title: `S${i}`, bullets: ['b'] })),
    });
    expect(() =>
      applyDeckOps(full, [{ op: 'insertSlide', index: 0, slide: { title: 'One more', bullets: ['b'] } }]),
    ).toThrow(/50/);
  });
});

describe('[COMP:decks/style] Deck style resolution + derivation', () => {
  it('resolveDeckStyle prefers an extracted style over theme presets', () => {
    const style = { ...DECK_PRESET_STYLES.dark, accent: 'ABCDEF' };
    expect(resolveDeckStyle('light', style)).toBe(style);
    expect(resolveDeckStyle('dark', null)).toBe(DECK_PRESET_STYLES.dark);
    expect(resolveDeckStyle(undefined, undefined)).toBe(DECK_PRESET_STYLES.light);
  });

  it('derives a readable style from a reference scheme', () => {
    const style = deriveDeckStyle({
      lt1: 'FFFFFF',
      dk1: '1A1A2E',
      accents: ['E94560', '0F3460', '16C79A', '533483', 'F0A500', '798777'],
      majorFont: 'Montserrat',
      minorFont: 'Lato',
    });
    expect(style.background).toBe('FFFFFF');
    expect(style.headingFont).toBe('Montserrat');
    expect(style.bodyFont).toBe('Lato');
    expect(contrastRatio(style.background, style.text)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(style.background, style.accent)).toBeGreaterThanOrEqual(2);
    for (const c of style.chartCategorical) {
      expect(contrastRatio(style.background, c)).toBeGreaterThanOrEqual(2);
    }
  });

  it('contrast-guards a low-contrast reference (grey-on-grey text snaps readable)', () => {
    const style = deriveDeckStyle({ lt1: 'EEEEEE', dk1: 'CCCCCC', accents: ['DDDDDD'] });
    expect(contrastRatio(style.background, style.text)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(style.background, style.accent)).toBeGreaterThanOrEqual(2);
  });

  it('falls back to defaults on a garbage scheme', () => {
    const style = deriveDeckStyle({ accents: [] });
    expect(style.background).toBe(DECK_PRESET_STYLES.light.background);
    expect(style.headingFont).toBe('Arial');
    expect(style.chartCategorical.length).toBeGreaterThanOrEqual(6);
  });
});

describe('[COMP:decks/layout] Deck layout engine', () => {
  const style = DECK_PRESET_STYLES.light;

  function texts(primitives: DeckPrimitive[]): string[] {
    return primitives
      .filter((p): p is Extract<DeckPrimitive, { kind: 'text' }> => p.kind === 'text')
      .flatMap((p) => p.paragraphs.flatMap((para) => para.runs.map((r) => r.text)));
  }

  it('emits one auto title slide plus one layout per spec slide', () => {
    const slides = layoutDeck(baseSpec, style);
    expect(slides).toHaveLength(baseSpec.slides.length + 1);
    expect(texts(slides[0].primitives)).toContain('Quarterly Review');
    expect(slides[1].notes).toBe('Keep it brief');
  });

  it('keeps every primitive on the page', () => {
    const spec = deckSpecSchema.parse({
      title: 'Everything',
      slides: [
        { title: 'Bullets', bullets: ['a', 'b'] },
        { title: 'Stats', layout: 'stats', stats: [{ value: '1', label: 'one' }, { value: '2', label: 'two' }] },
        { title: 'Quote', layout: 'quote', quote: { text: 'Nice.', attribution: 'CEO' } },
        { title: 'Bar', chart: { type: 'bar', labels: ['a', 'b'], values: [3, -2] } },
        { title: 'Pie', chart: { type: 'pie', labels: ['x', 'y'], values: [1, 3] } },
      ],
    });
    for (const slide of layoutDeck(spec, style)) {
      for (const p of slide.primitives) {
        const box = p.kind === 'lineSeg' ? { x: Math.min(p.x1, p.x2), y: Math.min(p.y1, p.y2), w: Math.abs(p.x2 - p.x1), h: Math.abs(p.y2 - p.y1) } : p.kind === 'image' ? p.frame : p.box;
        expect(box.x).toBeGreaterThanOrEqual(-0.2);
        expect(box.y).toBeGreaterThanOrEqual(-0.2);
        expect(box.x + box.w).toBeLessThanOrEqual(DECK_PAGE_W + 0.01);
        expect(box.y + box.h).toBeLessThanOrEqual(DECK_PAGE_H + 0.01);
      }
    }
  });

  it('renders negative bars below the zero baseline (true range, not clamped)', () => {
    const spec = deckSpecSchema.parse({
      title: 'Loss',
      slides: [{ title: 'PnL', chart: { type: 'bar', labels: ['Q1', 'Q2'], values: [100, -50] } }],
    });
    const [, slide] = layoutDeck(spec, style);
    const bars = slide.primitives.filter(
      (p): p is Extract<DeckPrimitive, { kind: 'rect' }> => p.kind === 'rect' && p.fill === style.accent,
    );
    const baseline = slide.primitives.find(
      (p): p is Extract<DeckPrimitive, { kind: 'lineSeg' }> => p.kind === 'lineSeg' && p.color === style.grid,
    );
    // exclude the header accent bar (w 0.75) — chart bars are the two widest accent rects
    const chartBars = bars.filter((b) => b.box.h > 0.1 || b.box.w > 0.8).slice(-2);
    expect(baseline).toBeDefined();
    const zeroY = baseline!.y1;
    const [positive, negative] = chartBars;
    expect(positive.box.y + positive.box.h).toBeCloseTo(zeroY, 5); // grows up to baseline
    expect(negative.box.y).toBeCloseTo(zeroY, 5); // hangs below baseline
    expect(negative.box.h / positive.box.h).toBeCloseTo(0.5, 1); // |−50| / |100|
  });

  it('pie arcs sweep to a full circle and legend carries values + percentages', () => {
    const spec = deckSpecSchema.parse({
      title: 'Share',
      slides: [{ title: 'Mix', chart: { type: 'doughnut', labels: ['A', 'B', 'C'], values: [50, 30, 20], unit: '%' } }],
    });
    const [, slide] = layoutDeck(spec, style);
    const arcs = slide.primitives.filter((p): p is Extract<DeckPrimitive, { kind: 'pieArc' }> => p.kind === 'pieArc');
    expect(arcs).toHaveLength(3);
    expect(arcs.reduce((sum, a) => sum + a.sweepDeg, 0)).toBeCloseTo(360, 5);
    expect(arcs.every((a) => a.thicknessRatio === 0.35)).toBe(true);
    expect(texts(slide.primitives).join(' ')).toContain('50%');
  });

  it('section slides invert to the accent background', () => {
    const slides = layoutDeck(baseSpec, style);
    expect(slides[2].background).toBe(style.accent);
    expect(slides[1].background).toBe(style.background);
  });

  it('formats chart values with sign, magnitude and unit', () => {
    expect(formatChartValue(340000, '$')).toBe('$340K');
    expect(formatChartValue(-340000, '$')).toBe('-$340K');
    expect(formatChartValue(1200000000)).toBe('1.2B');
    expect(formatChartValue(38, '%')).toBe('38%');
    expect(formatChartValue(-2.5, 'users')).toBe('-2.5 users');
  });
});

describe('[COMP:decks/spec] Content budgets (input schemas only)', () => {
  const ok = (slide: Record<string, unknown>) => deckSlideInputSchema.safeParse(slide);
  const errs = (r: ReturnType<typeof ok>) => (r.success ? [] : r.error.issues.map((i) => i.message));

  it('caps the title per layout, not globally', () => {
    const long = 'x'.repeat(60);
    // 'statement' is set at 60pt and holds 65 chars; 'content' at 30pt holds 48.
    expect(ok({ title: long, layout: 'statement' }).success).toBe(true);
    expect(errs(ok({ title: long, layout: 'content', bullets: ['b'] }))[0]).toMatch(/fits 48/);
  });

  it('rejects a field the layout will not render rather than dropping it', () => {
    // layoutQuoteSlide never reads `bullets` — accepting them is content loss.
    const r = ok({ title: 'T', layout: 'quote', quote: { text: 'q' }, bullets: ['lost'] });
    expect(errs(r)[0]).toMatch(/does not render `bullets`/);
    expect(errs(r)[0]).toMatch(/`quote`/); // names what it does render
  });

  it('caps bullet count and length on content slides', () => {
    expect(errs(ok({ title: 'T', bullets: Array(6).fill('b') }))[0]).toMatch(/max 5/);
    expect(errs(ok({ title: 'T', bullets: ['x'.repeat(120)] }))[0]).toMatch(/exceed 100 chars/);
  });

  it('applies the stats budget, which differs from content', () => {
    const stats = [{ value: '1', label: 'a' }];
    expect(ok({ title: 'T', layout: 'stats', stats, bullets: ['a', 'b'] }).success).toBe(true);
    expect(errs(ok({ title: 'T', layout: 'stats', stats, bullets: ['a', 'b', 'c'] }))[0]).toMatch(/max 2/);
  });

  it('enforces budgets on the slide payload of an op', () => {
    const bad = { op: 'replaceSlide', index: 0, slide: { title: 'x'.repeat(60), bullets: ['b'] } };
    expect(deckOpSchema.safeParse(bad).success).toBe(false);
    const good = { op: 'replaceSlide', index: 0, slide: { title: 'Short', bullets: ['b'] } };
    expect(deckOpSchema.safeParse(good).success).toBe(true);
  });

  it('enforces budgets on a whole generated spec', () => {
    const spec = { title: 'T', slides: [{ title: 'x'.repeat(60), bullets: ['b'] }] };
    expect(deckSpecInputSchema.safeParse(spec).success).toBe(false);
    expect(deckSpecSchema.safeParse(spec).success).toBe(true); // stored schema stays lenient
  });

  it('keeps a stored deck that predates the budgets editable', () => {
    // The regression this input/stored split exists to prevent: applyDeckOps
    // re-parses the WHOLE deck after every edit. If the budgets lived on the
    // stored schema, an old over-long slide elsewhere in the deck would make
    // every future edit fail, stranding the deck.
    const legacy = deckSpecSchema.parse({
      title: 'Old Deck',
      slides: [
        { title: 'x'.repeat(120), bullets: Array(9).fill('a very long legacy bullet '.repeat(6)) },
        { title: 'Fine', bullets: ['ok'] },
      ],
    });
    const ops: DeckOp[] = [{ op: 'replaceSlide', index: 1, slide: { title: 'Edited', bullets: ['still ok'] } }];
    const next = applyDeckOps(legacy, ops);
    expect(next.slides[1].title).toBe('Edited');
    expect(next.slides[0].title).toHaveLength(120); // untouched, still there
  });
});

describe('[COMP:decks/layout] Stat tile sizing', () => {
  const style = DECK_PRESET_STYLES.light;

  function statValueSizes(values: string[]): number[] {
    const spec = deckSpecSchema.parse({
      title: 'T',
      slides: [{ title: 'Traction', layout: 'stats', stats: values.map((v) => ({ value: v, label: 'l' })) }],
    });
    const primitives = layoutDeck(spec, style)[1].primitives;
    return primitives
      .filter((p): p is Extract<DeckPrimitive, { kind: 'text' }> => p.kind === 'text')
      .filter((p) => values.includes(p.paragraphs[0]?.runs[0]?.text ?? ''))
      .map((p) => p.fontSizePt);
  }

  it('sets every tile in a row at ONE size, driven by the widest value', () => {
    // The failure this prevents: PowerPoint's per-box shrink rendered "47,000"
    // visibly smaller than "68%" beside it. Keynote ignored the shrink entirely.
    const sizes = statValueSizes(['47,000', '68%', '$1.55M']);
    expect(sizes).toHaveLength(3);
    expect(new Set(sizes).size).toBe(1);
  });

  it('holds a wide row back below the display maximum, but not a narrow one', () => {
    expect(statValueSizes(['68%'])[0]).toBe(TYPE.statValue);
    expect(statValueSizes(['1,234,567', '2,345,678', '3,456,789', '4,567,890'])[0]).toBeLessThan(TYPE.statValue);
  });

  it('keeps the size at or above the floor where a number still reads as one', () => {
    // The schema's worst case: four tiles (the narrowest, 2.58in each) each
    // holding 20 chars, the `value` cap. Only reachable here.
    const worst = Array(4).fill('88888888888888888888');
    for (const size of statValueSizes(worst)) {
      expect(size).toBe(TYPE.statValueMin);
    }
  });
});

describe('[COMP:decks/layout] Phase-2 layouts', () => {
  const style = DECK_PRESET_STYLES.light;

  function render(slide: Record<string, unknown>): DeckPrimitive[] {
    const spec = deckSpecSchema.parse({ title: 'T', slides: [slide] });
    return layoutDeck(spec, style)[1].primitives;
  }
  const kinds = (ps: DeckPrimitive[]) => ps.map((p) => p.kind);
  const texts = (ps: DeckPrimitive[]) =>
    ps
      .filter((p): p is Extract<DeckPrimitive, { kind: 'text' }> => p.kind === 'text')
      .flatMap((p) => p.paragraphs.flatMap((para) => para.runs.map((r) => r.text)));

  it('hero: full-bleed cover image UNDER a scrim, headline over both', () => {
    const ps = render({ title: 'Ship it', layout: 'hero', image: { path: 'a.png' }, subtext: 'Q3' });
    const img = ps.find((p) => p.kind === 'image') as Extract<DeckPrimitive, { kind: 'image' }>;
    // cover, not contain: letterboxing a full-bleed photo would show the slide
    // background through the gaps.
    expect(img.fit).toBe('cover');
    expect(img.frame).toEqual({ x: 0, y: 0, w: DECK_PAGE_W, h: DECK_PAGE_H });
    const scrim = ps.find((p) => p.kind === 'rect' && p.transparencyPct !== undefined);
    expect(scrim).toBeDefined();
    // DOM order = paint order: image, then scrim, then text.
    expect(kinds(ps).indexOf('image')).toBeLessThan(ps.indexOf(scrim!));
    expect(ps.indexOf(scrim!)).toBeLessThan(kinds(ps).indexOf('text'));
    expect(texts(ps)).toContain('Ship it');
  });

  it('hero carries no footer — it would sit on the photo', () => {
    const spec = deckSpecSchema.parse({
      title: 'Deck',
      slides: [{ title: 'H', layout: 'hero', image: { path: 'a.png' } }],
    });
    expect(texts(layoutDeck(spec, style)[1].primitives)).not.toContain('2');
  });

  it('comparison: two panels whose headings take DIFFERENT accents', () => {
    const ps = render({
      title: 'Before / After',
      layout: 'comparison',
      columns: [
        { heading: 'Before', bullets: ['slow'] },
        { heading: 'After', bullets: ['fast'] },
      ],
    });
    const headings = ps.filter(
      (p): p is Extract<DeckPrimitive, { kind: 'text' }> =>
        p.kind === 'text' && ['Before', 'After'].includes(p.paragraphs[0].runs[0].text),
    );
    expect(headings).toHaveLength(2);
    const colors = headings.map((h) => h.paragraphs[0].runs[0].color);
    expect(colors[0]).toBe(style.accent);
    expect(colors[1]).toBe(style.accentAlt);
    expect(colors[0]).not.toBe(colors[1]); // opposed, not sequential
  });

  it('timeline: one axis plus a node per step, nodes ON the axis', () => {
    const ps = render({
      title: 'Roadmap',
      layout: 'timeline',
      steps: [{ label: 'Q1', detail: 'build' }, { label: 'Q2' }, { label: 'Q3' }],
    });
    const nodes = ps.filter(
      (p): p is Extract<DeckPrimitive, { kind: 'ellipse' }> => p.kind === 'ellipse',
    );
    expect(nodes).toHaveLength(3);
    const axis = ps.find(
      (p): p is Extract<DeckPrimitive, { kind: 'lineSeg' }> => p.kind === 'lineSeg' && p.widthPt === 2,
    )!;
    for (const n of nodes) {
      expect(n.box.y + n.box.h / 2).toBeCloseTo(axis.y1, 5);
      expect(n.outline?.color).toBe(style.background); // ring reads as sitting on the axis
    }
    expect(texts(ps)).toContain('build');
  });

  it('agenda: single column to 5 items, two columns past that', () => {
    const five = render({ title: 'A', layout: 'agenda', bullets: ['a', 'b', 'c', 'd', 'e'] });
    const xs5 = new Set(
      five.filter((p) => p.kind === 'text' && /^\d\d$/.test(p.paragraphs[0].runs[0].text)).map((p) => (p as never as { box: { x: number } }).box.x),
    );
    expect(xs5.size).toBe(1);

    const six = render({ title: 'A', layout: 'agenda', bullets: ['a', 'b', 'c', 'd', 'e', 'f'] });
    const xs6 = new Set(
      six.filter((p) => p.kind === 'text' && /^\d\d$/.test(p.paragraphs[0].runs[0].text)).map((p) => (p as never as { box: { x: number } }).box.x),
    );
    expect(xs6.size).toBe(2);
    expect(texts(six)).toContain('01');
    expect(texts(six)).toContain('06');
  });

  it('table: drawn from primitives, never a native table, and it closes on the last row', () => {
    const ps = render({
      title: 'Pricing',
      layout: 'table',
      table: { headers: ['Plan', 'Price'], rows: [['Free', '$0'], ['Pro', '$20']] },
    });
    // No primitive kind may encode a native pptx table — PowerPoint would size
    // its own rows and the preview could not follow.
    expect(new Set(kinds(ps))).toEqual(new Set(['text', 'rect', 'lineSeg']));
    expect(texts(ps)).toEqual(expect.arrayContaining(['Plan', 'Price', 'Free', '$0', 'Pro', '$20']));
    // one rule per band (header + 2 rows), so the grid is closed at the bottom
    expect(ps.filter((p) => p.kind === 'lineSeg')).toHaveLength(3);
  });

  it('table rows grow with wrapped content instead of overlapping', () => {
    const ps = render({
      title: 'Wide',
      layout: 'table',
      table: {
        headers: ['A', 'B'],
        rows: [['short', 'x'], ['a much longer cell that must wrap to two lines', 'y']],
      },
    });
    const rules = ps
      .filter((p): p is Extract<DeckPrimitive, { kind: 'lineSeg' }> => p.kind === 'lineSeg')
      .map((p) => p.y1);
    const heights = rules.map((y, i) => (i === 0 ? y : y - rules[i - 1]));
    expect(heights[2]).toBeGreaterThan(heights[1]); // the wrapping row is taller
  });

  it('every layout stays on the page', () => {
    const slides: Record<string, unknown>[] = [
      { title: 'H', layout: 'hero', image: { path: 'a.png' } },
      { title: 'C', layout: 'comparison', columns: [{ heading: 'A', bullets: ['x'] }, { heading: 'B', bullets: ['y'] }] },
      { title: 'T', layout: 'timeline', steps: [{ label: 'Q1' }, { label: 'Q2' }] },
      { title: 'A', layout: 'agenda', bullets: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
      { title: 'G', layout: 'table', table: { headers: ['a', 'b'], rows: [['1', '2']] } },
    ];
    for (const slide of slides) {
      for (const p of render(slide)) {
        const box = p.kind === 'image' ? p.frame : p.kind === 'lineSeg' ? null : p.box;
        if (!box) continue;
        expect(box.x, `${slide.layout} x`).toBeGreaterThanOrEqual(0);
        expect(box.y, `${slide.layout} y`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w, `${slide.layout} right`).toBeLessThanOrEqual(DECK_PAGE_W + 0.001);
        expect(box.y + box.h, `${slide.layout} bottom`).toBeLessThanOrEqual(DECK_PAGE_H + 0.001);
      }
    }
  });
});

describe('[COMP:decks/layout] Table grid fits the body box', () => {
  it('scales the grid at the schema maximum instead of running off the page', () => {
    // 8 rows x 5 columns x 50 chars: the worst case the schema admits.
    const cell = 'x'.repeat(50);
    const spec = deckSpecSchema.parse({
      title: 'T',
      slides: [
        {
          title: 'Max',
          layout: 'table',
          table: {
            headers: ['a', 'b', 'c', 'd', 'e'],
            rows: Array.from({ length: 8 }, () => Array(5).fill(cell)),
          },
        },
      ],
    });
    for (const p of layoutDeck(spec, DECK_PRESET_STYLES.light)[1].primitives) {
      const bottom =
        p.kind === 'lineSeg'
          ? Math.max(p.y1, p.y2)
          : p.kind === 'image'
            ? p.frame.y + p.frame.h
            : p.box.y + p.box.h;
      expect(bottom).toBeLessThanOrEqual(DECK_PAGE_H + 0.001);
    }
  });
});
