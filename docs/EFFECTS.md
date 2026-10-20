# Optic detail, effects, lens & geometry (Phase 3)

This covers the Phase 3 tools: what each one does, how it is built, and the rules that make every
spatial effect look the same in the Fit preview, at 100 % and in the full-resolution export. The
colour stages are in [COLOR.md](COLOR.md); the preset format is in [PRESETS.md](PRESETS.md).

## Pipeline order

| # | Stage | Kind | Notes |
|---|---|---|---|
| 00 | input | source | Samples the source once per output pixel (through stage 05) |
| 05 | lensCorrection | warp | Crop, straighten, upright/transform, lens profile, CA, defringe, vignetting correction |
| 10 | whiteBalance | point | (Phase 2) |
| 20 | cameraToWorking | — | (Phase 2, never compiled) |
| 22 | noiseReduction | spatial | Luminance and colour NR on linear data |
| 25–27 | calibration, colorCast | point | (Phase 2) |
| 28 | dehaze | point + map | Dark-channel prior |
| 30 | exposureTone | point | (Phase 2) |
| 35 | texture / clarity | spatial / point + map | Local contrast in log luminance |
| 40–75 | hsl … look | point | (Phase 2) |
| 80 | halationBloom | point + map | Light spread around highlights |
| 82 | vignette | point | Post-crop |
| 84 | grain | point | Late, so the grain is not colour-graded |
| 86 | sharpening | spatial | Output sharpening on OKLab lightness |
| 90 | output | point | (Phase 2) |

**The B&W mixer stays at 52**, before colour grading, rather than after presence as the Phase 3
brief listed it. Moving it would change how every existing B&W preset with a split tone renders
(selenium, sepia), and v2 recipes must render exactly as before. Grading after the grey conversion
is what makes split tones possible.

## Resolution independence

Every effect with a size is defined as a **fraction of the source image's long edge**. Radii given
"in pixels" use a 24 MP reference (6000 px long edge) and scale with the image: a 1 px sharpening
radius is 1.34 px on a 48 MP file. Three mechanisms keep the preview and the export identical:

1. **Render-resolution spatial stages** (noise reduction, texture, sharpening) convert their radius
   to target pixels with `pxScale` (full-resolution pixels per target pixel: 1 at 100 % and in
   export, about 3 at Fit for a 48 MP file). Scales finer than a target pixel are skipped, because
   the downscale has already averaged them, and noise thresholds follow the averaged noise level.
   At 100 % the preview *is* the export, pixel for pixel. At Fit it approximates the downscaled
   export, which is why the Detail panel says to zoom to 100 % to judge.
2. **Image-wide maps** (clarity, dehaze, halation/bloom, micro-contrast) are rendered from the
   whole-image preview proxy at a fixed density per source long edge (512 or 1024 texels), over the
   whole output frame. The preview, the histogram and every export tile use the same map, so
   large-radius effects match exactly and tiles cannot have seams. Maps are cached on the uniforms
   of every stage upstream of them, and fine-detail stages (`skipInMaps`: NR, texture, sharpening)
   are left out of map renders.
3. **Grain** is sampled with an explicit mip level, `log2(output pixels per screen pixel / grain
   texel)`, i.e. the exact area average of the full-resolution grain. Measured: the 100 % preview
   differs from the export by at most 1.9 / 255 (mean 0.4 / 255, the preview's dither and 8-bit
   quantisation), pixel-aligned.

Export tiles render a padded frame: the Pipeline pads intermediate passes by the summed `reach` of
the spatial stages (rounded up to a multiple of 4, so downsampled helper grids align with output
pixels), and each tile's source area is found by mapping the padded tile through the output →
source transform. `npm run test:seams` renders a 4096 px synthetic image with every spatial effect
at full strength in 512 px tiles and as one tile: the maximum difference is **0** (the limit is
1/1024), while the effects change the image by about 10 % on average (a control, so a no-op cannot
pass).

## Detail

### Sharpening (86)

Unsharp mask on OKLab lightness, applied as a lightness difference to the full-precision pixel, so
there are no colour fringes.

