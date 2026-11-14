/**
 * Long edges of the library's stored previews (OPFS `previews/<id>/{preview,thumb}`). Kept in a
 * module of their own so the main thread can use them without loading the import worker's code
 * (fileInfo.ts pulls in exifr).
 */
export const PREVIEW_EDGE = 2560;
export const THUMB_EDGE = 512;
