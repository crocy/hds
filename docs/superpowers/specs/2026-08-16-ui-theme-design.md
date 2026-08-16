# UI theme: system, dark and light

The app has one look — the near-black prototype. This adds an explicit
system / dark / light choice that reaches every surface, including the 3D viewport.

## 1. What was decided, and why

**The theme reaches everything, viewport included.** The alternative — light chrome
framing a permanently black viewport — was rejected as a visible seam.

**The light viewport is mid-grey `#71747a`, not white.** This is the decision the rest
of the spec hangs off, so the reasoning is worth stating in full.

Every thermal colormap runs from near-black at the cold end to near-white at the hot
end. Inferno bottoms out at `#000004` and tops out at `#fcffa4`. That means *whichever
pole the background sits at, the matching end of the ramp collapses into it*: on
near-black today the cold end is nearly invisible, and on near-white the hot end would
be — and the hot end is the one you are looking for. A mid-grey background is the only
choice where neither end is lost.

The colormap itself is not adjusted to fit a lighter background. It encodes
temperature, and the 3D mesh, the legend and the plots all read from the same ramp; a
per-theme transform on the mesh would mean a screenshot from light theme no longer
colour-matches one from dark. The background is the free variable, so the background is
what moves.

The value was picked by measurement, after a first guess of `#b9bdc6` was measured and
failed. WCAG contrast of each candidate against inferno's two poles, worst end first:

| Background | vs cold `#000004` | vs hot `#fcffa4` | Worst end |
|---|---|---|---|
| `#0c0c10` — dark theme, today | 1.07 | 18.57 | **1.07** |
| `#ffffff` | 20.96 | 1.05 | **1.05** |
| `#b9bdc6` — first guess | 11.14 | 1.79 | **1.79** |
| `#8d9098` | 6.56 | 3.04 | **3.04** |
| `#71747a` — chosen | 4.47 | 4.46 | **4.46** |

`#b9bdc6` sits at luminance 0.508 and behaves almost exactly like white as far as the
hot end is concerned. Clearing 3.0 at both ends requires luminance ≤ 0.283. `#71747a`
is the point where the two ends are equal, so no end of the ramp is favoured and the
choice does not have to be revisited if a colormap with different poles is added later.

The cost is honest: light theme is light chrome over a graphite stage, not a white
sheet. That was accepted deliberately, because the hot end is the end you open the app
to find, and the alternative spends it on looking lighter.

Note what the first row shows — dark theme has always scored 1.07 at its cold end. The
app already ships with one end of the ramp lost; light theme is the first to lose
neither.

**The preference lives in `localStorage` only, never in a project file.** Theme is a
property of the machine, not of the model under study. A `.hds.json` shared with a
colleague must not drag your UI into their theme. This is enforced structurally: the
theme lives outside `ProjectState`, so no future edit to `serialiseProject` can quietly
start persisting it. One new key, `hds.theme`.

**The control is a three-segment group at the top of the Display panel**, above
wireframe, with the other "how it is drawn" settings.

## 2. Module layout

`src/ui/theme/`, new:

| File | Contents |
|---|---|
| `theme.ts` | Pure. `ThemeMode`, `ResolvedTheme`, `resolveTheme`, and the viewer and plot palettes. No React, no DOM — unit-testable in Node, like `physics/` and `analysis/`. |
| `ThemeProvider.tsx` | Context over `{ mode, resolved, setMode }`. Seeds from `localStorage`, tracks `prefers-color-scheme` through `useSyncExternalStore`, writes `data-theme` on `<html>`. |

```ts
export type ThemeMode = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme;
```

CSS reads the resolved theme off `<html data-theme>`. The viewer and the plots read it
through the context, because neither three.js nor a canvas pixel buffer can use a CSS
custom property.

## 3. CSS

`:root` keeps today's dark values unchanged. `:root[data-theme='light']` overrides the
same names and flips `color-scheme`. `plots.css` gets the same treatment scoped under
`[data-theme='light'] .hds-plot`.

About eighteen colours in `styles.css` were never lifted into variables — the scrollbar
thumb, input background, button hover, the readout background, the modal backdrop, the
white legend-ambient marker, the `#fff` hover states. These are promoted first. That is
the bulk of the diff and none of it should change how dark theme looks.

### Shell variables

