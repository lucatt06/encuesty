/* Compresión de archivos subidos: deja cada archivo en LIMIT bytes o menos, con la mejor calidad posible
   (busca el ajuste más alto que quepa, así queda lo más cerca posible del tope).
   - Imágenes (jpg, png, webp, avif, tiff): se reconvierten a JPEG (mozjpeg) buscando la mayor calidad que quepa; si ni así, se reduce el tamaño.
   - PDF: Ghostscript (si está instalado) buscando la mayor resolución de imágenes que quepa.
   - Video: ffmpeg (si está instalado) con la tasa de bits calculada para el tope.
   - Otros tipos: no se pueden comprimir; se dejan como están.
   Si algo falla o no hay herramienta, el archivo original se conserva (nunca se pierde). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const LIMIT = Number(process.env.COMPRESS_LIMIT_BYTES || 5 * 1024 * 1024);
const run = (cmd, args, timeout = 240000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr })));
});
const have = {}; // cache: ¿existe el programa?
async function hasBin(bin) {
  if (bin in have) return have[bin];
  try { await run(bin, bin === 'gs' ? ['-v'] : ['-version'], 8000); have[bin] = true; } catch { have[bin] = false; }
  return have[bin];
}
const size = (p) => fs.statSync(p).size;
const baseName = (n) => String(n || 'archivo').replace(/\.[^./\\]+$/, '');
const extOf = (n) => (String(n || '').split('.').pop() || '').toLowerCase();

function kindOf(mime, filename) {
  const m = String(mime || '').toLowerCase(), e = extOf(filename);
  if (/^image\/(jpe?g|png|webp|avif|tiff?)$/.test(m) || ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff'].includes(e)) return 'image';
  if (m === 'application/pdf' || e === 'pdf') return 'pdf';
  if (/^video\//.test(m) || ['mp4', 'mov', '3gp', 'm4v', 'avi', 'mkv', 'webm'].includes(e)) return 'video';
  return 'other';
}

/* ---------- imágenes ---------- */
async function compressImage(inPath, outPath, limit) {
  const sharp = require('sharp');
  const base = () => sharp(inPath, { failOn: 'none', limitInputPixels: false }).rotate().flatten({ background: '#ffffff' });
  const meta = await sharp(inPath, { failOn: 'none', limitInputPixels: false }).metadata();
  const encode = async (scale, q) => {
    let img = base();
    if (scale < 1 && meta.width) img = img.resize({ width: Math.max(64, Math.round(meta.width * scale)), withoutEnlargement: true });
    return img.jpeg({ quality: q, mozjpeg: true, chromaSubsampling: q >= 90 ? '4:4:4' : '4:2:0' }).toBuffer();
  };
  // 1) tamaño completo: la mayor calidad (1-100) que quepa. Búsqueda en 4 candidatos a la vez (aprovecha varios núcleos).
  let best = null, lo = 30, hi = 100; // lo..hi: rango aún posible
  const bottom = await encode(1, lo);
  if (bottom.length <= limit) {
    best = bottom; lo += 1;
    while (lo <= hi) {
      const step = Math.max(1, Math.ceil((hi - lo + 1) / 5));
      const qs = []; for (let q = lo + step - 1; q <= hi && qs.length < 4; q += step) qs.push(q);
      if (!qs.length) qs.push(hi);
      const res = await Promise.all(qs.map(async (q) => ({ q, b: await encode(1, q) })));
      let fit = null, firstBad = null; for (const r of res) { if (r.b.length <= limit) fit = r; else if (!firstBad) firstBad = r; }
      if (fit) best = fit.b;
      lo = fit ? fit.q + 1 : lo; hi = firstBad ? firstBad.q - 1 : hi;
      if (fit && !firstBad) lo = Math.max(lo, qs[qs.length - 1] + 1);
    }
  }
  // 2) si ni con calidad mínima cabe: reducir dimensiones (calidad alta fija) buscando la mayor escala que quepa
  if (!best) {
    let sLo = 0.1, sHi = 1; const Q = 82;
    while (sHi - sLo > 0.02) { const mid = (sLo + sHi) / 2; const b = await encode(mid, Q); if (b.length <= limit) { best = b; sLo = mid; } else sHi = mid; }
    if (!best) best = await encode(0.1, Q);
    // con esa escala, subir calidad mientras quepa
    const sc = sLo; let ql = Q + 1, qh = 100;
    while (ql <= qh) { const mid = (ql + qh) >> 1; const b = await encode(sc, mid); if (b.length <= limit) { best = b; ql = mid + 1; } else qh = mid - 1; }
  }
  fs.writeFileSync(outPath, best);
  return { mime: 'image/jpeg', ext: 'jpg' };
}