| Control | Range | Effect |
|---|---|---|
| Amount | 0–150 | Strength (`amount / 100 × 1.6`) |
| Radius | 0.5–3 px at 24 MP | Gaussian σ of the blur |
| Detail | 0–100 | Halo suppression: the result is clamped to the 3×3 local range widened by `0.04 + 0.5 × detail` of it. Low detail = no halos; high = crisper fine texture |
| Masking | 0–100 | Edge mask from the gradient of the blurred lightness, measured across the radius. Hold **Alt / Option** while dragging to see it (white = sharpened) |

Defaults: 30 / 1.0 / 25 / 0 for raw files, off for JPEG/HEIC/PNG (already sharpened in camera).
Measured on the sample at 100 %: with Masking 80 the mean change in flat areas is 0.014 / 255, against
0.27 / 255 without masking. Only the strong edges change.

### Noise reduction (22)

An edge-avoiding à-trous wavelet transform in OKLab with soft thresholding:

- Each level smooths the previous one with a dilated 3×3 B-spline whose weights fall off with the
  difference to a robust reference (mostly the 3×3 mean, so a lone impulse cannot shield itself).
  Level *j* uses a dilation of 2^j full-resolution pixels. Luminance: 1–16 px. Colour: 1–32 px, plus
  64 and 128 px with more Smoothness, with the lightness as the edge guide.
- The detail each level removes is soft-thresholded: amplitudes below τ (noise) go, larger ones
  (texture, edges) keep their shape. Reconstruction = coarsest level + thresholded details, exactly
  the input when τ = 0. A little of the original noise is put back (6 % of the lightness noise,
  3 % of the chroma noise), so the result is not plastic.
- τ follows the image's measured noise model σ²(Y) = S·Y + O (`src/color/noiseEstimate.ts`: lower
  quartile of neighbour residuals per brightness bin, measured in idle time after opening), converted
  to OKLab lightness per pixel.
- At the finest level, isolated extrema (dark ones always; bright ones unless far beyond the noise,
  i.e. real point lights) are treated as impulses. Fine chroma detail fades with Color strength,
  and Color detail brings it back.

| Control | Effect |
|---|---|
| Luminance | Threshold strength for lightness noise |
| Detail | Finer levels keep more (lower thresholds, stronger edge stopping) |
| Contrast | Coarser levels keep more (local contrast) |
| Color | Threshold strength for chroma noise |
| Color detail | Keeps fine colour detail |
| Smoothness | Adds coarse levels against low-frequency colour mottle |

Default: Color 25 for raw files. On a simulated ISO 2500 night shot (−3 EV plus Poisson–Gaussian
noise, brought back with +3 EV), Luminance 40 / Color 25 cleans up the noise and keeps skin texture.

## Effects

### Texture and clarity (35)

Both split log₂ luminance into an edge-aware base and detail with a self-guided **guided filter**
(`src/pipeline/gl/guidedFilter.ts`). The base keeps strong edges, so scaling the detail adds no
halos; hue and saturation are kept (RGB is scaled by one factor).

- **Texture** (−100…+100, radius 0.25 % of the long edge) is a spatial stage. Its coefficients are
  computed at ½ or ¼ resolution (a fast guided filter) and applied to the full-resolution guide.
  Negative values smooth fine texture (skin) without blurring edges.
- **Clarity** (−100…+100, radius 1.2 %) takes its coefficients from a 1024 px image-wide map of the
  image after stage 30 and applies them per pixel to the full-resolution log luminance. It works on
  the midtones; deep shadows and highlights are protected.

### Dehaze (28)

Dark channel prior on a 512 px map of the image after stage 27:

1. dark channel = min over R, G, B, min-filtered over a 1.5 % patch;
2. atmospheric light A = the colour of the haziest pixels, a weighted mean with weights
   exp(12 · dark), reduced on the GPU to a 1×1 texture (no CPU readback);
3. haze density = min-filtered min_c(I/A), refined with a guided filter (guide: lightness relative to
   A), and applied through its coefficients to the full-resolution lightness.

Positive amounts: transmission t = 1 − 0.85·ω·h, J = (I − A)/t + A, with sky-like areas near A
protected. Negative amounts blend toward a softened A, more where the scene is already hazy.

### Grain (84)

