// api/_lib/validation.js
// Runtime validation helpers shared by the API routes.

/**
 * Validate that a base64 data URI has magic bytes matching the declared MIME type.
 * Supports PDF, PNG, JPEG, WEBP.
 * @param {string} dataUri - Data URI string, e.g. "data:image/png;base64,..."
 * @param {string[]} [allowedMimes] - Allowed MIME types.
 * @returns {{ ok: boolean, mime?: string, error?: string }}
 */
export function validateFileSignature(dataUri, allowedMimes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp']) {
  if (!dataUri || typeof dataUri !== 'string') {
    return { ok: false, error: 'No file data provided.' };
  }
  const match = dataUri.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    return { ok: false, error: 'Invalid data URI format. Expected base64 encoding.' };
  }
  let mime = match[1].toLowerCase();
  if (mime === 'image/jpg') mime = 'image/jpeg';
  const base64Content = match[2];

  if (allowedMimes && allowedMimes.length) {
    const normAllowed = allowedMimes.map((m) => (m.toLowerCase() === 'image/jpg' ? 'image/jpeg' : m.toLowerCase()));
    if (!normAllowed.includes(mime)) {
      return { ok: false, error: `File type "${mime}" is not permitted.` };
    }
  }

  // Decode first 32 bytes
  let headerBuf;
  try {
    const rawHeader = base64Content.slice(0, 64);
    headerBuf = Buffer.from(rawHeader, 'base64');
  } catch {
    return { ok: false, error: 'Failed to decode base64 file data.' };
  }

  if (headerBuf.length < 4) {
    return { ok: false, error: 'File content is too small or truncated.' };
  }

  // Check magic bytes
  // PDF: %PDF- (0x25 0x50 0x44 0x46)
  const isPdf = headerBuf.length >= 4 &&
    headerBuf[0] === 0x25 && headerBuf[1] === 0x50 && headerBuf[2] === 0x44 && headerBuf[3] === 0x46;

  // PNG: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
  const isPng = headerBuf.length >= 8 &&
    headerBuf[0] === 0x89 && headerBuf[1] === 0x50 && headerBuf[2] === 0x4E && headerBuf[3] === 0x47 &&
    headerBuf[4] === 0x0D && headerBuf[5] === 0x0A && headerBuf[6] === 0x1A && headerBuf[7] === 0x0A;

  // JPEG: 0xFF 0xD8 0xFF
  const isJpg = headerBuf.length >= 3 &&
    headerBuf[0] === 0xFF && headerBuf[1] === 0xD8 && headerBuf[2] === 0xFF;

  // WEBP: RIFF at 0..3 and WEBP at 8..11
  const isWebp = headerBuf.length >= 12 &&
    headerBuf[0] === 0x52 && headerBuf[1] === 0x49 && headerBuf[2] === 0x46 && headerBuf[3] === 0x46 && // RIFF
    headerBuf[8] === 0x57 && headerBuf[9] === 0x45 && headerBuf[10] === 0x42 && headerBuf[11] === 0x50; // WEBP

  if (mime === 'application/pdf' && !isPdf) {
    return { ok: false, error: 'File signature does not match claimed PDF document.' };
  }
  if (mime === 'image/png' && !isPng) {
    return { ok: false, error: 'File signature does not match claimed PNG image.' };
  }
  if (mime === 'image/jpeg' && !isJpg) {
    return { ok: false, error: 'File signature does not match claimed JPEG image.' };
  }
  if (mime === 'image/webp' && !isWebp) {
    return { ok: false, error: 'File signature does not match claimed WEBP image.' };
  }

  if (!isPdf && !isPng && !isJpg && !isWebp) {
    return { ok: false, error: 'Unrecognized file signature. Only valid PDF, PNG, JPG, or WEBP files are allowed.' };
  }

  // A file cut short (an interrupted upload, a partial copy) still has the
  // right first bytes, so check that it also ends the way its format must.
  if (!endsComplete(Buffer.from(base64Content, 'base64'), mime)) {
    return { ok: false, error: 'The file looks incomplete; it may not have finished uploading. Please choose it again.' };
  }

  return { ok: true, mime };
}

/**
 * True when the decoded file ends the way its format requires. The browser
 * re-encodes images before upload, so their end markers are exact; PDFs are
 * sent as chosen, so they get the window the PDF spec allows for trailing
 * bytes after %%EOF.
 */
function endsComplete(buf, mime) {
  const tail = (n) => buf.subarray(Math.max(0, buf.length - n));
  if (mime === 'image/png') {
    // The IEND chunk: type 'IEND' followed by its 4-byte CRC.
    return buf.length >= 12 && buf.subarray(buf.length - 8, buf.length - 4).toString('latin1') === 'IEND';
  }
  if (mime === 'image/jpeg') {
    // The end-of-image marker FF D9, allowing a little padding after it.
    const t = tail(32);
    for (let i = t.length - 2; i >= 0; i--) if (t[i] === 0xFF && t[i + 1] === 0xD9) return true;
    return false;
  }
  if (mime === 'image/webp') {
    // The RIFF header records the total size; a cut-short file is smaller.
    return buf.length >= 12 && buf.length >= buf.readUInt32LE(4) + 8;
  }
  if (mime === 'application/pdf') {
    return tail(2048).toString('latin1').includes('%%EOF');
  }
  return true;
}
