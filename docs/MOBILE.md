# Android app

Optic ships as an Android app through [Capacitor 8](https://capacitorjs.com). The app runs the
same Vite build (`dist/`) from the APK, fully offline, with a few native additions.

| | |
|---|---|
| Project | `android/` (Gradle), config in `capacitor.config.ts` |
| Build | locally: `npm run android:apk` → `release/optic-<version>.apk` |
| Application id | `in.techbysh.optic` |
| Version | `package.json` `version` (1.2.3 → versionCode 10203) |

## How it differs from the web app

- **Not cross-origin isolated.** Android WebView never isolates a page, whatever COOP / COEP headers
  it gets (measured on WebView 124: shared memory cannot be posted to a worker). So
  `SharedArrayBuffer` is undefined, LibRaw and the other decoders run single-threaded, and decoded
  images are copied between threads instead of shared. Results are identical to the web app
  (checked on the same NEF, decode and render); only very large files are slower.
  **Never reference `SharedArrayBuffer` unguarded**: use `transferable()` / `allocFloat()` in
  `io/decode/imageOps.ts`. An unguarded `instanceof SharedArrayBuffer` in the decode workers made
  every photo fail on Android ("could not be read") until it was fixed.
- **HEIC** decodes with libheif (WASM), as on the web. WebView cannot decode HEIC itself, so the
  import dialog's quick thumbnails come from libheif too (`fileInfo.ts`, up to 26 MP; larger
  photos get their thumbnail from the background render).
- **Saving files** (`src/app/native.ts`). WebViews cannot download, so exports, ZIPs, preset packs
  and edit packs are written to the app cache in 3 MB chunks, then copied into the gallery
  (`Pictures/Optic`) or `Download/Optic` (archives) through MediaStore (`OpticFilesPlugin.java`,
  no permission needed on Android 10+). Android 7–9 use the share sheet instead.
- **Opening photos from other apps**: "Share → Edit in Optic" (one or many) and "Open with". The
  plugin copies them into the cache and they are imported like dropped files (one photo opens in
  the editor).
- **Picker**: Android does not know most RAW MIME types, so the app's file inputs also accept
  `image/*` and `application/octet-stream` (unsupported files are skipped at import by name).
- **Back button**: closes the topmost sheet or dialog, then returns from the editor to the library,
  then leaves the app.
- Native haptics for slider detents and long-press, status-bar icons following the theme, a dark
  splash screen and adaptive icons (`npm run native:assets`). No service worker (`initPwa` returns
  early): every file is already in the APK.

## Build the APK

Needs Node 22+, JDK 21 and the Android SDK (platform 36; Gradle downloads what is missing).

```bash
npm ci
npm run android:apk            # → release/optic-<version>.apk
```

Release signing reads `android/keystore.properties` (gitignored):

```properties
storeFile=optic-release.jks
storePassword=…
keyAlias=optic
keyPassword=…
```

`storeFile` is relative to `android/`. Create a key with
`keytool -genkeypair -keystore android/optic-release.jks -alias optic -keyalg RSA -keysize 4096 -validity 10000`.
**Back up the keystore and its password**: Android only installs an update over an existing install
when it is signed with the same key. Without `keystore.properties` the release APK is signed with
the debug key (installable, but not for Play). CI can pass `OPTIC_KEYSTORE`,
`OPTIC_KEYSTORE_PASSWORD`, `OPTIC_KEY_ALIAS`, `OPTIC_KEY_PASSWORD` instead.

## Debugging

- `OPTIC_DEBUG=1 npm run android:apk` builds an APK whose WebView can be inspected
  (`chrome://inspect`, or `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`).
- `OPTIC_DEV_URL=http://localhost:5173` (with `npx cap sync android`, then Gradle) makes the app load
  the Vite dev server; run `adb reverse tcp:5173 tcp:5173` first. `window.__optic` is then
  available inside the app for tests.
- **Emulator**: start it with `-gpu host`. The default software renderer ("Android Emulator OpenGL
  ES Translator (Google SwiftShader)") scrambles uniform values in larger shaders (colour noise
  reduction turned RAW photos magenta); with the host GPU, renders match desktop exactly.

## Verified (Android 15 emulator, WebView 124, host GPU)

Import through the system picker and through "Share → Edit in Optic"; JPEG, PNG, HEIC (12-bit
conformance file and a 45 MP photo), Nikon NEF; editing; a 45 MP HEIC → JPEG export saved to
`Pictures/Optic` at full size. Not yet tried on a physical phone, with CR3 / ARW / ProRAW, or for
48 MP export memory on low-RAM devices.