A deterministic, tileable 512² noise texture (`src/pipeline/gl/grainNoise.ts`): Gaussian white noise,
high-passed (a blue-noise character, with no mottle) and very lightly softened, in three independent
channels plus a coarse field. The stage samples three octaves with incommensurate scales (1, 1.618,
0.707) and rotations (0°, 37°, 71°), so the period never shows. The grain is anchored to output
pixels and seeded from the photo's identity (name, size, date), so a photo always gets the same grain.

| Control | Effect |
|---|---|
| Amount | OKLab lightness amplitude |
| Size | Grain texel 0.45–2.85 px at 24 MP |
| Roughness | Weight of the larger octave, a crisper grain profile, gentle clumping |
| Color | Chroma grain in OKLab a, b |
| Type | Fine (ISO 100), Medium (400), Coarse (3200), 35mm, Medium format: preset amount / size / roughness |

Tonal response like film: strongest in the midtones, weaker in deep shadows and bright highlights.

### Halation and bloom (80)

Light spreading around highlights, from a 1024 px map of the image after stage 75: soft threshold in
linear light → box pyramid → a Gaussian at the pyramid level where the kernel is a few texels wide.
Both **redistribute** light rather than add it: glow = the blurred highlight minus the pixel's own
highlight. A large, uniformly bright area therefore stays as it is, while light spills into the
darker surroundings.

- **Halation** (Amount, Threshold, Radius 0.15–2 % of the long edge, Hue: 0° red, 30° orange):
  the red glow of film without an anti-halation layer (the Cinestill look).
- **Bloom** (Amount, Threshold, Radius 0.5–7.5 %, Warmth): a diffusion-filter glow (Pro-Mist). Four
  Gaussians (σ × 0.35 / 0.7 / 1.4 / 2.8, weights 0.4 / 0.3 / 0.2 / 0.1) give a bright core and a long
  tail.

### Vignette (82)

Always relative to the cropped frame. Amount ±100 (±2 stops at the corners), Midpoint, Roundness
(0 follows the frame, +100 is a circle, −100 a rounded rectangle), Feather, Highlights (protects
bright areas when darkening). Styles:

- **Highlight priority** (default): an exposure change in linear light.
- **Color priority**: OKLab lightness only, so hue and chroma hold.
- **Paint overlay**: a blend toward black or white in the gamma domain.

## Lens corrections (05)

Applied while sampling the source, in this order (`src/geometry/lens.ts`, mirrored in GLSL):

1. **Manual distortion**: r_d = r_u·(1 + k·r_u²) about the centre (+ corrects barrel).
2. **Profile ("Auto (from file)", on by default for raw files)**:
   - DNG opcode lists (`src/io/decode/dngOpcodes.ts`): **WarpRectilinear** (radial kr0…kr3 and
     tangential kt0, kt1 per colour plane, evaluated in raw coordinates as the DNG spec defines),
     **FixVignetteRadial** and **GainMap** (per plane, or per CFA phase merged to RGB via
     CFAPattern). Phones (Android, many ProRAW files) embed these. LibRaw without the DNG SDK
     applies none of them, so Optic applies them on both decode paths.
   - Otherwise, for raw files with an EXIF lens name: a **lensfun** calibration from the bundled
     subset (689 lenses, CC BY-SA 3.0; regenerate with `npm run lensfun:subset`), with ptlens /
     poly3 / poly5 distortion, poly3 / linear TCA and pa vignetting, interpolated at the focal
     length and aperture. It is lazily loaded.
3. **Lateral CA**: red and blue scaled radially relative to green. **Auto** measures it on the
   photo's radial edges (`src/geometry/caEstimate.ts`: per-edge sub-pixel alignment of R/B profiles
   to G, median of shift / radius). It is skipped when the profile already corrects CA.
4. **Defringe**: purple and green fringes next to high-contrast edges lose chroma (hue windows on a
   0–100 scale mapped to OKLCH).

Vignetting corrections (manual amount and midpoint, DNG, lensfun, gain map) multiply the sample.
A barrel-distorted synthetic grid with a matching WarpRectilinear opcode comes out with straight lines.

## Geometry, crop and straighten

One transform, one resample (`src/geometry/transform.ts`):