/* ---------- PDF (Ghostscript) ---------- */
async function compressPdf(inPath, outPath, limit, tmp) {
  if (!(await hasBin('gs'))) throw new Error('Ghostscript no está instalado');
  const attempt = async (dpi, q) => {
    const out = path.join(tmp, `gs-${dpi}-${q}.pdf`);
    await run('gs', ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', '-dNOPAUSE', '-dBATCH', '-dQUIET', '-dSAFER', '-dDetectDuplicateImages=true',
      '-dDownsampleColorImages=true', '-dColorImageDownsampleType=/Bicubic', `-dColorImageResolution=${dpi}`,
      '-dDownsampleGrayImages=true', '-dGrayImageDownsampleType=/Bicubic', `-dGrayImageResolution=${dpi}`,
      '-dDownsampleMonoImages=true', `-dMonoImageResolution=${Math.max(dpi, 150)}`,
      '-dAutoFilterColorImages=false', '-dColorImageFilter=/DCTEncode', '-dAutoFilterGrayImages=false', '-dGrayImageFilter=/DCTEncode',
      `-dJPEGQ=${q}`, `-sOutputFile=${out}`, inPath], 300000);
    return { out, bytes: size(out) };
  };
  // buscar la mayor resolución que quepa (calidad JPEG 85); si ni a 40 dpi cabe, bajar la calidad
  const dpis = [300, 240, 200, 170, 150, 130, 110, 96, 80, 66, 50, 40];
  let best = null, lo = 0, hi = dpis.length - 1; // dpis descendente: más índice = más pequeño
  while (lo <= hi) { const mid = (lo + hi) >> 1; const r = await attempt(dpis[mid], 85); if (r.bytes <= limit) { best = r; hi = mid - 1; } else lo = mid + 1; }
  if (!best) { for (const q of [70, 55, 40, 30]) { const r = await attempt(40, q); if (!best || r.bytes < best.bytes) best = r; if (r.bytes <= limit) { best = r; break; } } }
  if (!best || best.bytes >= size(inPath)) throw new Error('no se logró reducir el PDF');
  fs.copyFileSync(best.out, outPath);
  return { mime: 'application/pdf', ext: 'pdf' };
}

/* ---------- video (ffmpeg) ---------- */
async function compressVideo(inPath, outPath, limit) {
  if (!(await hasBin('ffmpeg')) || !(await hasBin('ffprobe'))) throw new Error('ffmpeg no está instalado');
  const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', inPath], 30000);
  const dur = parseFloat(probe.stdout); if (!(dur > 0)) throw new Error('no pude leer la duración del video');
  const audio = 64000;
  let factor = 0.93, best = null;
  for (let i = 0; i < 4; i++) {
    const total = (limit * 8 * factor) / dur; const vbr = Math.max(60000, Math.floor(total - audio));
    const scale = vbr < 250000 ? 'scale=-2:min(ih\\,360)' : vbr < 700000 ? 'scale=-2:min(ih\\,540)' : vbr < 1500000 ? 'scale=-2:min(ih\\,720)' : 'scale=-2:min(ih\\,1080)';
    const out = outPath + `.try${i}.mp4`;
    await run('ffmpeg', ['-y', '-i', inPath, '-vf', scale, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', String(vbr), '-maxrate', String(Math.floor(vbr * 1.2)), '-bufsize', String(vbr * 2),
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', String(audio), '-movflags', '+faststart', out], 600000);
    const b = size(out);
    if (b <= limit) { best = out; break; }
    best = out; factor *= (limit / b) * 0.96;
  }
  if (!best || size(best) > limit * 1.02) { /* mejor esfuerzo */ }
  fs.copyFileSync(best, outPath);
  return { mime: 'video/mp4', ext: 'mp4' };
}

/* Punto de entrada. inPath: archivo en disco. Devuelve null si no hace falta / no se puede; si no, { path, mime, filename, from, to, ok } */
async function compressFile(inPath, mime, filename, limit = LIMIT) {
  const from = size(inPath); if (from <= limit) return null;
  const kind = kindOf(mime, filename); if (kind === 'other') return { skipped: 'tipo', from };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
  const outPath = path.join(tmp, 'out.bin');
  try {
    const r = kind === 'image' ? await compressImage(inPath, outPath, limit) : kind === 'pdf' ? await compressPdf(inPath, outPath, limit, tmp) : await compressVideo(inPath, outPath, limit);
    const to = size(outPath);
    if (to >= from) return { skipped: 'no-reduce', from };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmpo-')); const final = path.join(dir, 'out.' + r.ext); fs.renameSync(outPath, final);
    return { path: final, dir, mime: r.mime, filename: `${baseName(filename)}.${r.ext}`, from, to, ok: to <= limit };
  } catch (e) {
    console.error('[comprimir]', kind, e.message);
    return { skipped: 'error', error: e.message, from };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
module.exports = { compressFile, kindOf, LIMIT };
