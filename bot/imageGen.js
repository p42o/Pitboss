// imageGen.js — Generates announcement images via OpenAI images.edit using the
// Shadow Spade Lounge brand logo as a reference image.
//
// Exports:
//   generateAnnouncementImage(openaiKey, logoUrl, prompt) -> Buffer (PNG)

const OpenAI = require('openai');

/**
 * @param {string} openaiKey  The OpenAI API key (sk-...).
 * @param {string} logoUrl    A public URL to the brand logo PNG.
 * @param {string} prompt     The image-generation prompt.
 * @returns {Promise<Buffer>} The generated image as a PNG buffer.
 */
async function generateAnnouncementImage(openaiKey, logoUrl, prompt) {
  if (!openaiKey) throw new Error('Missing OpenAI key');
  if (!prompt) throw new Error('Missing image prompt');

  const client = new OpenAI({ apiKey: openaiKey });

  // Fetch the logo into a Buffer
  let logoBuffer = null;
  if (logoUrl) {
    try {
      const res = await fetch(logoUrl);
      if (!res.ok) throw new Error(`Logo fetch failed HTTP ${res.status}`);
      const arr = await res.arrayBuffer();
      logoBuffer = Buffer.from(arr);
    } catch (e) {
      console.warn('[imageGen] Could not fetch logo, falling back to plain generate:', e.message);
      logoBuffer = null;
    }
  }

  // If we have a logo, use images.edit; otherwise fall back to images.generate.
  if (logoBuffer) {
    // OpenAI SDK accepts a File-like object. In Node 18+ we have the global File.
    const file = await OpenAI.toFile(logoBuffer, 'logo.png', { type: 'image/png' });
    const result = await client.images.edit({
      model: 'gpt-image-1',
      image: file,
      prompt,
      size: '1024x1024'
    });
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI returned no image data');
    return Buffer.from(b64, 'base64');
  } else {
    const result = await client.images.generate({
      model: 'gpt-image-1',
      prompt,
      size: '1024x1024'
    });
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI returned no image data');
    return Buffer.from(b64, 'base64');
  }
}

module.exports = { generateAnnouncementImage };
