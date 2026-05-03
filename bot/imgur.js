// imgur.js — Anonymous Imgur image upload.
//
// Exports:
//   uploadToImgur(clientId, pngBuffer) -> string  (direct https://i.imgur.com/... URL)

/**
 * @param {string} clientId   Your Imgur application Client-ID.
 * @param {Buffer} pngBuffer  PNG data to upload.
 * @returns {Promise<string>} The direct image URL (data.link).
 */
async function uploadToImgur(clientId, pngBuffer) {
  if (!clientId) throw new Error('Missing Imgur Client-ID');
  if (!pngBuffer || !Buffer.isBuffer(pngBuffer)) throw new Error('Missing PNG buffer');

  const b64 = pngBuffer.toString('base64');
  const res = await fetch('https://api.imgur.com/3/image', {
    method: 'POST',
    headers: {
      'Authorization': `Client-ID ${clientId}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ image: b64, type: 'base64' }).toString()
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    const msg = data?.data?.error || `Imgur HTTP ${res.status}`;
    throw new Error(`Imgur upload failed: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  if (!data.data?.link) throw new Error('Imgur response missing data.link');
  return data.data.link;
}

module.exports = { uploadToImgur };