```
output pixel (O) → crop frame (R) → transformed (T) → undistorted (U) → source (S)
   crop rect        straighten,        upright /          lens model
   (1 px = 1 px)    90° turns, flips   perspective
```

O → U is a single projective 3×3 matrix; U → S is the lens model. The GPU evaluates both per pixel
and samples the source once.

- **Upright** (`src/geometry/upright.ts`): a GPU Sobel gradient at ≤ 1024 px, a gradient-constrained
  Hough transform and segment extraction on the CPU, then Nelder–Mead on a robust angular error in
  the transformed image. Auto, Level (rotate), Vertical (rotate + vertical), Full (+ horizontal);
  each only writes the sliders. **Guided**: draw 2–4 lines that should be vertical or horizontal.
  On a synthetic building tilted 2.5° and shot from below, Vertical returns Rotate −2.45°,
  Vertical −61: parallel, vertical walls.
- **Manual**: Vertical / Horizontal (camera pitch / yaw ±30° through K·R·K⁻¹, about the centre at
  unit magnification; negative Vertical widens the top, as in Lightroom), Rotate ±45° in 0.01° steps,
  Aspect, Scale, X/Y offset. A grid shows while a slider is dragged. **Constrain crop** shrinks the
  crop to the valid image.
- **Crop** (key R): handles, drag inside to move, drag outside to rotate, straighten tool (draw along
  the horizon), aspect presets (Original, Freeform, 1:1 … 2.39:1, custom; X swaps), guides (O
  cycles: thirds, golden ratio, golden spiral, diagonals, grid, triangles), flips and 90° turns,
  and the live output size. Straightening always keeps the crop inside the image. The crop is
  stored in the recipe and the export renders it at full resolution, never resampled: a 4:5 crop
  of an 8064 × 6048 frame exports at 4838 × 6048.

## History, snapshots and compare

- **History** (left panel): each commit is a named step ("Exposure +0.65", "Preset: Portra 400-like
  (80%)", "Crop 4:5", "Paste settings"). Labels come from a diff of the recipes
  (`src/state/describe.ts`), or explicitly from the action. Repeated edits of one control within
  1.5 s collapse into one step. Click to jump (the next edit truncates the steps after it), hover
  to preview. Capped at 500 steps.
- **Snapshots**: Ctrl/Cmd+Shift+S; restore, rename, update with the current settings, delete.
- **Virtual copies**: a second recipe for the same file, with its own history and snapshots, shown
  as a stack in the filmstrip and exported under its own name.
- Everything is saved per photo in IndexedDB (key: name, size, date) and restored when the file is
  opened again. Stored recipes are migrated like any other.
- **Compare** (Y cycles): split (draggable divider, vertical or horizontal) or side by side (zoom
  and pan locked). "Before" can be the original, the photo as opened this session, any snapshot,
  any history step or another virtual copy. Swap button and labels. `\` still shows the Before
  full screen.

## Performance

- Intermediate passes are kept per view (cache slot): a pass whose inputs did not change is not
  re-run, and neither are a spatial stage's helper passes when only later stages changed.
  Dragging grain does not re-run noise reduction.
- Image-wide maps are rebuilt only when something upstream of them changes, at most two variants
  per map (before / after in compare views).
- While a slider is dragged with expensive effects on, the preview renders at half resolution with
  half-density maps (draft) and refines about 150 ms after release.
- Render targets are pooled by tag, size and format; unused ones are freed.

`npm run bench` (48.8 MP synthetic, 1280 × 800 canvas, Intel UHD 730 iGPU):

| Case | Preview |
|---|---|
| Default recipe | 61 fps |
| Every Phase 3 effect, dragging grain | 61 fps |
| Every Phase 3 effect, dragging exposure (maps rebuild), full quality | 30 fps |
| Same, draft (what a slider drag uses) | 60 fps |

Full-resolution export render: 13.6 s with every effect, 3.2 s with the default recipe.

## Tests

- `npm run test:seams`: tiled vs untiled export (see above). Exits 1 on failure.
- `npm run bench`: the numbers above.
- Both drive `bench.html` (dev server only) in headless Chrome or Edge through `playwright-core`
  (`CHROME_PATH` / `CHROME_CHANNEL` to choose the browser).
