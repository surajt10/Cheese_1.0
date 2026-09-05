// Screen capture + change-detection helpers (main process only).
const { desktopCapturer, screen } = require('electron');

const MAX_LONG_SIDE = 1600; // px sent to the model — plenty for reading text, keeps tokens sane

/** Grab the chosen display (falls back to primary). Returns a nativeImage at native resolution. */
async function captureDisplay(displayId) {
  const displays = screen.getAllDisplays();
  const display = displays.find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
  const thumbnailSize = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  if (!sources.length) throw new Error('No screens available. Grant Screen Recording permission in System Settings → Privacy & Security.');
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (src.thumbnail.isEmpty()) throw new Error('Screen capture returned an empty image. Check Screen Recording permission.');
  return src.thumbnail;
}

/** Downscale + JPEG encode. Returns base64 (no data: prefix). */
function toJpegBase64(img, quality = 85) {
  const { width, height } = img.getSize();
  let out = img;
  const longSide = Math.max(width, height);
  if (longSide > MAX_LONG_SIDE) {
    const scale = MAX_LONG_SIDE / longSide;
    out = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
  }
  return out.toJPEG(quality).toString('base64');
}

/** Cheap perceptual fingerprint: 32x32 grayscale bytes. */
function fingerprint(img) {
  const small = img.resize({ width: 32, height: 32, quality: 'good' });
  const bmp = small.toBitmap(); // BGRA
  const gray = new Uint8Array(32 * 32);
  for (let i = 0, j = 0; i < bmp.length; i += 4, j++) {
    gray[j] = (bmp[i] * 0.114 + bmp[i + 1] * 0.587 + bmp[i + 2] * 0.299) | 0;
  }
  return gray;
}

/** Mean absolute pixel difference between two fingerprints (0..255). */
function fingerprintDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

module.exports = { captureDisplay, toJpegBase64, fingerprint, fingerprintDiff };
