# Optic user guide

Optic is a photo editor and library that runs entirely in your browser. Your photos are never
uploaded: there are no accounts and no analytics. It opens RAW files (Apple ProRAW and other DNGs,
Canon CR2/CR3, Nikon NEF, Sony ARW, Fujifilm RAF, Panasonic RW2, Olympus ORF and more), HEIC, JPEG,
PNG, TIFF, WebP and AVIF.

- [Getting started](#getting-started)
- [The library](#the-library)
- [Editing](#editing)
- [Masks (local adjustments)](#masks-local-adjustments)
- [Working on many photos](#working-on-many-photos)
- [Exporting](#exporting)
- [iPhone and iPad](#iphone-and-ipad)
- [Offline, storage and privacy](#offline-storage-and-privacy)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Tips: RAW vs JPEG](#tips-raw-vs-jpeg)
- [Troubleshooting](#troubleshooting)

## Getting started

1. Open Optic in Chrome, Edge or Safari (desktop, iPhone or iPad).
2. Optional: install it as an app. In Chrome or Edge, use the install icon in the address bar. In
   Safari on iPhone or iPad, use **Share → Add to Home Screen**. The installed app works offline and
   opens photos from the Files app and "Open with".
3. Import photos: drop files or whole folders anywhere on the window, or use **Import…** /
   **Folder…** in the library. The import dialog shows a thumbnail of each file. In the dialog you
   can:
   - **Select / deselect** photos.
   - **Skip duplicates**: on by default. Duplicates are recognised by content, not by file name.
   - **Storage**:
     - **Copy into Optic** (recommended; required on Safari) stores a copy in the browser's private
       storage, so the photo is always available, also offline.
     - **Reference in place** (Chrome and Edge, when you pick files or a folder) keeps the original
       where it is. The browser asks for permission again after a restart, and moving the file
       breaks the link.
   - **Apply during import**: a preset (with an amount), a collection, keywords.
4. Imports run in the background. The app stays usable, and photos appear in the grid one by one.
   Each one first shows the camera's own preview, then Optic's render once it is ready.

## The library

Press **G** for the grid. Double-click a photo (or press **E** / Enter) to edit it.

- **Thumbnail size**: the slider in the toolbar.
- **Select**:

  | Action | How |
  |---|---|
  | Select a photo | Click |
  | Select a range | Shift-click |
  | Add or remove one photo | Ctrl/Cmd-click |
  | Select all | Ctrl/Cmd+A |
  | Move the focus | Arrow keys (Shift extends the selection) |

  On touch screens, a long press starts a multi-selection.
- **Rate, flag, label**. These keys work in the grid (on the selection) and in the editor (on the
  current photo):

  | Keys | Effect |
  |---|---|
  | 0–5 | Stars |
  | P / X / U | Pick / reject / unflag |
  | 6 / 7 / 8 / 9 | Red / yellow / green / blue label (the info panel also offers purple) |
- **Keywords**: in the info panel (**I**). Separate several keywords with commas.
- **Badges** on thumbnails:

  | Badge | Meaning |
  |---|---|
  | Format (RAW, JPEG, HEIC, …) | The file type |
  | ✎ | Edited |
  | ⧉ + number | Number of virtual copies |
  | Stars, flag, label | Rating, pick / reject, colour label |
- **Filter** (toolbar):
  - **Search box**: file name, keywords, camera and lens.
  - **Filter bar**:
    - rating (≥, =, ≤), flag and colour labels
    - file type, RAW / non-RAW, edited / unedited
    - camera, lens, capture date range or "last N days"
    - keyword and preset used
- **Sort**: capture date, import date, edit date, file name or rating; ↑ / ↓ flips the order.
- **Collections**: albums you fill yourself. Create one with **+** in the sidebar, then drag photos
  onto it.
- **Smart collections**: saved filters, for example "5★, RAW only, last 30 days". Set the filters,
  then choose **Save as smart collection**. A smart collection updates by itself.
- **Info panel** (**I**) shows for the focused photo:
  - a preview and a histogram
  - rating, flag, label and keywords
  - file details
  - the list of edits
  - the original's full EXIF
- **Remove from library** (Delete key, or ⋯ menu): removes the photo's edits and cached previews,
  and the copy stored in Optic. Optic asks first. Files that were referenced in place, and the files
  you imported from, are never touched.

## Editing

The editor shows the photo with the presets and history on the left, the adjustment panels on the
right and the filmstrip at the bottom. In the filmstrip, ← / → moves to the previous or next photo.

- **Every change is undoable** (Ctrl/Cmd+Z). The **History** tab lists each step by name, and you
  can click any step to go back to it. **Snapshots** save a named version of the edit.
- **Virtual copies** (filmstrip → **+ Virtual copy**) are independent edits of the same photo,
  for example a colour and a black-and-white version.
- **Compare** (**Y**) shows a split or side-by-side view against the original, a snapshot, a history
  step or another virtual copy. Hold **\\** to see the original.
- **Presets**: hover to preview, click to apply, then use the **Amount** slider (0–200 %) to
  strengthen or soften the preset. On non-RAW photos presets apply a little more gently.
- **Panels**:

  | Panel | Contents |
  |---|---|
  | White balance | As Shot / Auto / presets / eyedropper (**W**) |
  | Light | Exposure, contrast, highlights, shadows, whites, blacks |
  | Presence | Vibrance, saturation |
  | Look | Highlight roll-off, shadow density, micro-contrast, colour density, warmth |
  | Tone curve | RGB and per-channel curves |
  | Color mixer | Eight-band hue / saturation / luminance |
  | Point color | Pick a colour and shift only that colour |
  | Color grading | Shadows, midtones, highlights and global wheels |
  | Detail | Sharpening, noise reduction |
  | Effects | Texture, clarity, dehaze, grain, halation, bloom, vignette |
  | Lens | Corrections from the file or a lens profile, distortion, vignetting, chromatic aberration, defringe |
  | Transform | Upright, perspective |
  | Calibration | Primaries, shadow tint |
  | LUT | Load .cube or Hald LUTs |
- **Sliders**:

  | Action | How |
  |---|---|
  | Adjust | Drag |
  | Reset to default | Double-click |
  | Fine steps / 10× steps | Arrow keys / Shift+arrow keys |
  | Type a value | Click the number |
- **Crop** (**R**) has aspect presets, a straighten tool and composition guides (**O** cycles the
  guides, **X** swaps the orientation). Press Enter to apply.

## Masks (local adjustments)

Press **M** (or **Masks** in the toolbar) to open masking. A mask limits a set of adjustments to
part of the photo. You can have up to 16 masks per photo.

**New mask**:

| Mask | What it selects |
|---|---|
| Linear gradient | Full effect at the solid line, fading to none at the dashed line. Drag the dots; the yellow dot moves the whole gradient. |
| Radial gradient | An ellipse. Drag the centre to move it, the white dots to resize it (Shift for a circle), the blue dot to rotate it and the grey dot to set the feather. Tick "Effect outside the ellipse" for a vignette-style mask. |
| Brush | What you paint. Size, feather, flow and density are in the panel; **[** / **]** change the size, holding **Alt** erases and **Space** + drag pans. *Auto mask* stops the brush at edges. Pen pressure (Apple Pencil, Wacom) sets the flow. |
| Color range | The colours you pick with **Pick color** (Shift-click adds up to three); **Range** sets the tolerance. |
| Luminance range | A band of brightness, with soft edges set by **Smoothness**. **Pick luminance** centres the band on a clicked point. |
| AI: Subject, Sky, Background, Person (with parts: face skin, body skin, hair, eyes, lips, clothes) | Computed on your device. The first use downloads the model, with a progress bar; after that the model works offline. Edges are refined against the full-resolution photo, so hair and branches stay clean at 100 %. |

**Combine** components with **+ Add**, **− Subtract** and **∩ Intersect**. For example, *Sky ∩
Luminance range* darkens only the bright part of the sky. Each component can be inverted (⊘), and so
can the whole mask (⋯ → Invert).

**Adjustments per mask**:
- temperature, tint and exposure
- contrast, highlights, shadows, whites and blacks
- texture, clarity and dehaze
- hue, saturation and a colour tint
- sharpness and noise reduction

**Amount** (0–200 %) scales the whole set.

**Overlay** (**O**) shows the selected mask in colour or in black and white. The overlay appears by
itself while you paint or drag a handle.

**Mask presets**:
- Brighten face
- Darken sky
- Enhance eyes
- Soften skin
- Warm subject / cool background
- Pop subject

Masks follow cropping, straightening and perspective corrections automatically.

## Working on many photos

Select photos in the grid or in the filmstrip, then open the **Batch** menu:

- **Sync settings from the active photo**: tick the groups to copy (white balance, light, curves,
  masks, …). The active photo is the one outlined. Photo-specific groups start unticked: white
  balance, exposure, noise reduction, lens, geometry, crop and masks.
- **Auto Sync**: while it is on, every change you make to the open photo is repeated on all selected
  photos. A green **Auto Sync** badge in the top bar shows that it is on; click the badge to turn it
  off.
- **Copy / paste settings**: works on a whole selection too (Ctrl/Cmd+Shift+C, Ctrl/Cmd+Shift+V).
- **Apply a preset** to the selection, with an amount.
- **Auto white balance** and **Auto tone**: computed separately for each photo.
- **Match exposure & WB to the active photo**: matches the brightness and the white-balance look of
  the reference photo. Only white balance and exposure are written.
- **Reset edits** (asks first).

Each batch change is a single history step on each photo, so you can undo it photo by photo.

## Exporting

- **One photo**: **Export** (Ctrl/Cmd+E) in the editor.
- **Many photos**: select them, then choose **Batch → Export selection…**.

| Setting | Options |
|---|---|
| Format | TIFF 16-bit, JPEG (quality), PNG 16-bit, AVIF 10-bit, JPEG XL. AVIF and JPEG XL are written in sRGB without embedded metadata (the in-browser encoders cannot embed it). HEIC export is not offered: no browser encoder exists. |
| Color space | sRGB, Display P3, Adobe RGB, ProPhoto RGB |
| Size | Original, long edge, short edge, megapixels, percentage, or exact width × height (centre-cropped to that shape, e.g. 1080 × 1350 for Instagram 4:5). Optic never enlarges unless you tick *Allow enlarging*. |
| Output sharpening | Screen, matte paper or glossy paper × low / standard / high, applied after resizing |
| Metadata | All; all except location; copyright only; none |
| Author & copyright | Written into EXIF and XMP |
| Print resolution | ppi tag for TIFF, JPEG and PNG |
| File name | A template: `{filename}` `{date:YYYY-MM-DD}` `{seq:001}` `{preset}` `{rating}` `{camera}` `{custom}` `{copy}` (virtual copy name) |
| Watermark | Text or a PNG; position, size, opacity, margin |
| Edit file | Optionally also saves the edit as `<name>.optic.json` |

**Export presets**:
- Full quality TIFF
- Full quality JPEG
- Instagram 4:5 (1080×1350, sRGB)
- Instagram portrait 2160px
- Web 2048px
- Print 300dpi TIFF

**Save preset…** keeps your own settings. In **Settings**, choose which preset the export dialogs
open with.

**Where batch exports go**:
- **Save into a folder** (Chrome and Edge): pick a folder, and files are written as they finish.
- **Download as a ZIP** (all browsers): the archive is written to disk as it grows, so even hundreds
  of full-resolution photos do not fill memory. It downloads when the export is done.

**The export queue** (bottom right):
- progress per photo and a time estimate
- **Pause**, **Cancel** and **Retry failed**
- a summary at the end: how many photos, total size, and any failures with the reason

If you reload the page during an export, Optic offers to **resume** it.

**Moving edits to another device**: library **⋯ → Export edits (recipe pack)** saves the edits of
the selected photos (history, snapshots and virtual copies included) without the images. On the
other device, import the same photos, then use **⋯ → Import edits**. Photos are matched by content.

## iPhone and iPad

On a phone, and on an iPad in a narrow window, Optic uses a touch layout:

- The photo fills the screen. The toolbar at the bottom has **Presets · Light · Color · Effects ·
  Detail · Crop · Masks · Export**.
- Panels open as a **sheet**: drag its handle up for full height, or down to close it.
- **Sliders**:

  | Action | How |
  |---|---|
  | Adjust | Swipe sideways anywhere on the row; half the row width covers the whole range, for fine control |
  | Type a value | Tap the number |
  | Reset | Double-tap |

  A small vibration marks the default value, where the device supports it.
- **Presets**: a strip of thumbnails rendered on your photo. Tap a preset to apply it; tap it again
  for its amount slider.
- **Gestures** on the photo:

  | Gesture | Effect |
  |---|---|
  | Pinch, two-finger drag | Zoom and pan |
  | Double-tap | Fit / 100 % |
  | Press and hold | Show the original |
  | Two-finger tap | Undo |
  | Three-finger tap | Redo |
- **Apple Pencil**: the brush follows pen pressure.
- An iPad at full width with a keyboard or trackpad gets the desktop layout and every shortcut.
- **Share to Optic**: once Optic is installed, photos shared from the Photos app or Files open in
  Optic, where the platform supports web share targets.
- **Large photos (48 MP)**: on iPhone and iPad, Optic works with a smaller preview and exports in
  small tiles. If a photo needs more memory than the device allows, Optic shows a message instead of
  crashing.

## Offline, storage and privacy

- After the first visit, Optic works without a connection: the app, decoders, encoders, presets and
  LUTs are stored on the device. "Offline ready" in the top bar confirms it. AI models are downloaded
  the first time you use each AI mask, then kept for offline use.
- When a new version is available, a **Reload** button appears. It never interrupts an export
  without asking.
- **Settings → Storage** shows:
  - the space used and available
  - whether the browser has agreed to keep Optic's storage
  - how much the originals, previews and AI models take

  From there you can **clear the preview cache, computed AI masks or downloaded models**. Clearing
  never deletes originals or edits.
- Edits are saved continuously. A reload or a crashed tab loses nothing.
- Nothing leaves your device. The only network requests are the app itself and, the first time,
  the AI model files.

## Keyboard shortcuts

Press **?** in the app for the complete, searchable list. The most used:

| Keys | Action |
|---|---|
| G / E | Library / edit |
| 0–5, P / X / U, 6–9 | Rate, flag, label |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | Undo, redo |
| \\ (hold) | Before / after |
| Y | Compare views |
| Z | Fit / 100 % |
| R | Crop |
| M, O | Masks, mask overlay |
| [ / ] | Brush size |
| W | White-balance picker |
| V | Black & white |
| J | Clipping overlay |
| Ctrl/Cmd+E | Export |
| Ctrl/Cmd+Shift+C / V | Copy / paste settings |
| Ctrl/Cmd+, | Settings |

## Tips: RAW vs JPEG

- **RAW files** have far more latitude: highlights and shadows can be recovered, and white balance is
  measured in Kelvin. New RAW photos start with gentle capture sharpening, colour noise reduction and
  lens corrections. You can change these defaults in Settings → New photos.
- **JPEG, HEIC and other non-RAW files** were already processed by the camera, so they start with no
  adjustments. White balance is relative (−100 … +100), and presets apply a little more gently.
- **Exposure first**, then white balance, then contrast and colour. Presets are best applied after
  the photo is roughly exposed.
- For skies, *Darken sky* (or Sky ∩ Luminance range) keeps clouds bright while deepening the blue.
- Export in **Display P3** for modern phones and screens, **sRGB** for the web and social media,
  **Adobe RGB** or **ProPhoto RGB** (TIFF 16-bit) for print workflows.

## Troubleshooting

- **"Could not open …"**: the message names the file and the reason: unsupported type, damaged
  file, or not enough memory. A camera RAW from a very new camera may not be supported yet.
- **A referenced photo is "not available"**: the original was moved or deleted. Reconnect the drive,
  or import the file again.
- **The image goes black for a moment**: the graphics driver reset. Optic restores the view by
  itself; your edits are kept.
- **Select Sky marks a pale wall**: the sky model can mistake large, smooth, light areas for sky.
  Intersect it with a gradient or a luminance range, or subtract a brush.
