// A photographed bill, challan or slip, carried inline as a data URI (v2) — and,
// by the same rules, a photo of the work on a progress update.
//
// There is still no object store (see the understanding doc, constraint 4), so
// the image is stored as binary in its own `Attachment` collection — never inside
// the payment document, so listing payments never ships pictures. The device
// shrinks the photo to a readable ~1600px JPEG of roughly 150-400 KB before it is
// sent; the cap here leaves headroom for a phone that compresses badly while
// keeping the whole request inside the 1 MB JSON body limit.
//
// The client's compression is the courtesy; this is the control.

const BILL_MAX_BYTES = 600 * 1024;

const DATA_URI = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

// The declared type has to match what the bytes actually are. A data URI that
// says jpeg is only a claim; SVG and HTML are excluded entirely because both can
// carry script, and this file is served back to browsers by the web console.
const MAGIC = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
};

/**
 * Decodes and checks a photo sent as a data URI.
 * @param label  how the messages name it, e.g. "The bill photo"
 * @returns {{ contentType: string, buffer: Buffer } | { error: string }}
 */
function decodeImage(value, label) {
  if (typeof value !== 'string') return { error: `${label} could not be read` };
  // Rough pre-check before running a regex over a huge string.
  if (value.length > Math.ceil((BILL_MAX_BYTES * 4) / 3) + 40) {
    return { error: `${label} is too large. Please retake it.` };
  }
  const match = DATA_URI.exec(value);
  if (!match) return { error: `${label} must be a JPEG, PNG or WebP image` };

  const contentType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) return { error: `${label} is empty` };
  if (buffer.length > BILL_MAX_BYTES) return { error: `${label} is too large. Please retake it.` };
  if (!MAGIC[contentType](buffer)) return { error: `${label} is not a valid image` };

  return { contentType, buffer };
}

/** A bill image, with the messages the payment form has always shown. */
const decodeBillImage = (value) => decodeImage(value, 'The bill photo');

module.exports = { decodeImage, decodeBillImage, BILL_MAX_BYTES };