| Variable | Dark | Light |
|---|---|---|
| `--bg` | `#0c0c10` | `#eef0f4` |
| `--panel` | `rgba(20,20,26,0.82)` | `rgba(252,252,254,0.86)` |
| `--panel-solid` | `#16161c` | `#f7f8fa` |
| `--border` | `#2c2c36` | `#c9ccd4` |
| `--border-strong` | `#3a3a46` | `#b0b4be` |
| `--text` | `#e8eaf0` | `#16171c` |
| `--text-strong` | `#ffffff` | `#000000` |
| `--muted` | `#8f92a0` | `#5c606c` |
| `--dim` | `#6a6d7a` | `#82868f` |
| `--accent` | `#2563a8` | `#2563a8` |
| `--accent-edge` | `#3b82d6` | `#1d5fb0` |
| `--accent-text` | `#ffffff` | `#ffffff` |
| `--warning` | `#f2b04a` | `#9a6200` |
| `--error` | `#ff6b6b` | `#c0362f` |
| `--control` | `#23232c` | `#e6e8ee` |
| `--control-hover` | `#2e2e3a` | `#dadce4` |
| `--control-text` | `#d8dae4` | `#22242b` |
| `--input-bg` | `#16161d` | `#ffffff` |
| `--scrollbar` | `#2a2a34` | `#c2c6cf` |
| `--track` | `#202029` | `#d8dbe2` |
| `--readout-bg` | `rgba(12,12,16,0.93)` | `rgba(252,252,254,0.95)` |
| `--backdrop` | `rgba(6,6,9,0.6)` | `rgba(40,42,50,0.35)` |
| `--row-selected` | `rgba(37,99,168,0.28)` | `rgba(37,99,168,0.18)` |
| `--table-rule` | `rgba(44,44,54,0.5)` | `rgba(160,164,174,0.5)` |
| `--marker` | `#ffffff` | `#16171c` |
| `--marker-shadow` | `#000000` | `#ffffff` |
| `--check-text` | `#cfd2dc` | `#33363f` |
| `--warning-border` | `rgba(242,176,74,0.55)` | `rgba(154,98,0,0.45)` |
| `--warning-bg` | `rgba(242,176,74,0.1)` | `rgba(242,176,74,0.16)` |
| `--error-border` | `rgba(255,107,107,0.5)` | `rgba(192,54,47,0.45)` |

`--warning` is not the same hue in both. `#f2b04a` is an amber tuned to glow on
near-black; as *text* on a light panel it fails contrast outright, so light theme uses a
darkened `#9a6200`. The warning *fill* keeps the amber, because a fill is read as a
region rather than as glyphs.

### Plot chrome variables

| Variable | Dark | Light |
|---|---|---|
| `--hds-plot-fg` | `#e8eaf0` | `#16171c` |
| `--hds-plot-muted` | `#8f92a0` | `#5c606c` |
| `--hds-plot-label` | `#c9ccd8` | `#33363f` |
| `--hds-plot-border` | `#2c2c36` | `#c9ccd4` |
| `--hds-plot-surface` | `rgba(255,255,255,0.015)` | `rgba(20,21,26,0.025)` |

## 4. Plots

`PLOT_COLORS` and `PLOT_PANEL` become `plotPalette(resolved)`, reached from components
through a `usePlotPalette()` hook. Six files import these constants today.

| Key | Dark | Light |
|---|---|---|
| `axis` | `#3a3a46` | `#a8acb6` |
| `grid` | `rgba(143,146,160,0.10)` | `rgba(92,96,108,0.14)` |
| `accent` | `#38bdf8` | `#0369a1` |
| `threshold` | `#f0554a` | `#c2362b` |
| `reference` | `#4ade80` | `#15803d` |
| `contour` | `rgba(255,255,255,0.7)` | `rgba(20,21,26,0.65)` |
| `convection` | `#38bdf8` | `#0369a1` |
| `radiation` | `#f59e42` | `#b45309` |
| `panel` | `#16161c` | `#e6e8ec` |

`panel` is a step *lighter* than the background in dark theme and a step *darker* than
it in light. Both give the data area its own stable ground so a plot is not read
against whatever the 3D model happens to be showing through the translucent dock.

`SERIES_COLORS` — the categorical ramp for per-part profile lines — needs a per-theme
variant. An earlier draft of this spec claimed the eight hues were "mid-tone enough to
hold on both panels"; measured, they score 6.6–11.8 against the dark panel and
1.25–2.22 against the light one. They are tuned to glow on near-black, like `--warning`.
Being distinguishable from each other is not their only job — they also have to be
visible.

| Pairs with | Dark | Light | Light vs panel |
|---|---|---|---|
| orange | `#f59e42` | `#b45309` | 4.09 |
| sky | `#38bdf8` | `#0369a1` | 4.84 |
| violet | `#a78bfa` | `#6d28d9` | 5.79 |
| green | `#4ade80` | `#15803d` | 4.09 |
| pink | `#f472b6` | `#be185d` | 4.92 |
| yellow | `#facc15` | `#a16207` | 4.01 |
| blue | `#60a5fa` | `#1d4ed8` | 5.46 |
| orange-2 | `#fb923c` | `#c2410c` | 4.22 |

Hue and order are preserved so a part keeps its identity across a theme switch. Mutual
separation does not suffer: the closest pair in the light ramp is ΔE 13.8 against the
dark ramp's 8.7, so the light ramp is the more distinguishable of the two.

### The mark contrast rule, generalised

`markColor` today lifts the cold end of the ramp toward white so a cold scatter point
does not vanish into the near-black panel. On a light panel that end is already fine and
the *hot* end is the one that disappears. The rule is the same shape, mirrored:

