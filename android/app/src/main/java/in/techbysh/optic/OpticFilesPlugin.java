package in.techbysh.optic;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Files in and out of the app.
 *  - saveToDevice: copies an exported file from the app cache into the shared gallery
 *    (Pictures/Optic) or, for archives and other files, into Download/Optic (MediaStore, no
 *    storage permission needed on Android 10+).
 *  - takeIncoming / "incoming" event: photos shared to Optic (ACTION_SEND / SEND_MULTIPLE) or
 *    opened with it (ACTION_VIEW), copied into the cache so the page can import them.
 */
@CapacitorPlugin(name = "OpticFiles")
public class OpticFilesPlugin extends Plugin {

    private final List<JSObject> pending = new ArrayList<>();

    @Override
    public void load() {
        cleanIncoming();
        Intent intent = getActivity().getIntent();
        if (intent != null) receive(intent, false);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        receive(intent, true);
    }

    // ------------------------------------------------------------------ incoming

    private void receive(Intent intent, boolean notify) {
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null && "content".equals(intent.getData().getScheme())) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null && "file".equals(intent.getData().getScheme())) {
            uris.add(intent.getData());
        }
        if (uris.isEmpty()) return;
        // Consume the intent so a configuration change does not import the same files again.
        intent.setAction(Intent.ACTION_MAIN);
        new Thread(() -> {
            List<JSObject> files = new ArrayList<>();
            for (Uri u : uris) {
                try {
                    files.add(copyIn(u));
                } catch (Exception e) {
                    android.util.Log.w("Optic", "could not read shared file " + u, e);
                }
            }
            if (files.isEmpty()) return;
            synchronized (pending) {
                pending.addAll(files);
            }
            if (notify) notifyListeners("incoming", new JSObject(), true);
        }).start();
    }

    private JSObject copyIn(Uri uri) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {}
        }
        if (name == null) name = uri.getLastPathSegment() != null ? new File(uri.getLastPathSegment()).getName() : "shared.jpg";
        name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        File dir = new File(getContext().getCacheDir(), "incoming/" + System.nanoTime());
        if (!dir.mkdirs() && !dir.isDirectory()) throw new IllegalStateException("cache not writable");
        File out = new File(dir, name);
        try (InputStream in = cr.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
            if (in == null) throw new IllegalStateException("no stream");
            copy(in, os);
        }
        JSObject f = new JSObject();
        f.put("path", Uri.fromFile(out).toString());
        f.put("name", name);
        String type = cr.getType(uri);
        if (type != null) f.put("mime", type);
        return f;
    }

    @PluginMethod
    public void takeIncoming(PluginCall call) {
        JSArray arr = new JSArray();
        synchronized (pending) {
            for (JSObject f : pending) arr.put(f);
            pending.clear();
        }
        JSObject ret = new JSObject();
        ret.put("files", arr);
        call.resolve(ret);
    }

    private void cleanIncoming() {
        File root = new File(getContext().getCacheDir(), "incoming");
        File[] dirs = root.listFiles();
        if (dirs == null) return;
        long old = System.currentTimeMillis() - 24L * 3600 * 1000;
        for (File d : dirs) {
            if (d.lastModified() >= old) continue;
            File[] fs = d.listFiles();
            if (fs != null) for (File f : fs) //noinspection ResultOfMethodCallIgnored
                f.delete();
            //noinspection ResultOfMethodCallIgnored
            d.delete();
        }
    }

    // ------------------------------------------------------------------ outgoing

    @PluginMethod
    public void saveToDevice(PluginCall call) {
        String path = call.getString("path");
        String name = call.getString("name", "optic-export");
        String mime = call.getString("mime", "application/octet-stream");
        if (path == null) {
            call.reject("path is required");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Android 7–9 would need the storage permission: the page falls back to the share sheet.
            call.reject("MediaStore saving needs Android 10");
            return;
        }
        new Thread(() -> {
            File src = new File(Uri.parse(path).getPath());
            try {
                String location = null;
                if (mime.startsWith("image/")) {
                    try {
                        location = insert(src, name, mime, MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), Environment.DIRECTORY_PICTURES + "/Optic");
                    } catch (Exception e) {
                        // The gallery rejects some types (e.g. JPEG XL on older devices): Downloads takes anything.
                        location = null;
                    }
                }
                if (location == null) {
                    location = insert(src, name, mime, MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), Environment.DIRECTORY_DOWNLOADS + "/Optic");
                }
                //noinspection ResultOfMethodCallIgnored
                src.delete();
                JSObject ret = new JSObject();
                ret.put("location", location);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "save failed", e);
            }
        }).start();
    }

    private String insert(File src, String name, String mime, Uri collection, String relativePath) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri item = cr.insert(collection, v);
        if (item == null) throw new IllegalStateException("MediaStore insert failed");
        try (InputStream in = new FileInputStream(src); OutputStream os = cr.openOutputStream(item)) {
            if (os == null) throw new IllegalStateException("no output stream");
            copy(in, os);
        } catch (Exception e) {
            cr.delete(item, null, null);
            throw e;
        }
        v.clear();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(item, v, null, null);
        return relativePath;
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }
}
