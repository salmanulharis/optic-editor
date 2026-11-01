# Android and iOS apps

Optic ships as native apps through [Capacitor 8](https://capacitorjs.com). The apps run the same
Vite build (`dist/`) from the app bundle, fully offline, with a few native additions.

| | Android (APK) | iOS (IPA) |
|---|---|---|
| Project | `android/` (Gradle) | `ios/App` (Xcode, Swift Package Manager) |
| Built | locally: `npm run android:apk` | GitHub Actions: `.github/workflows/ios.yml` |
| Bundle id | `in.techbysh.optic` | `in.techbysh.optic` |
| Version | `package.json` `version` (1.2.3 → versionCode 10203) | `package.json` `version`, build = run number |

## What the native shells add

- **Cross-origin isolation.** LibRaw's threads and the zero-copy export need COOP / COEP on every
  response. Android: `IsolatingWebViewClient.java` adds them to the local server's responses (the
  activity reloads once through it at start). iOS: `AppDelegate.swift` wraps Capacitor's
  `WebViewAssetHandler` scheme tasks (`IsolatingSchemeTask`). Settings → Graphics shows
  "Cross-origin isolated: yes" when this works.
- **Saving files** (`src/app/native.ts`). WebViews cannot download, so exports, ZIPs, preset packs and
  edit packs are written to the app cache in 3 MB chunks, then:
  - Android 10+: copied into the gallery (`Pictures/Optic`) or `Download/Optic` (archives) through
    MediaStore (`OpticFilesPlugin.java`, no permission needed); Android 7–9 use the share sheet.
  - iOS: the share sheet (Save Image, Save to Files, AirDrop, …).
- **Opening photos from other apps.** Android: "Share → Edit in Optic" (one or many) and "Open with",
  copied into the cache by `OpticFilesPlugin` and imported like dropped files. iOS: "Open in Optic"
  from Files (document types in `Info.plist`, delivered as `appUrlOpen`).
- **Android back button**: closes the topmost sheet or dialog, then returns from the editor to the
  library, then leaves the app.
- Native haptics for slider detents and long-press (iOS has no `navigator.vibrate`), status-bar
  icons following the theme, dark splash screens, adaptive icons.
- RAW files in the Android picker: Android does not know most RAW MIME types, so the native build
  also accepts `image/*` and `application/octet-stream` (unsupported files are skipped at import).
- No service worker in the apps (`initPwa` returns early): every file is already in the bundle.

## Build the Android APK

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

Open in Android Studio: `npx cap open android`. Debug on a device: `npx cap run android`, then
`chrome://inspect` (enable `android.webContentsDebuggingEnabled` in `capacitor.config.ts` first).

## Build the iOS IPA (GitHub Actions)

The workflow runs on pushes to `mobile-apps`, on version tags and by hand (Actions → iOS IPA → Run
workflow). The IPA is the run's artifact.

- **No secrets**: an unsigned IPA. Install it with AltStore or Sideloadly, which sign it with your
  Apple ID (7-day validity with a free account).
- **Signed**: add `IOS_CERTIFICATE_P12` (base64 .p12), `IOS_CERTIFICATE_PASSWORD`,
  `IOS_PROVISIONING_PROFILE` (base64 .mobileprovision for `in.techbysh.optic`), `IOS_TEAM_ID`, and
  optionally `IOS_EXPORT_METHOD` (`ad-hoc` default, `development`, `app-store-connect`). Ad-hoc
  IPAs install on the devices listed in the profile; `app-store-connect` IPAs upload to TestFlight.

On a Mac: `npm run cap:sync && npx cap open ios`, then run from Xcode.

## After changing the web app

`npm run cap:sync` copies a fresh build into both projects (the copies are gitignored). Icons and
splash screens come from `public/icons/optic.svg`: `npm run native:assets`.

## Not yet verified

- Built and checked on Windows for Android; not yet run on a physical Android device here.
- The iOS build runs only in CI (no Mac here). WebKit should honour COOP / COEP on the `capacitor://`
  scheme (iOS 15.2+), but this has not been confirmed on a device: check Settings → Graphics.
