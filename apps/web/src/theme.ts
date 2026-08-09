/**
 * The design system, from `design.md`, in one place.
 *
 * `design.md` is the authoritative visual specification and it has precedence
 * over anything that was here before. Every value below is transcribed from it
 * rather than approximated, and no route is permitted to hardcode a colour, a
 * radius or a size — if a page needs something this file does not offer, the
 * answer is a token or a component here, not a literal there.
 *
 * ## Why the theme is a string and not Tailwind
 *
 * There is no Tailwind, React or shadcn in this repository; the console is a
 * Worker that renders HTML. `design.md` is stack-agnostic — it ships CSS custom
 * properties — so the system is expressible here exactly as specified. The
 * precedence list in the work order puts framework defaults last, and adopting
 * a framework to satisfy a specification that does not require one would change
 * the deployment target without changing a pixel.
 *
 * ## The font
 *
 * `--font-geist` is transcribed from `design.md` including its fallback chain.
 * Geist itself is not loaded, and the reason is structural rather than an
 * oversight: the Worker sends `default-src 'none'` with no `font-src`, so no
 * webfont can be fetched from anywhere, self-hosted or otherwise. Relaxing that
 * on a page whose entire job is to be trustworthy is a security decision, not a
 * typography one. The chain falls through to the platform's geometric sans,
 * which is what `design.md` specifies should happen.
 *
 * ## Colour discipline
 *
 * Eight colours exist. Seven are achromatic. `--color-ember` is the only hue and
 * it is reserved for destructive and error-adjacent states — never for status,
 * never for decoration. HELD, CONTESTED and WAITING FOR FINALITY are not errors
 * and must never be rendered in it.
 */

/** Colours, type, spacing, radii and shadows, verbatim from `design.md`. */
const TOKENS = `
:root{
  --color-canvas:#f5f5f5;
  --color-paper:#ffffff;
  --color-surface-alt:#fafafa;
  --color-ink:#0a0a0a;
  --color-ink-soft:#171717;
  --color-mid-gray:#737373;
  --color-hairline:#e5e5e5;
  --color-ember:#e7000b;

  --font-geist:'Geist',ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;

  --text-caption:12px;      --leading-caption:1.33;    --tracking-caption:0.6px;
  --text-body:14px;         --leading-body:1.43;
  --text-body-lg:16px;      --leading-body-lg:1.5;
  --text-subheading:18px;   --leading-subheading:1.56;
  --text-heading-sm:24px;   --leading-heading-sm:1.33; --tracking-heading-sm:-0.6px;
  --text-heading:30px;      --leading-heading:1.2;     --tracking-heading:-0.75px;
  --text-heading-lg:36px;   --leading-heading-lg:1.11; --tracking-heading-lg:-0.9px;
  --text-display:48px;      --leading-display:1.1;     --tracking-display:-2.4px;

  --font-weight-regular:400;
  --font-weight-medium:500;
  --font-weight-semibold:600;

  --spacing-4:4px;  --spacing-8:8px;   --spacing-12:12px; --spacing-16:16px;
  --spacing-20:20px; --spacing-24:24px; --spacing-48:48px;

  --page-max-width:1280px;
  --card-padding:20px;
  --element-gap:8px;

  --radius-small:6px;
  --radius-nested:10px;
  --radius-buttons:18px;
  --radius-inputs:18px;
  --radius-badges:18px;
  --radius-cards:24px;

  --shadow-subtle:0 0 0 1px rgba(23,23,23,0.05),0 1px 3px rgba(0,0,0,0.1),0 1px 2px -1px rgba(0,0,0,0.1);

  --surface-canvas:#f5f5f5;
  --surface-sidebar:#fafafa;
  --surface-card:#ffffff;
  --surface-input-fill:#f5f5f5;

  --sidebar-width:232px;
}
`;

/**
 * Reset and document defaults.
 *
 * Body is 14px/400 because `design.md` fixes body there and forbids going
 * below it. The OpenType features are the ones the specification names.
 */
const BASE = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  background:var(--surface-canvas);
  color:var(--color-ink);
  font-family:var(--font-geist);
  font-size:var(--text-body);
  line-height:var(--leading-body);
  font-weight:var(--font-weight-regular);
  font-feature-settings:"ss01" on,"cv11" on;
  -webkit-font-smoothing:antialiased;
}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:2px}
h1,h2,h3,h4,p,figure,ul,ol{margin:0}
ul,ol{padding:0;list-style:none}
button,input,select,textarea{font:inherit;color:inherit}
svg{display:block}

/* Focus stays inside the hairline language: a ring, never a glow. */
:focus-visible{outline:none;box-shadow:0 0 0 1px var(--color-paper),0 0 0 3px var(--color-ink);border-radius:var(--radius-small)}

.mono{font-family:var(--font-mono);font-variant-ligatures:none}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

/**
 * The type scale as classes.
 *
 * Naming matches `design.md`'s roles exactly so a component asks for
 * `t-heading-sm` rather than inventing a size.
 */
const TYPE = `
.t-caption{font-size:var(--text-caption);line-height:var(--leading-caption);letter-spacing:var(--tracking-caption)}
.t-caption-upper{font-size:var(--text-caption);line-height:var(--leading-caption);letter-spacing:var(--tracking-caption);text-transform:uppercase;color:var(--color-mid-gray);font-weight:var(--font-weight-medium)}
.t-body{font-size:var(--text-body);line-height:var(--leading-body)}
.t-body-lg{font-size:var(--text-body-lg);line-height:var(--leading-body-lg)}
.t-subheading{font-size:var(--text-subheading);line-height:var(--leading-subheading);font-weight:var(--font-weight-semibold)}
.t-heading-sm{font-size:var(--text-heading-sm);line-height:var(--leading-heading-sm);letter-spacing:var(--tracking-heading-sm);font-weight:var(--font-weight-semibold)}
.t-heading{font-size:var(--text-heading);line-height:var(--leading-heading);letter-spacing:var(--tracking-heading);font-weight:var(--font-weight-semibold)}
.t-heading-lg{font-size:var(--text-heading-lg);line-height:var(--leading-heading-lg);letter-spacing:var(--tracking-heading-lg);font-weight:var(--font-weight-semibold)}
.t-display{font-size:var(--text-display);line-height:var(--leading-display);letter-spacing:var(--tracking-display);font-weight:var(--font-weight-semibold)}
.muted{color:var(--color-mid-gray)}
.ink-soft{color:var(--color-ink-soft)}
`;

/**
 * Primitives.
 *
 * Radius discipline is load-bearing: 18px on everything interactive, 24px on
 * cards, 10px on nested surfaces, 6px only on small utility geometry. Nothing
 * else appears anywhere in this file.
 */
