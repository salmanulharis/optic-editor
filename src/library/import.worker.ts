/**
 * Per-file import work off the main thread: duplicate hash, metadata and the quick preview
 * (embedded camera JPEG or browser decode, scaled and encoded on an OffscreenCanvas).
 */
import * as Comlink from 'comlink';
import { fileFacts, fileHash, quickPreview } from './fileInfo';

const api = {
  hash: (f: File) => fileHash(f),
  async analyse(f: File, withPreview: boolean) {
    const facts = await fileFacts(f);
    const preview = withPreview ? await quickPreview(f, facts) : null;
    // ExifBlocks stay here (the importer only needs the summary fields).
    const { exif: _exif, ...rest } = facts;
    return { facts: rest, preview };
  },
};

export type ImportWorkerApi = typeof api;
Comlink.expose(api);
