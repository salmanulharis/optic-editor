/**
 * Originals that this browser cannot keep: no OPFS (private windows, some engines) and no file
 * handle to reference (files picked or dropped). They stay usable for the rest of the session;
 * their edits are saved in the catalog as usual. Nothing here survives a reload.
 */
const files = new Map<string, File>();

export function rememberSessionFile(photoId: string, file: File) {
  files.set(photoId, file);
}

export function sessionFile(photoId: string): File | undefined {
  return files.get(photoId);
}

/** True when imports in this browser can't be stored or referenced (they live for the session). */
export function sessionOnlyImports(canReference: boolean, opfs: boolean): boolean {
  return !opfs && !canReference;
}