const PRIMITIVES = `
/* ── Buttons ─────────────────────────────────────────────────────────────── */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:var(--spacing-8);
  height:36px;padding:0 var(--spacing-16);
  border-radius:var(--radius-buttons);border:0;
  font-size:var(--text-body);font-weight:var(--font-weight-medium);
  line-height:1;white-space:nowrap;cursor:pointer;text-decoration:none;
  transition:background-color .12s ease,color .12s ease,border-color .12s ease;
}
.btn:hover{text-decoration:none}
.btn-primary{background:var(--color-ink);color:#fafafa}
.btn-primary:hover{background:var(--color-ink-soft)}
.btn-secondary{background:var(--color-canvas);color:var(--color-ink)}
.btn-secondary:hover{background:var(--color-hairline)}
.btn-outline{background:transparent;color:var(--color-ink);border:1px solid var(--color-hairline)}
.btn-outline:hover{background:var(--color-surface-alt)}
.btn-destructive{background:transparent;color:var(--color-ember);border:1px solid var(--color-hairline)}
.btn-destructive:hover{background:var(--color-canvas)}
.btn-sm{height:28px;padding:0 var(--spacing-12);font-size:var(--text-caption)}

/* ── Inputs ──────────────────────────────────────────────────────────────── */
.field{
  width:100%;background:var(--surface-input-fill);color:var(--color-ink);
  border:1px solid transparent;border-radius:var(--radius-inputs);
  padding:8px var(--spacing-12);font-size:var(--text-body);
}
.field::placeholder{color:var(--color-mid-gray)}
.field:focus{outline:none;border-color:var(--color-hairline);background:var(--color-paper)}
.field-mono{font-family:var(--font-mono);font-size:13px}
.label{display:block;margin-bottom:var(--spacing-8)}

/* ── Cards ───────────────────────────────────────────────────────────────── */
.card{
  background:var(--surface-card);
  border:1px solid var(--color-hairline);
  border-radius:var(--radius-cards);
  box-shadow:var(--shadow-subtle);
  padding:var(--card-padding);
}
.card-flush{padding:0;overflow:hidden}
.card-header{
  display:flex;align-items:center;justify-content:space-between;gap:var(--spacing-12);
  padding:var(--spacing-16) var(--spacing-20);
  border-bottom:1px solid var(--color-hairline);
}
.card-body{padding:var(--spacing-20)}
.nested{background:var(--color-canvas);border-radius:var(--radius-nested);padding:var(--spacing-12)}

/* ── Badges ──────────────────────────────────────────────────────────────── */
.badge{
  display:inline-flex;align-items:center;gap:6px;
  padding:2px var(--spacing-8);border-radius:var(--radius-badges);
  font-size:var(--text-caption);font-weight:var(--font-weight-medium);
  line-height:1.33;white-space:nowrap;border:1px solid transparent;
}
.badge-solid{background:var(--color-ink-soft);color:#fafafa}
.badge-soft{background:var(--color-canvas);color:var(--color-ink-soft)}
.badge-outline{background:transparent;color:var(--color-ink);border-color:var(--color-hairline)}
.badge-ember{background:transparent;color:var(--color-ember);border-color:var(--color-hairline)}
.badge .dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}

/* ── Separators, tables, stat blocks ─────────────────────────────────────── */
.rule{height:1px;background:var(--color-hairline);border:0;margin:var(--spacing-24) 0}
.table{width:100%;border-collapse:collapse}
.table th{
  text-align:left;font-size:var(--text-caption);line-height:var(--leading-caption);
  letter-spacing:var(--tracking-caption);text-transform:uppercase;
  color:var(--color-mid-gray);font-weight:var(--font-weight-medium);
  padding:var(--spacing-8) var(--spacing-12);border-bottom:1px solid var(--color-hairline);
  white-space:nowrap;
}
.table td{
  font-size:var(--text-body);padding:var(--spacing-12);
  border-bottom:1px solid var(--color-hairline);vertical-align:middle;
}
.table tbody tr:last-child td{border-bottom:0}
.table-hover tbody tr:hover{background:var(--color-surface-alt)}
.table-scroll{overflow-x:auto}
.kv{width:100%;border-collapse:collapse}
/* A key-value row carries hashes, ISO timestamps and repository paths, none of
   which have a space in them. Without this the second column sets the table's
   minimum width and the whole page scrolls sideways on a phone. */
.kv td{padding:6px 0;font-size:var(--text-body);vertical-align:top;overflow-wrap:anywhere}
.kv td:first-child{color:var(--color-mid-gray);width:40%;padding-right:var(--spacing-16)}

.stat .stat-label{font-size:var(--text-caption);line-height:var(--leading-caption);letter-spacing:var(--tracking-caption);text-transform:uppercase;color:var(--color-mid-gray);font-weight:var(--font-weight-medium)}
.stat .stat-value{font-size:var(--text-heading-lg);line-height:var(--leading-heading-lg);letter-spacing:var(--tracking-heading-lg);font-weight:var(--font-weight-semibold);margin-top:var(--spacing-4)}
.stat .stat-note{font-size:var(--text-body);color:var(--color-mid-gray);margin-top:var(--spacing-4)}
.stat-sm .stat-value{font-size:var(--text-heading-sm);line-height:var(--leading-heading-sm);letter-spacing:var(--tracking-heading-sm)}

/* ── Address and identity rows ───────────────────────────────────────────── */
.addr{display:inline-flex;align-items:baseline;gap:6px;font-family:var(--font-mono);font-size:13px}
.addr .chain{color:var(--color-mid-gray)}
.addr .val{color:var(--color-ink)}

/* An outbound link. The arrow is the affordance rather than a colour, because
   the system has no link blue to spend — it stays hairline-quiet until hover,
   where the underline does the work. */
.ext{display:inline-flex;align-items:baseline;gap:5px;text-decoration:none;color:inherit}
.ext:hover{text-decoration:underline;text-underline-offset:2px}
.ext .ext-mark{color:var(--color-mid-gray);flex:none;align-self:center;opacity:0}
.ext:hover .ext-mark,.ext:focus-visible .ext-mark{opacity:1}
/* Touch pointers get no hover, so the arrow is always visible there. */
@media (hover:none){.ext .ext-mark{opacity:1}}
.identity{display:inline-flex;align-items:center;gap:var(--spacing-8)}
/* Real brand marks, monochrome. No container: the marks carry their own
   silhouette, and boxing Base's rounded square inside another rounded box
   produced a square-in-a-square. They inherit colour, so a mark inside muted
   text goes grey with it. */
.mark{flex:none;color:var(--color-ink)}
.muted .mark,.mark.muted{color:var(--color-mid-gray)}
.mark-fallback{
  display:inline-block;width:8px;height:8px;border-radius:50%;
  border:1px solid var(--color-hairline);flex:none;
}

/* ── Notes and empty/error states ────────────────────────────────────────── */
.note{
  border-left:1px solid var(--color-hairline);
  padding-left:var(--spacing-12);color:var(--color-mid-gray);
  font-size:var(--text-body);margin-top:var(--spacing-16);max-width:70ch;
}
/* 24px, not 48. An empty panel should read as "nothing here yet", not as a
   hole the layout forgot to fill. */
.empty{
  display:flex;flex-direction:column;align-items:center;gap:var(--spacing-8);
  padding:var(--spacing-24) var(--spacing-20);text-align:center;color:var(--color-mid-gray);
}
.empty .empty-title{color:var(--color-ink);font-weight:var(--font-weight-medium);font-size:var(--text-body-lg)}
.skel{background:var(--color-canvas);border-radius:var(--radius-small);height:12px}
`;

