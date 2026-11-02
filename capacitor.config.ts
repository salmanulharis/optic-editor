import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native Android app (APK). It loads the Vite build (dist/) from the app bundle. Android WebView
 * never runs a page cross-origin isolated, so the decoders run single-threaded there (same
 * results as the web app, slower on very large files).
 * Build: `npm run android:apk` (see docs/MOBILE.md).
 */
const config: CapacitorConfig = {
  appId: 'in.techbysh.optic',
  appName: 'Optic',
  webDir: 'dist',
  backgroundColor: '#1c1c1c',
  loggingBehavior: 'debug',
  server: {
    // https://localhost: a secure context (OPFS, crypto).
    androidScheme: 'https',
    // Debugging only: OPTIC_DEV_URL=http://localhost:5173 loads the Vite dev server (adb reverse).
    ...(process.env.OPTIC_DEV_URL ? { url: process.env.OPTIC_DEV_URL, cleartext: true } : {}),
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    // OPTIC_DEBUG=1 npm run android:apk → inspectable with chrome://inspect (off in releases).
    webContentsDebuggingEnabled: process.env.OPTIC_DEBUG === '1',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 3000,
      launchAutoHide: true,
      backgroundColor: '#1c1c1c',
      showSpinner: false,
      androidScaleType: 'CENTER_INSIDE',
      splashFullScreen: false,
      splashImmersive: false,
    },
    SystemBars: {
      insetsHandling: 'native',
      style: 'DARK',
    },
  },
};

export default config;
