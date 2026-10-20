# Optic colour pipeline

All processing is in **scene-linear Rec.2020 (D65), 32-bit float**. Stages run in this order; each is
one file in `src/pipeline/stages/`. Stages whose values are at default are not compiled into the
shader at all.

| # | Stage | Notes |
|---|---|---|
| 00 | input | Source sampling, clip mask (alpha), deband / deblock for 8-bit sources |
| 05 | lensCorrection | Crop / straighten / transform and lens corrections: one resample ([EFFECTS.md](EFFECTS.md)) |
| 10 | whiteBalance | **One matrix** = calibration · camera→working · white balance (pre-multiplied on the CPU), plus clipped-highlight neutralisation |
| 20 | cameraToWorking | Folded into 10 (kept as the `until: 'cw'` reference point) |
| 22 | noiseReduction | Luminance / colour NR (spatial, [EFFECTS.md](EFFECTS.md)) |
| 25 | calibration | Shadows tint (the primaries live in the stage-10 matrix) |
| 27 | colorCast | Remove colour cast (per-zone OKLab offsets) |
| 28 | dehaze | Dark channel prior ([EFFECTS.md](EFFECTS.md)) |
| 30 | exposureTone | Exposure, highlights/shadows, contrast, filmic shoulder, whites, blacks |
| 35 | texture / clarity | Local contrast in log luminance ([EFFECTS.md](EFFECTS.md)) |
| 40 | hsl | 8-band OKLCH mixer |
| 45 | pointColor | Up to 8 sampled colour ranges, skin uniformity |
| 50 | toneCurve | 4096-entry LUT on gamma-2.2 values |
| 52 | bwMixer | Monochrome conversion (only when treatment = monochrome) |
| 55 | colorGrading | Shadows / midtones / highlights / global wheels |
| 60 | presence | Vibrance, saturation |
| 70 | lut | 3D LUT, tetrahedral, per-LUT input space, amount 0–200 % |
| 75 | look | Highlight roll-off, shadow density, micro-contrast, colour density, warmth bias |
| 80–86 | halation & bloom, vignette, grain, sharpening | [EFFECTS.md](EFFECTS.md) |
| 90 | output | Working → destination, soft gamut compression, transfer, dither |

**Why B&W is at 52, not after presence.** Grading has to come *after* the conversion. Otherwise
the grey conversion would erase the tint, and split-tone / selenium / sepia looks would be
impossible. With the mixer first, a monochrome image is neutral until grading tints it.

## Calibration

Like a camera-calibration panel, but applied to the working-space primaries:

1. Each primary (pure R, G, B of linear Rec.2020) is converted to OKLab.
2. Its hue is rotated (±100 → ±30°) and its chroma scaled (±100 → ×(1 ± 0.55)), at constant lightness.
3. The three moved primaries become the columns of a matrix `M_raw`. A pixel's RGB weights now mix
   the *new* primaries.
4. White is preserved by rescaling the columns: `s = M_raw⁻¹ · (1,1,1)`, `M = M_raw · diag(s)`, so
   `M · (1,1,1) = (1,1,1)`.
5. The optional advanced 3×3 matrix (rows normalised to sum to 1, which also preserves white) is
   applied after.

Calibration is multiplied into the white-balance / camera matrix on the CPU whenever any of them
changes (`src/pipeline/derive.ts`), so it costs nothing per pixel. The **shadows tint** is a small
green↔magenta OKLab offset weighted to shadows (stage 25).

## Point colour

Each point stores a target colour (OKLCH) and adjustments. A pixel's weight is the product of three
smooth windows: hue distance (wrapped), chroma distance and lightness distance. The window widths
come from the range sliders and the edge softness from *Smoothness*. Near-neutral pixels (no
meaningful hue) are excluded. Inside the mask the point shifts hue, chroma and lightness.
*Uniformity* pulls hues toward the target hue, which evens out blotchy redness in skin; the *Skin*
button picks a point pre-configured for that.