/**
 * Layout: the shell, the page rhythm, and the protocol-specific compositions.
 *
 * Section gaps are 48px inside application screens. The landing page is allowed
 * to breathe to 80px, which is the top of the range `design.md` gives, and no
 * further — application screens stay information-dense.
 */
const LAYOUT = `
/* ── Application shell ───────────────────────────────────────────────────── */
.shell{display:grid;grid-template-columns:var(--sidebar-width) 1fr;min-height:100vh}
.sidebar{
  background:var(--surface-sidebar);
  border-right:1px solid var(--color-hairline);
  padding:var(--spacing-20) var(--spacing-12);
  display:flex;flex-direction:column;gap:var(--spacing-24);
  position:sticky;top:0;height:100vh;overflow-y:auto;
}
.sidebar .brand{display:flex;align-items:center;gap:var(--spacing-8);padding:0 var(--spacing-8)}
.nav{display:flex;flex-direction:column;gap:2px}
.nav-section{font-size:var(--text-caption);letter-spacing:var(--tracking-caption);text-transform:uppercase;color:var(--color-mid-gray);font-weight:var(--font-weight-medium);padding:var(--spacing-8) var(--spacing-8) var(--spacing-4)}
.nav a{
  display:flex;align-items:center;gap:var(--spacing-8);
  padding:6px var(--spacing-8);border-radius:var(--radius-nested);
  font-size:var(--text-body);color:var(--color-ink-soft);
}
.nav a:hover{background:var(--color-canvas);text-decoration:none}
.nav a[aria-current="page"]{background:var(--color-paper);color:var(--color-ink);font-weight:var(--font-weight-medium);box-shadow:0 0 0 1px var(--color-hairline)}
.sidebar-foot{margin-top:auto;padding:var(--spacing-8);border-top:1px solid var(--color-hairline)}

.main{min-width:0;display:flex;flex-direction:column}
.topbar{
  display:flex;align-items:center;justify-content:space-between;gap:var(--spacing-16);
  padding:var(--spacing-12) var(--spacing-24);
  border-bottom:1px solid var(--color-hairline);
  background:var(--color-paper);position:sticky;top:0;z-index:5;
}
.content{padding:var(--spacing-24);max-width:var(--page-max-width);width:100%;margin:0 auto;flex:1}

.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--spacing-16);margin-bottom:var(--spacing-24)}
.page-head .actions{display:flex;gap:var(--spacing-8);flex:none}
.crumb{display:flex;align-items:center;gap:6px;font-size:var(--text-body);color:var(--color-mid-gray);margin-bottom:var(--spacing-8)}
.crumb .sep{color:var(--color-mid-gray)}
.crumb .here{color:var(--color-ink)}
.section{margin-top:var(--spacing-48)}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--spacing-12);margin-bottom:var(--spacing-12)}

.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--spacing-16)}
.grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--spacing-16)}
.grid-4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--spacing-16)}
.row{display:flex;align-items:center;gap:var(--spacing-8)}
.row-between{display:flex;align-items:center;justify-content:space-between;gap:var(--spacing-12)}
.stack-8{display:flex;flex-direction:column;gap:var(--spacing-8)}
.stack-12{display:flex;flex-direction:column;gap:var(--spacing-12)}
.stack-4{display:flex;flex-direction:column;gap:var(--spacing-4)}
.stack-16{display:flex;flex-direction:column;gap:var(--spacing-16)}

/* ── Cross-chain settlement diagram ──────────────────────────────────────── */
.xchain{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:var(--spacing-16)}
.xchain-leg{
  background:var(--color-paper);border:1px solid var(--color-hairline);
  border-radius:var(--radius-nested);padding:var(--spacing-16);min-width:0;
}
.xchain-leg .leg-chain{display:flex;align-items:center;gap:var(--spacing-8);margin-bottom:var(--spacing-12)}
.xchain-leg .leg-amount{font-size:var(--text-heading-sm);line-height:var(--leading-heading-sm);letter-spacing:var(--tracking-heading-sm);font-weight:var(--font-weight-semibold)}
.xchain-leg .leg-asset{font-size:var(--text-body);color:var(--color-mid-gray);margin-top:2px}
.xchain-leg .leg-state{margin-top:var(--spacing-12)}
.xchain-mid{display:flex;flex-direction:column;align-items:center;gap:var(--spacing-8);padding:0 var(--spacing-8)}
.xchain-mid .connector{width:100%;min-width:56px;height:1px;background:var(--color-hairline);position:relative}
.xchain-mid .label{font-size:var(--text-caption);letter-spacing:var(--tracking-caption);text-transform:uppercase;color:var(--color-mid-gray);text-align:center}

/* ── Timelines ───────────────────────────────────────────────────────────── */
.timeline{display:flex;flex-direction:column}
.tl-item{display:grid;grid-template-columns:20px 1fr;gap:var(--spacing-12);position:relative;padding-bottom:var(--spacing-16)}
.tl-item:last-child{padding-bottom:0}
.tl-rail{display:flex;flex-direction:column;align-items:center;gap:4px}
.tl-node{width:9px;height:9px;border-radius:50%;border:1px solid var(--color-ink);background:var(--color-paper);flex:none;margin-top:5px}
.tl-node.done{background:var(--color-ink)}
.tl-node.pending{border-color:var(--color-hairline)}
.tl-line{width:1px;flex:1;background:var(--color-hairline);min-height:12px}
.tl-item:last-child .tl-line{display:none}
.tl-body{min-width:0;padding-bottom:2px}
.tl-title{font-size:var(--text-body);font-weight:var(--font-weight-medium)}
.tl-meta{font-size:var(--text-caption);color:var(--color-mid-gray);margin-top:2px}

/* ── Finality progress ───────────────────────────────────────────────────── */
.meter{height:3px;background:var(--color-hairline);border-radius:999px;overflow:hidden;margin-top:var(--spacing-8)}
.meter > span{display:block;height:100%;background:var(--color-ink)}

/* ── Landing ─────────────────────────────────────────────────────────────── */
.landing{max-width:var(--page-max-width);margin:0 auto;padding:0 var(--spacing-24)}

/* ── The landing header stays put ─────────────────────────────────────────────
   position:sticky and nothing else: no scroll listener, no class toggled by
   JavaScript, and therefore nothing to go wrong when the bundle has not loaded.

   The background is the page's own canvas at full opacity rather than a blurred
   pane. design.md rules out frosted glass, and full opacity is also the only
   thing that reliably stops type from ghosting through as it passes underneath.

   The hairline is permanent. Revealing one on scroll needs either JavaScript or
   a scroll-driven animation that most browsers still do not run, and a header
   whose height changes when you scroll is the layout jump this is meant to
   avoid. One px, always there, is quieter than either. */
.landing-nav{
  position:sticky;top:0;z-index:30;
  display:flex;align-items:center;justify-content:space-between;
  padding:var(--spacing-20) 0;
  background:var(--surface-canvas);
  border-bottom:1px solid var(--color-hairline);
}

/* Anchors land below the sticky header rather than under it. Sized to the
   header: 20 + 28 + 20 + 1 = 69px, plus room to breathe. */
.landing-section,.hero{scroll-margin-top:88px}

/* ── Hero ─────────────────────────────────────────────────────────────────────
   Two columns on desktop, and the artwork's track is a percentage so it holds
   the 45% the layout was designed around at every width. 1fr takes what is
   left, so the gap can never push the row wider than the container.

   minmax(0,...) on both tracks is what stops a long unbroken string or an image
   with an intrinsic width from establishing a floor wider than the viewport. */
.hero{
  padding:80px 0 var(--spacing-48);
  display:grid;grid-template-columns:minmax(0,45fr) minmax(0,55fr);
  gap:var(--spacing-48);align-items:center;
}
.hero-copy{max-width:52ch;min-width:0}
.hero p{margin-top:var(--spacing-16);font-size:var(--text-body-lg);line-height:var(--leading-body-lg);color:var(--color-mid-gray)}
.hero .actions{display:flex;gap:var(--spacing-8);margin-top:var(--spacing-24)}

/* The artwork sits on the canvas. No card, no frame, no backing, no shadow:
   its own alpha is the edge, and anything painted behind it would replace a
   transparent falloff with a rectangle. */
/* The mechanism column: artwork, then the three labels that name what it is,
   aligned to the composition's own thirds rather than floated beside it. */
.hero-mech{min-width:0;display:flex;flex-direction:column}
.hero-mech-labels{
  display:grid;grid-template-columns:repeat(3,minmax(0,1fr));
  align-items:start;gap:var(--spacing-16);margin-top:var(--spacing-12);
}
.hero-mech-centre{display:flex;justify-content:center;align-items:flex-start}
.hero-mech .rail-label{margin-bottom:2px}
.hero-art{min-width:0;width:100%}
.hero-art img{display:block;width:100%;height:auto}
/* One 80px gap between sections, not two stacked. Landing may breathe; it may
   not leave 160px of nothing. */
.landing-section{padding:0 0 80px}
.landing-foot{border-top:1px solid var(--color-hairline);padding:var(--spacing-24) 0 var(--spacing-48);color:var(--color-mid-gray)}

/* ── Stepper ─────────────────────────────────────────────────────────────── */
.stepper{
  display:flex;flex-wrap:wrap;gap:var(--spacing-8);
  padding-bottom:var(--spacing-16);border-bottom:1px solid var(--color-hairline);
}
.step{
  display:inline-flex;align-items:center;gap:6px;
  padding:4px var(--spacing-12);border-radius:var(--radius-badges);
  font-size:var(--text-caption);color:var(--color-mid-gray);white-space:nowrap;
}
/* The numeral is text, so it sits at the caption floor rather than below it. */
.step .step-n{
  display:inline-flex;align-items:center;justify-content:center;
  width:20px;height:20px;border-radius:50%;
  border:1px solid var(--color-hairline);
  font-size:var(--text-caption);line-height:1;
}
.step[data-state='current']{background:var(--color-ink);color:#fafafa}
.step[data-state='current'] .step-n{border-color:#fafafa}
.step[data-state='done']{color:var(--color-ink)}
.step[data-state='done'] .step-n{background:var(--color-ink);color:#fafafa;border-color:var(--color-ink)}

/* ── Transaction state ───────────────────────────────────────────────────── */
.txstate{
  display:flex;flex-direction:column;gap:6px;
  padding:var(--spacing-12);border:1px solid var(--color-hairline);
  border-radius:var(--radius-nested);background:var(--color-surface-alt);
}
.txstate .tx-label{font-size:var(--text-body);font-weight:var(--font-weight-medium)}
.txstate .tx-dot{width:6px;height:6px;border-radius:50%;background:var(--color-ink);flex:none}
/* The single place a transaction turns chromatic: it actually failed. */
.txstate .tx-dot.failed{background:var(--color-ember)}
.txstate .tx-error{color:var(--color-ember)}
/* Six rungs, drawn as hairline segments. A write that stopped shows where. */
.tx-ladder{display:flex;gap:3px}
.tx-rung{flex:1;height:2px;background:var(--color-hairline);border-radius:999px}
.tx-rung.done{background:var(--color-ink)}

/* ── Next action ─────────────────────────────────────────────────────────── */
/* The dominant element on a settlement. It is a card at the container radius
   with a heavier inner rule, not a coloured callout — design.md has no accent
   fill and the emphasis comes from scale and position instead. */
.action{border:1px solid var(--color-hairline);border-radius:var(--radius-cards);background:var(--color-paper);box-shadow:var(--shadow-subtle);overflow:hidden}
.action-head{padding:var(--spacing-20);border-bottom:1px solid var(--color-hairline);display:flex;align-items:flex-start;justify-content:space-between;gap:var(--spacing-16)}
.action-title{font-size:var(--text-heading-sm);line-height:var(--leading-heading-sm);letter-spacing:var(--tracking-heading-sm);font-weight:var(--font-weight-semibold)}
.action-body{padding:var(--spacing-20);display:flex;flex-direction:column;gap:var(--spacing-16)}
.action-why{color:var(--color-mid-gray);max-width:74ch}
.action-amount{font-size:var(--text-heading-lg);line-height:var(--leading-heading-lg);letter-spacing:var(--tracking-heading-lg);font-weight:var(--font-weight-semibold)}
.action-blocked{border-left:1px solid var(--color-hairline);padding-left:var(--spacing-12);color:var(--color-mid-gray);max-width:70ch}

/* The one place a panel is allowed to shout, and it does it with a rule and a
   caption rather than with colour: COMMIT cannot be undone. */
.boundary{border:1px solid var(--color-ink);border-radius:var(--radius-nested);padding:var(--spacing-16);display:flex;flex-direction:column;gap:var(--spacing-8)}
.boundary .boundary-title{font-weight:var(--font-weight-semibold);letter-spacing:var(--tracking-caption);text-transform:uppercase;font-size:var(--text-caption)}

/* ── Finality flow ───────────────────────────────────────────────────────── */
.flow{display:flex;flex-direction:column;gap:0}
.flow-stage{display:grid;grid-template-columns:20px 1fr;gap:var(--spacing-12)}
.flow-rail{display:flex;flex-direction:column;align-items:center}
.flow-node{width:9px;height:9px;border-radius:50%;border:1px solid var(--color-hairline);background:var(--color-paper);flex:none;margin-top:5px}
.flow-node.done{background:var(--color-ink);border-color:var(--color-ink)}
.flow-node.active{border-color:var(--color-ink)}
.flow-line{width:1px;flex:1;background:var(--color-hairline);min-height:18px}
.flow-stage:last-child .flow-line{display:none}
.flow-body{padding-bottom:var(--spacing-16);min-width:0}
.flow-stage:last-child .flow-body{padding-bottom:0}
.flow-title{font-size:var(--text-body);font-weight:var(--font-weight-medium)}
.flow-meta{font-size:var(--text-caption);color:var(--color-mid-gray);margin-top:2px}

/* ── Disposition types ───────────────────────────────────────────────────── */
.dtype{border:1px solid var(--color-hairline);border-radius:var(--radius-nested);padding:var(--spacing-16);display:flex;flex-direction:column;gap:var(--spacing-8);min-width:0}
.dtype[data-enabled='false']{background:var(--color-surface-alt)}
.dtype .dtype-name{font-weight:var(--font-weight-medium);font-family:var(--font-mono);font-size:13px}

/* ── Side-by-side compliance ─────────────────────────────────────────────── */
.compare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--spacing-16)}
.compare > div{border:1px solid var(--color-hairline);border-radius:var(--radius-nested);padding:var(--spacing-16)}
@media (max-width:768px){.compare{grid-template-columns:minmax(0,1fr)}}

/* ── Wallet controls ─────────────────────────────────────────────────────── */
.account-chip{
  display:inline-flex;align-items:center;gap:var(--spacing-8);
  height:36px;padding:0 var(--spacing-12);
  background:var(--color-canvas);border:0;border-radius:var(--radius-buttons);
  font-size:var(--text-body);cursor:pointer;
}
.account-chip:hover{background:var(--color-hairline)}
.wallet-row{
  display:flex;align-items:center;gap:var(--spacing-12);width:100%;
  padding:var(--spacing-12);border-radius:var(--radius-nested);
  border:1px solid var(--color-hairline);background:var(--color-paper);
  font-size:var(--text-body);cursor:pointer;text-align:left;
}
.wallet-row:hover{background:var(--color-surface-alt)}
.wallet-row > span:nth-of-type(1){flex:1}
.wallet-icon{width:22px;height:22px;border-radius:var(--radius-small);flex:none}

/* ── Modal ───────────────────────────────────────────────────────────────── */
.modal-root{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:var(--spacing-20)}
/* Flat scrim, no blur: design.md rules out frosted panels and dramatic depth. */
.modal-backdrop{position:absolute;inset:0;background:rgba(10,10,10,0.28)}
.modal{position:relative;width:100%;max-width:420px;max-height:85vh;overflow-y:auto}
.modal:focus{outline:none}

/* ── Orientation and the personal overview ───────────────────────────────── */
.onboarding{display:flex;flex-direction:column;gap:var(--spacing-16)}
.onboarding-title{
  font-size:var(--text-heading-sm);line-height:var(--leading-heading-sm);
  letter-spacing:var(--tracking-heading-sm);font-weight:var(--font-weight-semibold);
  overflow-wrap:anywhere;
}
.list-row{
  display:flex;flex-direction:column;gap:var(--spacing-4);
  padding:var(--spacing-12);border:1px solid var(--color-hairline);
  border-radius:var(--radius-nested);background:var(--color-paper);
}

/* ── Activity ────────────────────────────────────────────────────────────────
   Fixed to the viewport because the wait it reports is minutes long and the
   participant is expected to navigate during it. It sits below the modal layer:
   a wallet dialog must never be obscured by a progress list. */
.activity{position:fixed;right:var(--spacing-20);bottom:var(--spacing-20);z-index:40;
  display:flex;flex-direction:column;align-items:flex-end;gap:var(--spacing-8)}
.activity-toggle{
  display:inline-flex;align-items:center;gap:var(--spacing-8);height:36px;
  padding:0 var(--spacing-16);background:var(--color-ink);color:var(--color-paper);
  border:0;border-radius:var(--radius-buttons);font-size:var(--text-caption);cursor:pointer;
}
.activity-panel{width:min(360px,calc(100vw - var(--spacing-20) * 2));
  max-height:60vh;overflow-y:auto;display:flex;flex-direction:column;gap:var(--spacing-12)}
.activity-row{display:flex;flex-direction:column;gap:var(--spacing-4);
  padding-bottom:var(--spacing-12);border-bottom:1px solid var(--color-hairline)}
.activity-row:last-of-type{border-bottom:0;padding-bottom:0}
.activity-label{font-weight:var(--font-weight-medium)}
.notice{width:min(360px,calc(100vw - var(--spacing-20) * 2));
  display:flex;align-items:flex-start;justify-content:space-between;gap:var(--spacing-12)}
.notice-attention{font-weight:var(--font-weight-medium)}
.activity .tx-dot{width:6px;height:6px;border-radius:50%;background:var(--color-ink);flex:none}
.activity .tx-dot.failed{background:var(--color-ember)}
@media (max-width:768px){
  .activity{left:var(--spacing-16);right:var(--spacing-16);align-items:stretch}
  .activity-panel{width:auto}
}


/* ── Landing composition ──────────────────────────────────────────────────────
   design.md is unchanged: same eight colours, same type scale, same radii. What
   changes here is rhythm. Every section used to have the same max width, the
   same padding and the same card treatment, so a reader had no way to tell the
   thesis from a definition. These give sections different shapes — narrow copy,
   full-bleed mechanism, sticky visual, dense record — using only tokens. */

/* A statement that carries a section on its own. Narrow on purpose: a line
   that runs the full 1232px is a line nobody finishes. */
.statement{max-width:34ch}
.statement-wide{max-width:46ch}
.lede{max-width:62ch;font-size:var(--text-body-lg);line-height:var(--leading-body-lg);color:var(--color-mid-gray)}
.eyebrow{font-size:var(--text-caption);line-height:var(--leading-caption);letter-spacing:var(--tracking-caption);text-transform:uppercase;color:var(--color-mid-gray);font-weight:var(--font-weight-medium);margin-bottom:var(--spacing-16)}
.rule-top{border-top:1px solid var(--color-hairline);padding-top:var(--spacing-24)}
.section-lg{padding:96px 0}
.section-tight{padding:var(--spacing-48) 0}
.split{display:grid;grid-template-columns:minmax(0,42fr) minmax(0,58fr);gap:var(--spacing-48);align-items:start}
.split-even{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--spacing-48);align-items:start}

/* ── Asymmetric finality ──────────────────────────────────────────────────────
   Two chain rails on one shared horizontal axis, so the gap between them is the
   picture rather than a sentence about a picture. Widths are the real observed
   range and the caption says so; nothing here is averaged. */
.rails{display:flex;flex-direction:column;gap:var(--spacing-24);margin-top:var(--spacing-24)}
.rail{display:grid;grid-template-columns:112px minmax(0,1fr);gap:var(--spacing-16);align-items:center}
.rail-label{font-size:var(--text-caption);letter-spacing:var(--tracking-caption);text-transform:uppercase;color:var(--color-mid-gray);font-weight:var(--font-weight-medium)}
.rail-track{position:relative;height:34px}
.rail-track::before{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:var(--color-hairline)}
.rail-span{
  position:absolute;top:50%;transform:translateY(-50%);height:2px;background:var(--color-ink);
  transform-origin:left center;
}
.rail-mark{position:absolute;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:var(--spacing-4)}
.rail-dot{width:7px;height:7px;border-radius:50%;background:var(--color-paper);border:1px solid var(--color-ink)}
.rail-dot.solid{background:var(--color-ink)}
.rail-tag{position:absolute;top:calc(50% + 12px);transform:translateX(-50%);white-space:nowrap;font-size:var(--text-caption);letter-spacing:var(--tracking-caption);color:var(--color-mid-gray)}
/* A centred label at either end of the track hangs off the page. The ends
   anchor to their own edge instead, which keeps the mark and its label aligned
   without letting the text escape the layout. */
.rail-tag.start{transform:none}
.rail-tag.end{transform:translateX(-100%)}
/* The verdict sits above the axis and the moment below it, so three marks on
   one short rail read as three moments rather than one run-on string. */
.rail-tag.above{top:auto;bottom:calc(50% + 12px);color:var(--color-ink);font-weight:var(--font-weight-medium)}
.rail-track{height:52px}
.rail-gap{
  position:absolute;top:0;bottom:0;border-left:1px dashed var(--color-hairline);
  border-right:1px dashed var(--color-hairline);background:rgba(10,10,10,0.03);
}
.rail-gap-label{position:absolute;top:-22px;left:50%;transform:translateX(-50%);white-space:nowrap;font-size:var(--text-caption);letter-spacing:var(--tracking-caption);color:var(--color-ink);font-weight:var(--font-weight-medium)}

/* ── The sticky mechanism ─────────────────────────────────────────────────────
   The two chain modules stay put while the stages scroll past them, which is
   the whole argument: what moves is the protocol state in the middle, and the
   assets do not move at all. Sticky rather than pinned by script, so it still
   works with the bundle blocked — the stages simply all read as current. */
.mech{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--spacing-48);align-items:start;margin-top:var(--spacing-48)}
.mech-visual{position:sticky;top:112px}
.mech-stage{
  display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:var(--spacing-16);
  border:1px solid var(--color-hairline);border-radius:var(--radius-cards);
  background:var(--surface-card);padding:var(--card-padding);
}
.mech-side{display:flex;flex-direction:column;gap:var(--spacing-8);min-width:0}
.mech-side .t-caption-upper{margin:0}
.mech-amount{font-size:var(--text-heading-sm);line-height:var(--leading-heading-sm);letter-spacing:var(--tracking-heading-sm);font-weight:var(--font-weight-semibold)}
.mech-centre{display:flex;flex-direction:column;align-items:center;gap:var(--spacing-8);padding:0 var(--spacing-8)}
.mech-wire{width:100%;min-width:48px;height:1px;background:var(--color-hairline)}
.mech-state{
  display:inline-flex;align-items:center;height:28px;padding:0 var(--spacing-12);
  border-radius:var(--radius-badges);background:var(--color-ink);color:#fafafa;
  font-size:var(--text-caption);letter-spacing:var(--tracking-caption);font-family:var(--font-mono);
  white-space:nowrap;
}
.mech-legstate{font-size:var(--text-caption);letter-spacing:var(--tracking-caption);color:var(--color-mid-gray);font-family:var(--font-mono)}
.mech-steps{display:flex;flex-direction:column}
.mech-step{
  padding:var(--spacing-24) 0;border-top:1px solid var(--color-hairline);
  opacity:.32;transition:opacity .28s ease;
}
.mech-step:first-child{border-top:0}
.mech-step[data-current]{opacity:1}
.mech-step .index{font-family:var(--font-mono);font-size:var(--text-caption);letter-spacing:var(--tracking-caption);color:var(--color-mid-gray)}
.mech-step h3{font-size:var(--text-subheading);line-height:var(--leading-subheading);font-weight:var(--font-weight-semibold);margin-top:var(--spacing-8)}
.mech-step p{margin-top:var(--spacing-8);color:var(--color-mid-gray);max-width:44ch}

/* ── The state rail: what happened after COMMIT ───────────────────────────── */
.staterail{margin-top:var(--spacing-48);border-top:1px solid var(--color-hairline)}
.staterail-row{
  display:grid;grid-template-columns:minmax(0,220px) minmax(0,1fr);gap:var(--spacing-48);
  padding:var(--spacing-24) 0;border-bottom:1px solid var(--color-hairline);
  opacity:.4;transition:opacity .3s ease;
}
.staterail-row[data-shown]{opacity:1}
.staterail-state{display:flex;align-items:center;gap:var(--spacing-12)}
.staterail-node{width:9px;height:9px;border-radius:50%;background:var(--color-ink);flex:none}
.staterail-name{font-family:var(--font-mono);font-weight:var(--font-weight-medium)}
.staterail-row p{color:var(--color-mid-gray);max-width:56ch}
.boundary{
  display:flex;align-items:center;gap:var(--spacing-16);padding:var(--spacing-16) 0;
  border-bottom:1px solid var(--color-ink);
}
.boundary span{font-size:var(--text-caption);letter-spacing:var(--tracking-caption);text-transform:uppercase;font-weight:var(--font-weight-medium);white-space:nowrap}
.boundary::after{content:"";flex:1;height:1px;background:var(--color-ink)}
.ledger{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--spacing-24);margin-top:var(--spacing-24)}
.ledger > div{border-left:1px solid var(--color-hairline);padding-left:var(--spacing-16)}
.ledger .k{font-size:var(--text-caption);letter-spacing:var(--tracking-caption);text-transform:uppercase;color:var(--color-mid-gray);font-weight:var(--font-weight-medium)}
.ledger .v{margin-top:var(--spacing-4);font-family:var(--font-mono);font-size:var(--text-subheading);font-weight:var(--font-weight-semibold)}

/* ── Causal chain: Cleanverse ─────────────────────────────────────────────── */
.chain-steps{display:flex;flex-direction:column;margin-top:var(--spacing-24)}
.chain-step{display:grid;grid-template-columns:minmax(0,240px) minmax(0,1fr);gap:var(--spacing-48);padding:var(--spacing-24) 0;border-top:1px solid var(--color-hairline)}
.chain-step:last-child{border-bottom:1px solid var(--color-hairline)}
.chain-q{font-size:var(--text-caption);letter-spacing:var(--tracking-caption);text-transform:uppercase;color:var(--color-mid-gray);font-weight:var(--font-weight-medium)}
.chain-a{margin-top:var(--spacing-4);font-family:var(--font-mono);font-size:var(--text-subheading);font-weight:var(--font-weight-semibold)}
.chain-step p{color:var(--color-mid-gray);max-width:56ch}

/* ── Message rail: Wormhole ───────────────────────────────────────────────────
   The two chain columns are fixed at the edges and the messages appear between
   them. Nothing crosses: the point of the section is that the assets do not. */
.msgrail{display:grid;grid-template-columns:minmax(0,150px) minmax(0,1fr) minmax(0,150px);gap:var(--spacing-24);align-items:start;margin-top:var(--spacing-48)}
.msgrail-chain{
  border:1px solid var(--color-hairline);border-radius:var(--radius-cards);
  background:var(--surface-card);padding:var(--card-padding);position:sticky;top:112px;
}
.msgrail-chain .asset{margin-top:var(--spacing-12);font-family:var(--font-mono);font-size:var(--text-caption);letter-spacing:var(--tracking-caption)}
.msgrail-chain .anchored{margin-top:var(--spacing-8);font-size:var(--text-caption);letter-spacing:var(--tracking-caption);color:var(--color-mid-gray)}
.msgrail-list{display:flex;flex-direction:column;gap:var(--spacing-12);padding-top:var(--spacing-12)}
.msg{
  display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:var(--spacing-12);
  padding:var(--spacing-12) var(--spacing-16);border:1px solid var(--color-hairline);
  border-radius:var(--radius-buttons);background:var(--surface-card);
  opacity:0;transform:translateY(6px);transition:opacity .32s ease,transform .32s ease;
}
.msg[data-shown]{opacity:1;transform:none}
.msg .dir{font-family:var(--font-mono);font-size:var(--text-caption);color:var(--color-mid-gray);white-space:nowrap}
.msg .type{font-family:var(--font-mono);font-size:var(--text-caption);letter-spacing:var(--tracking-caption);font-weight:var(--font-weight-medium)}
.anatomy{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--spacing-16) var(--spacing-24);margin-top:var(--spacing-24)}
.anatomy .k{font-size:var(--text-caption);letter-spacing:var(--tracking-caption);text-transform:uppercase;color:var(--color-mid-gray);font-weight:var(--font-weight-medium)}
.anatomy .v{margin-top:var(--spacing-4);font-family:var(--font-mono);font-size:var(--text-caption)}

/* ── Proof records ────────────────────────────────────────────────────────────
   A record, not a marketing card: identifier first, verdict beside it, the
   numbers that make it checkable, and the links that let a stranger check it. */
.records{display:flex;flex-direction:column;margin-top:var(--spacing-24);border-top:1px solid var(--color-hairline)}
.record{
  display:grid;grid-template-columns:minmax(0,1fr) minmax(0,340px);gap:var(--spacing-48);
  padding:var(--spacing-24) 0;border-bottom:1px solid var(--color-hairline);align-items:start;
}
.record h3{font-size:var(--text-subheading);line-height:var(--leading-subheading);font-weight:var(--font-weight-semibold)}
.record p{margin-top:var(--spacing-8);color:var(--color-mid-gray);max-width:60ch}
.record-facts{display:flex;flex-direction:column;gap:var(--spacing-8)}
.record-fact{display:flex;align-items:baseline;justify-content:space-between;gap:var(--spacing-16)}
.record-fact .k{font-size:var(--text-caption);letter-spacing:var(--tracking-caption);text-transform:uppercase;color:var(--color-mid-gray)}
.record-fact .v{font-family:var(--font-mono);font-size:var(--text-caption)}

/* ── Editorial use cases ─────────────────────────────────────────────────── */
.editorial{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--spacing-48);margin-top:var(--spacing-24)}
.editorial > div{border-top:1px solid var(--color-hairline);padding-top:var(--spacing-16)}
.editorial h3{font-size:var(--text-subheading);line-height:var(--leading-subheading);font-weight:var(--font-weight-medium)}
.editorial p{margin-top:var(--spacing-4);color:var(--color-mid-gray);max-width:44ch}

/* ── Closing ─────────────────────────────────────────────────────────────── */
.paths{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--spacing-48);margin-top:var(--spacing-48)}
.paths > div{border-top:1px solid var(--color-ink);padding-top:var(--spacing-16)}
.paths h3{font-size:var(--text-heading-sm);line-height:var(--leading-heading-sm);letter-spacing:var(--tracking-heading-sm);font-weight:var(--font-weight-semibold)}
.paths p{margin-top:var(--spacing-8);color:var(--color-mid-gray);max-width:40ch}
.paths .row{margin-top:var(--spacing-16)}

/* ── Glossary and footer ─────────────────────────────────────────────────── */
.glossary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--spacing-24);margin-top:var(--spacing-24)}
.glossary dt{font-family:var(--font-mono);font-size:var(--text-caption);letter-spacing:var(--tracking-caption);font-weight:var(--font-weight-medium)}
.glossary dd{margin:var(--spacing-4) 0 0;color:var(--color-mid-gray);font-size:var(--text-caption);line-height:var(--leading-body)}
.footer-grid{display:grid;grid-template-columns:minmax(0,1.4fr) repeat(3,minmax(0,1fr));gap:var(--spacing-48);padding:var(--spacing-48) 0 var(--spacing-24)}
.footer-grid h4{font-size:var(--text-caption);letter-spacing:var(--tracking-caption);text-transform:uppercase;color:var(--color-mid-gray);font-weight:var(--font-weight-medium)}
.footer-grid ul{margin-top:var(--spacing-12);display:flex;flex-direction:column;gap:var(--spacing-8)}
.footer-grid a{color:var(--color-mid-gray)}
.footer-grid a:hover{color:var(--color-ink)}

/* ── Reveal ───────────────────────────────────────────────────────────────────
   Sections start slightly down and transparent and settle when they are
   reached. It carries no information on its own, so it is the first thing to
   go when a reader has asked for less motion — and the no-JS default below is
   fully visible, never hidden. */
.reveal{opacity:1;transform:none}
[data-motion] .reveal{opacity:0;transform:translateY(10px);transition:opacity .5s ease,transform .5s ease}
[data-motion] .reveal[data-shown]{opacity:1;transform:none}
[data-motion] .rail-span{transform:translateY(-50%) scaleX(0);transition:transform .7s ease}
[data-motion] .reveal[data-shown] .rail-span{transform:translateY(-50%) scaleX(1)}
@media (prefers-reduced-motion:reduce){
  [data-motion] .reveal,[data-motion] .reveal[data-shown],
  .msg,.msg[data-shown],.mech-step,.staterail-row{
    opacity:1!important;transform:none!important;transition:none!important;
  }
  [data-motion] .rail-span,[data-motion] .reveal[data-shown] .rail-span{transform:translateY(-50%) scaleX(1)!important;transition:none!important}
  .mech-visual,.msgrail-chain{position:static}
}

/* ── Nav links ───────────────────────────────────────────────────────────── */
.navlinks{display:flex;align-items:center;gap:var(--spacing-20)}
@media (max-width:1024px){.navlinks{display:none}}
.navlinks a{font-size:var(--text-body);color:var(--color-mid-gray)}
.navlinks a:hover{color:var(--color-ink);text-decoration:none}

/* ── Responsive ──────────────────────────────────────────────────────────── */
@media (max-width:1024px){
  .editorial,.paths{gap:var(--spacing-24)}
  .anatomy{grid-template-columns:repeat(2,minmax(0,1fr))}
  .record{grid-template-columns:minmax(0,1fr) minmax(0,260px);gap:var(--spacing-24)}
  .section-lg{padding:var(--spacing-48) 0}
  .mech{gap:var(--spacing-24)}

  /* The copy needs the room before the artwork does, so the artwork gives it
     up first rather than both columns shrinking together. */
  .hero{
    grid-template-columns:minmax(0,48fr) minmax(0,52fr);gap:var(--spacing-24);
    padding:var(--spacing-48) 0 var(--spacing-24);
  }
  .shell{grid-template-columns:1fr}
  .sidebar{
    position:static;height:auto;flex-direction:row;align-items:center;
    gap:var(--spacing-12);overflow-x:auto;border-right:0;
    border-bottom:1px solid var(--color-hairline);padding:var(--spacing-12) var(--spacing-16);
  }
  .sidebar .brand{flex:none}
  .sidebar-foot{margin:0;padding:0;border:0;flex:none}
  .nav{flex-direction:row;gap:var(--spacing-4);flex:1}
  .nav-section{display:none}
  .nav a{white-space:nowrap}
  .grid-4{grid-template-columns:repeat(2,minmax(0,1fr))}
  .grid-3{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:768px){
  .section-lg{padding:var(--spacing-48) 0}
  .split,.split-even{grid-template-columns:minmax(0,1fr);gap:var(--spacing-24)}
  .mech{grid-template-columns:minmax(0,1fr);gap:var(--spacing-24)}
  .mech-visual{position:sticky;top:64px;z-index:1;padding-bottom:var(--spacing-12);background:var(--surface-canvas)}
  .msgrail{grid-template-columns:minmax(0,1fr);gap:var(--spacing-16)}
  .msgrail-chain{position:static}
  .record{grid-template-columns:minmax(0,1fr);gap:var(--spacing-16)}
  .staterail-row,.chain-step{grid-template-columns:minmax(0,1fr);gap:var(--spacing-12)}
  .editorial,.paths,.glossary,.anatomy{grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--spacing-24)}
  .footer-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--spacing-24)}
  .ledger{grid-template-columns:minmax(0,1fr);gap:var(--spacing-12)}
  .rail{grid-template-columns:minmax(0,1fr);gap:var(--spacing-8)}
  .content{padding:var(--spacing-16)}
  .grid-2,.grid-3{grid-template-columns:minmax(0,1fr)}
  /* Stat blocks are compact enough to pair. Four stacked reads as a list of
     numbers; two-up keeps them a dashboard. */
  .grid-4{grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--spacing-20) var(--spacing-16)}
  /* The inline verify form squeezed the primary action off the viewport. The
     Verifier is a nav item on this breakpoint, so the form goes and the action
     keeps the bar. */
  .topbar > form{display:none}
  .topbar{justify-content:flex-end;padding:var(--spacing-12) var(--spacing-16)}
  .xchain{grid-template-columns:minmax(0,1fr)}
  .xchain-mid{flex-direction:row;padding:var(--spacing-4) 0}
  .xchain-mid .connector{width:1px;min-width:0;height:24px}
  .page-head{flex-direction:column;align-items:stretch}
  /* One column, so the artwork falls below the CTA in source order and is
     centred under it. Capped so it does not become the whole first screen. */
  .hero{
    grid-template-columns:minmax(0,1fr);gap:var(--spacing-24);
    padding:var(--spacing-24) 0 var(--spacing-24);
  }
  .hero-art{justify-self:center;max-width:min(100%,420px)}
  .landing-nav{padding:var(--spacing-12) 0}
  /* Two buttons plus the wordmark do not fit 390px. The verifier is one tap
     away inside the console, so the header keeps the primary action. */
  .landing-nav .row .btn-outline{display:none}
  .landing-section,.hero{scroll-margin-top:64px}
  .landing-section{padding:var(--spacing-48) 0}
  /* Deliberate reduction inside the scale, not a shrink. */
  .t-display{font-size:var(--text-heading-lg);line-height:var(--leading-heading-lg);letter-spacing:var(--tracking-heading-lg)}
  .t-heading-lg{font-size:var(--text-heading);line-height:var(--leading-heading);letter-spacing:var(--tracking-heading)}
  .t-heading{font-size:var(--text-heading-sm);line-height:var(--leading-heading-sm);letter-spacing:var(--tracking-heading-sm)}
  .stat .stat-value{font-size:var(--text-heading);line-height:var(--leading-heading);letter-spacing:var(--tracking-heading)}
}
`;

/** The whole stylesheet, in specificity order. */
export const STYLESHEET = `${TOKENS}${BASE}${TYPE}${PRIMITIVES}${LAYOUT}`
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\n\s*/g, '')
  .trim();