```ts
interface MarkContrast {
  /** The pole to blend toward: 1 (white) on a dark panel, 0 (black) on a light one. */
  target: 0 | 1;
  /** Per-channel blend strength at the far end of the ramp. */
  strength: RGB;
  /** Which end needs the pull. */
  end: 'cold' | 'hot';
}
```

with `weight = end === 'cold' ? 1 - t : t` and, per channel,
`out = c + (target - c) * strength * weight`.

| | Dark | Light |
|---|---|---|
| `target` | `1` | `0` |
| `strength` | `[0.22, 0.22, 0.30]` | `[0.32, 0.32, 0.38]` |
| `end` | `cold` | `hot` |

Substituting the dark row reproduces today's expression exactly, so dark theme output is
unchanged. Hue and order are untouched in both, so a mark still reads as the temperature
it has in the 3D view.

Area fills stay unlifted in both themes, for the reason they always were: the cut-plane
field covers the panel, has nothing to separate from, and is read against its own ramp.

## 5. Viewer

`ThermalScene` gains `setBackground(color: number)`; the background is fixed at
construction today.

**Only two viewer colours are per-theme.** The rule, which an earlier draft of this
spec got wrong by hand-listing colours instead of deriving them:

> A colour drawn *on the mesh* does not need a per-theme value, because the mesh's
> colours do not change with the theme. Only what sits *behind* the model does.

Overlays, the hover and selection highlights and the feature edges are all drawn onto
mesh faces, so what they must clear is the colormap — and the colormap is theme-
independent. Their contrast is therefore identical in both themes, and changing them
per theme would only make them worse against the thing they actually have to clear.

| Constant | Dark | Light | Why |
|---|---|---|---|
| `BACKGROUND_COLOR` | `0x0c0c10` | `0x71747a` | Section 1. |
| `NO_DATA_COLOR` | `0x5a6070` | `0xcdd0d6` | It *is* mesh, so it must clear the background to be seen at all. 3.11 on dark; `0xcdd0d6` gives 3.03 on light. |

`NO_DATA_COLOR` goes *lighter* in light theme, not darker. Darkening it cannot reach
3.0 against `#71747a` without approaching near-black, where it would collide with the
cold end of the ramp — the one thing it must never be confused with. What makes it read
as "not solved" is that it is *desaturated*, which no colormap ever is, so lightness is
free to move.

Everything else is unchanged in both themes: the four remaining overlay colours,
`SELECTION_COLOR`, `featureEdges`, the black 0.13-opacity wireframe, lighting and
specular.

One pre-existing weakness, recorded because measuring for this change surfaced it and
it would otherwise look like a regression: **`HOVER_COLOR` is white, which scores 1.05
against the ramp's hot end — in the theme that ships today.** Hovering a hot surface
already shows almost nothing. No flat colour can clear a full-range colormap; the fix
is a different highlight technique, not a different colour, and it is out of scope
here. White is kept in both themes. It is also the better of the two against the new
light background (4.69, against 4.05 for the near-black an earlier draft proposed).

## 6. Tests

- `resolveTheme` across every mode × system-preference pair.
- `localStorage` round-trip, and an invalid stored value falling back to `system`.
- **Palette completeness** — every key present in both themes, so a half-converted
  palette cannot ship.
- **Contrast floor** — every colour that *encodes something* clears its own theme's
  panel or background by 3.0, WCAG's threshold for graphical objects. This is the test
  that catches a background choice swallowing an end of the ramp, rather than leaving it
  to be noticed by eye; it is what caught `#b9bdc6`.

  The floor applies to colours a reader has to *resolve*: the plot palette's `accent`,
  `threshold`, `reference`, `convection`, `radiation`, all eight `SERIES_COLORS`, and
  `NO_DATA_COLOR` against the viewport background.

  It deliberately does not apply to structural chrome — `axis`, `grid`, `barEdge`, and
  the panel borders. An axis rule measures 1.61 on dark and 1.85 on light, and that is
  correct: a hairline that competes with the data for attention is a worse plot. These
  are excluded by name in the test with this reason stated, never by lowering the floor
  until everything passes. If a colour fails, the colour moves or the exclusion is
  argued explicitly — the threshold does not.
- `markColor` under the dark palette reproduces the pre-change values, pinning the
  claim that dark theme is untouched.

## 7. Known limitations

- `#71747a` clears the measured floor but is unvalidated against long use. Light theme
  is a graphite stage under light chrome, which is a deliberate trade (section 1) but
  still a look worth living with before calling it settled.
- Nothing here re-tones the colormaps themselves, so the cold end of a light-theme model
  is still near-black — correct, but it means a cold model reads as a dark silhouette.
- The hover highlight is weak on hot surfaces in **both** themes (section 5). Untouched
  here, and worth its own change.
- Overlay colours are carried into light theme unchanged on the argument in section 5.
  That argument is sound for faces drawn on the mesh, but an overlay silhouetted against
  the background is a different case: `contacts` (1.50), `cavities` (1.37) and
  `SELECTION_COLOR` (1.84) are all weak against `#71747a`. Worth a look on the running
  app before deciding whether the rule needs an exception.