*Visualize range* shows the combined mask as grey; the later stages are neutralised while it is on.

## Colour grading

In OKLab: each wheel adds a chroma offset in the direction of its hue (OKLCH hue, the same hue the
wheel shows) proportional to its saturation (100 ≈ 0.06), and scales lightness by its *Lum* slider.

- **Zone masks:** smooth functions of OKLab L, with boundaries at ≈ 0.3 / 0.7.
- **Balance** shifts those boundaries.
- **Blending** widens their overlap.

Offsets are additive, so with saturation 0 neutrals stay exactly neutral. Very deep shadows fade
the offset out to keep pure black black.

## The look layer

The "character" controls presets are built from (stage 75):

- **Highlight roll-off** — above a knee (gamma-2.2 value 0.55), f(t) = t + a·t²(1−t): slope 1 at the knee
  (no kink), slope 1−a at white, monotone. Longer, softer approach to white (medium-format smoothness).
- **Shadow density** — deepens the lower tones while keeping black at 0 and the toe slope positive,
  so it adds weight without crushing.
- **Micro-contrast** — local contrast at a small, image-relative radius:
  - The Pipeline renders the image up to stage 70 into a **512 px (long edge) map** (an image-wide
    map like the Phase 3 ones, see [EFFECTS.md](EFFECTS.md)) from the preview
    proxy, as log2 luminance.
  - It blurs that map with a separable Gaussian (σ = 3 map px ≈ 0.6 % of the long edge).
  - Each pixel's own log luminance minus the blurred value is its local detail, which is amplified
    (midtones only).
  - Export builds the map from the same proxy, so preview and full-resolution export match.
    Measured: export vs preview differs by +0.3 levels with micro-contrast 80, against a 1.6-level
    baseline from resampling and JPEG alone.
- **Colour density** — lowers OKLab lightness as chroma rises (dye density): reds and blues get rich
  instead of neon.
- **Warmth bias** — a small OKLab shift toward amber or blue that fades out near white and black, so
  whites stay white.

## 3D LUTs

- **Formats:** `.cube` (any `LUT_3D_SIZE` 2–129, with `DOMAIN_MIN/MAX` and `TITLE`) and Hald CLUT PNGs
  (level 8, 12, 16…; 8- or 16-bit).
- **Storage and lookup:** the table becomes a 3D float texture, read with `texelFetch` and tetrahedral
  interpolation (the cube split into 6 tetrahedra along its diagonal; 4 fetches).
- **Input space:** before lookup the working colour is converted into the LUT's declared space, then
  converted back after:

  | Input space | Primaries | Transfer |
  |---|---|---|
  | sRGB gamma | Rec.709 | sRGB |
  | Display P3 gamma | P3 | sRGB |
  | Linear | Rec.709 | linear |
  | ARRI LogC3 | ALEXA Wide Gamut | LogC3 (EI 800) |
  | Apple Log | Rec.2020 | Apple Log |

- **Amount:** blends in linear light. Above 100 % extrapolates the change; output gamut compression
  keeps it in range.
- **Errors and persistence:** malformed files raise a readable error (line number, expected entry
  count) and never reach the renderer. Imported LUTs are stored in IndexedDB.

## Performance notes

- One fused shader pass for all point stages.
- Calibration, white balance and the camera matrix cost one mat3.
- Point colour is a fixed, branchless 8-iteration loop.
- The micro-contrast map is cached on the upstream recipe and rebuilt only when it changes.
- Histogram readback is asynchronous (pixel-pack buffer + fence), so it never stalls a frame.
- Preset thumbnails render one per frame and pause while a pointer is held down.

Measured on an Intel UHD 730 iGPU at a ~1 MP canvas with every Phase 2 stage active: about 8.5 ms
of GPU time per frame and 58–60 fps while dragging a slider.
