const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('encuesty:' + ADMIN_PASSWORD).digest('hex');
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 50); // solo aplica sin bucket S3 (desarrollo local)
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
/* ---------- almacenamiento de archivos ----------
   Con bucket S3 (Railway): los archivos se transmiten directo al bucket, sin límite de tamaño.
   Sin bucket (desarrollo local): se guardan en la base de datos con un límite. */
const S3_ON = !!(process.env.S3_BUCKET && process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
let s3, S3 = {};
if (S3_ON) {
  S3 = { ...require('@aws-sdk/client-s3'), ...require('@aws-sdk/lib-storage'), ...require('@aws-sdk/s3-request-presigner') };
  s3 = new S3.S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
const s3Storage = {
  _handleFile(req, file, cb) {
    const key = `r${req.resp.id}/${crypto.randomUUID()}`;
    let size = 0; file.stream.on('data', (c) => { size += c.length; });
    new S3.Upload({ client: s3, queueSize: 4, partSize: 16 * 1024 * 1024,
      params: { Bucket: process.env.S3_BUCKET, Key: key, Body: file.stream, ContentType: file.mimetype } })
      .done().then(() => cb(null, { key, size })).catch(cb);
  },
  _removeFile(req, file, cb) { s3Delete([file.key]).then(() => cb(null), cb); },
};
async function s3Delete(keys) {
  if (!S3_ON) return;
  for (const Key of keys.filter(Boolean)) {
    try { await s3.send(new S3.DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key })); } catch (e) { console.error('[S3 borrar]', Key, e.message); }
  }
}
const keysOf = async (where, arg) => (await pool.query(`SELECT s3_key FROM files WHERE s3_key IS NOT NULL AND ${where}`, [arg])).rows.map((r) => r.s3_key);
const upload = S3_ON ? multer({ storage: s3Storage }) : multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });

/* ---------- utilidades ---------- */
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const makeToken = (payload) => { const b = Buffer.from(JSON.stringify(payload)).toString('base64url'); return b + '.' + sign(b); };
const readToken = (t) => {
  if (!t || !t.includes('.')) return null;
  const [b, s] = t.split('.');
  const good = sign(b);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try { return JSON.parse(Buffer.from(b, 'base64url').toString()); } catch { return null; }
};
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const setCookie = (res, name, val, maxAgeDays) =>
  res.append('Set-Cookie', `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeDays * 86400}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'cuestionario';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const baseUrl = (req) => APP_URL || `${req.protocol}://${req.get('host')}`;

function fmtProjects(arr, sep, off = 0) {
  if (!Array.isArray(arr)) return '';
  return arr.filter((p) => p && (p.name || p.location)).map((p, i) => {
    const units = (p.units || []).filter((u) => u.type || u.price || u.size).map((u) => `${u.type || '?'} / ${u.price || '?'} / ${u.size || '?'}`).join('; ');
    const am = [...(p.amenities || []), p.amenities_other].filter(Boolean).join(', ');
    return [`Proyecto ${i + 1 + off}: ${p.name || '(sin nombre)'}`, `Ubicación: ${p.location || ''}`, `Tipo: ${p.type || ''}`, `Unidades: ${units}`, `Entrega: ${p.delivery || ''}`, `Plan de pago: ${p.payment || ''}`, `Amenidades: ${am}`, `Enlaces: ${(p.links || []).join(', ')}`].join(sep.in);
  }).join(sep.out);
}
const attempts = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); attempts.set(key, arr);
  return arr.length > max;
}

/* ---------- correo (GoHighLevel) ---------- */
const GHL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const ghlHeaders = () => ({ Authorization: `Bearer ${process.env.GHL_API_TOKEN}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' });
// Busca el contacto por correo en la subcuenta; si no existe lo crea (GHL solo envía correos a contactos).
async function ghlContactId(email, name) {
  const r = await fetch(`${GHL}/contacts/upsert`, {
    method: 'POST', headers: ghlHeaders(),
    body: JSON.stringify({ locationId: process.env.GHL_LOCATION_ID, email, ...(name ? { name } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`contacto ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return (j.contact && j.contact.id) || j.id;
}
async function sendMail({ to, name, subject, html }) {
  if (!process.env.GHL_API_TOKEN || !process.env.GHL_LOCATION_ID) { console.log('[mail omitido: falta GHL_API_TOKEN/GHL_LOCATION_ID]', to, subject); return false; }
  try {
    const contactId = await ghlContactId(to, name);
    const body = { type: 'Email', contactId, subject, html };
    if (process.env.GHL_EMAIL_FROM) body.emailFrom = process.env.GHL_EMAIL_FROM;
    const r = await fetch(`${GHL}/conversations/messages`, { method: 'POST', headers: ghlHeaders(), body: JSON.stringify(body) });
    if (!r.ok) { console.error('[GHL mensaje error]', r.status, (await r.text()).slice(0, 300)); return false; }
    return true;
  } catch (e) { console.error('[GHL error]', e.message); return false; }
}

/* ---------- base de datos ---------- */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS surveys (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      schema JSONB NOT NULL DEFAULT '{"items":[]}',
      thanks_message TEXT NOT NULL DEFAULT '¡Gracias! Recibimos tus respuestas.',
      published BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS responses (
      id SERIAL PRIMARY KEY,
      survey_id INT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
      client_id INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      answers JSONB NOT NULL DEFAULT '{}',
      step INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'in_progress',
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      UNIQUE (survey_id, client_id)
    );
    CREATE TABLE IF NOT EXISTS files (
      id SERIAL PRIMARY KEY,
      response_id INT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INT NOT NULL,
      data BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE files ADD COLUMN IF NOT EXISTS s3_key TEXT;
    ALTER TABLE responses ADD COLUMN IF NOT EXISTS share_token TEXT;
    ALTER TABLE responses ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS responses_share_token_idx ON responses (share_token) WHERE share_token IS NOT NULL;
    ALTER TABLE files ALTER COLUMN data DROP NOT NULL;
    ALTER TABLE files ALTER COLUMN size TYPE BIGINT;
  `);
  // sembrar el cuestionario inicial (Ventas Automatizadas) si no hay ninguno
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM surveys');
  if (rows[0].n === 0) {
    const seedPath = path.join(__dirname, 'seed-ventas.json');
    if (fs.existsSync(seedPath)) {
      const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      await pool.query('INSERT INTO surveys (slug,title,schema,thanks_message) VALUES ($1,$2,$3,$4)', [
        'ventas-automatizadas', seed.title, { items: withIds(seed.items) }, '¡Listo, gracias! Recibimos tus respuestas y nos pondremos en contacto contigo.',
      ]);
      console.log('Cuestionario inicial creado: /s/ventas-automatizadas');
    }
  }
}
function withIds(items) {
  let n = 0;
  return items.map((it) => (it.kind === 'question' && !it.id ? { ...it, id: 'q' + ++n + '_' + crypto.randomBytes(2).toString('hex') } : it));
}

/* ---------- API pública (cliente) ---------- */
async function getSurveyBySlug(slug) {
  const { rows } = await pool.query('SELECT * FROM surveys WHERE slug=$1', [slug]);
  return rows[0];
}
const publicSurvey = (s) => ({ title: s.title, slug: s.slug, schema: s.schema, thanks: s.thanks_message });

app.get('/api/s/:slug', async (req, res) => {
  const s = await getSurveyBySlug(req.params.slug);
  if (!s || !s.published) return res.status(404).json({ error: 'Este cuestionario no existe o no está disponible.' });
  res.json({ title: s.title, thanks: s.thanks_message });
});

// Entrar con correo (y nombre si es nuevo)
app.post('/api/s/:slug/start', async (req, res) => {
  try {
    if (rateLimit('start:' + req.ip, 30, 10 * 60 * 1000)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    const s = await getSurveyBySlug(req.params.slug);
    if (!s || !s.published) return res.status(404).json({ error: 'Este cuestionario no existe o no está disponible.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim();
    if (!validEmail(email)) return res.status(400).json({ error: 'Escribe un correo válido.' });

    let { rows } = await pool.query('SELECT * FROM clients WHERE email=$1', [email]);
    let client = rows[0];
    if (!client) {
      if (!name) return res.json({ needName: true });
      client = (await pool.query('INSERT INTO clients (email,name) VALUES ($1,$2) RETURNING *', [email, name.slice(0, 120)])).rows[0];
    }
    const r = (await pool.query(
      `INSERT INTO responses (survey_id, client_id) VALUES ($1,$2)
       ON CONFLICT (survey_id, client_id) DO UPDATE SET survey_id=EXCLUDED.survey_id RETURNING *`,
      [s.id, client.id])).rows[0];
    setCookie(res, 'enc_' + s.id, makeToken({ r: r.id, s: s.id }), 90);
    res.json({ ok: true, name: client.name, ...(await responsePayload(s, r)) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error del servidor.' }); }
});

async function responsePayload(s, r) {
  const files = (await pool.query('SELECT id, question_id, filename, size FROM files WHERE response_id=$1 ORDER BY id', [r.id])).rows;
  return { survey: publicSurvey(s), answers: r.answers, step: r.step, status: r.status, files };
}

// Autenticación del cliente por cookie
async function clientAuth(req, res, next) {
  const s = await getSurveyBySlug(req.params.slug);
  if (!s) return res.status(404).json({ error: 'No existe.' });
  const t = readToken(cookies(req)['enc_' + s.id]);
  if (!t || t.s !== s.id) return res.status(401).json({ error: 'Sesión expirada', relogin: true });
  const r = (await pool.query('SELECT r.*, c.email, c.name FROM responses r JOIN clients c ON c.id=r.client_id WHERE r.id=$1', [t.r])).rows[0];
  if (!r) return res.status(401).json({ error: 'Sesión expirada', relogin: true });
  req.survey = s; req.resp = r; next();
}

app.get('/api/s/:slug/me', clientAuth, async (req, res) => {
  res.json({ ok: true, name: req.resp.name, ...(await responsePayload(req.survey, req.resp)) });
});

// Guardado automático
app.put('/api/s/:slug/answers', clientAuth, async (req, res) => {
  const answers = req.body.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
  const step = Number.isInteger(req.body.step) ? req.body.step : req.resp.step;
  // se mezcla con lo existente para que un guardado atrasado no borre respuestas
  await pool.query(
    `UPDATE responses SET answers = answers || $1::jsonb, step=$2, updated_at=now(),
     status = CASE WHEN status='completed' THEN 'completed' ELSE 'in_progress' END WHERE id=$3`,
    [JSON.stringify(answers), step, req.resp.id]);
  res.json({ ok: true, savedAt: new Date().toISOString() });
});

app.post('/api/s/:slug/upload/:qid', clientAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió el archivo.' });
  const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 200);
  const { rows } = await pool.query(
    'INSERT INTO files (response_id, question_id, filename, mime, size, data, s3_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, question_id, filename, size',
    [req.resp.id, req.params.qid, filename, req.file.mimetype, req.file.size, req.file.buffer || null, req.file.key || null]);
  await pool.query('UPDATE responses SET updated_at=now() WHERE id=$1', [req.resp.id]);
  res.json({ ok: true, file: rows[0] });
});
app.delete('/api/s/:slug/file/:id', clientAuth, async (req, res) => {
  const { rows } = await pool.query('DELETE FROM files WHERE id=$1 AND response_id=$2 RETURNING s3_key', [req.params.id, req.resp.id]);
  await s3Delete(rows.map((r) => r.s3_key));
  res.json({ ok: true });
});
app.use('/api/s/:slug/upload', (err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `El archivo supera el máximo de ${MAX_FILE_MB} MB.` });
  console.error('[subida]', err && err.message);
  res.status(500).json({ error: 'No se pudo subir el archivo. Inténtalo de nuevo.' });
});

app.post('/api/s/:slug/complete', clientAuth, async (req, res) => {
  await pool.query(
    `UPDATE responses SET status='completed', completed_at=COALESCE(completed_at, now()), updated_at=now()
     WHERE id=$1`, [req.resp.id]);
  const first = !req.resp.completed_at;
  if (first) {
    const s = req.survey, c = req.resp;
    const link = `${baseUrl(req)}/admin#/respuestas/${c.id}`;
    sendMail({ to: c.email, name: c.name, subject: `Recibimos tus respuestas — ${s.title}`,
      html: `<p>Hola ${esc(c.name)},</p><p>${esc(s.thanks_message)}</p><p>Si necesitas cambiar algo, vuelve a abrir el enlace del cuestionario con tu correo y podrás editar tus respuestas.</p>` });
    if (ADMIN_EMAIL) sendMail({ to: ADMIN_EMAIL, subject: `Nuevo cuestionario completado: ${c.name} — ${s.title}`,
      html: `<p><b>${esc(c.name)}</b> (${esc(c.email)}) completó <b>${esc(s.title)}</b>.</p><p><a href="${link}">Ver respuestas</a></p>` });
  }
  res.json({ ok: true });
});

/* ---------- Admin ---------- */
function adminAuth(req, res, next) {
  const t = readToken(cookies(req).enc_admin);
  if (t && t.admin && t.exp > Date.now()) return next();
  res.status(401).json({ error: 'No autorizado' });
}
app.post('/api/admin/login', (req, res) => {
  if (rateLimit('login:' + req.ip, 8, 15 * 60 * 1000)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  const a = crypto.createHash('sha256').update(pw).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!ADMIN_PASSWORD || email !== ADMIN_EMAIL || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  setCookie(res, 'enc_admin', makeToken({ admin: true, exp: Date.now() + 7 * 864e5 }), 7);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { setCookie(res, 'enc_admin', '', 0); res.json({ ok: true }); });
app.get('/api/admin/me', adminAuth, (req, res) => res.json({ ok: true, email: ADMIN_EMAIL }));

app.get('/api/admin/surveys', adminAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT s.id, s.slug, s.title, s.published, s.created_at,
      count(r.id)::int AS total,
      count(r.id) FILTER (WHERE r.status='completed')::int AS completed
    FROM surveys s LEFT JOIN responses r ON r.survey_id=s.id GROUP BY s.id ORDER BY s.created_at DESC`);
  res.json({ surveys: rows, baseUrl: baseUrl(req) });
});
app.post('/api/admin/surveys', adminAuth, async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Falta el título.' });
  let slug = slugify(req.body.slug || title);
  const exists = (await pool.query('SELECT 1 FROM surveys WHERE slug=$1', [slug])).rowCount;
  if (exists) slug += '-' + crypto.randomBytes(2).toString('hex');
  const items = withIds(Array.isArray(req.body.items) ? req.body.items : []);
  const { rows } = await pool.query('INSERT INTO surveys (slug,title,schema) VALUES ($1,$2,$3) RETURNING *', [slug, title, { items }]);
  res.json(rows[0]);
});
app.get('/api/admin/surveys/:id', adminAuth, async (req, res) => {
  const s = (await pool.query('SELECT * FROM surveys WHERE id=$1', [req.params.id])).rows[0];
  if (!s) return res.status(404).json({ error: 'No existe' });
  res.json(s);
});
app.put('/api/admin/surveys/:id', adminAuth, async (req, res) => {
  const { title, slug, schema, thanks_message, published } = req.body;
  const cur = (await pool.query('SELECT * FROM surveys WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'No existe' });
  const newSlug = slug ? slugify(slug) : cur.slug;
  const dup = (await pool.query('SELECT 1 FROM surveys WHERE slug=$1 AND id<>$2', [newSlug, cur.id])).rowCount;
  if (dup) return res.status(400).json({ error: 'Ese enlace ya está en uso.' });
  const items = schema && Array.isArray(schema.items) ? withIds(schema.items) : cur.schema.items;
  const { rows } = await pool.query(
    'UPDATE surveys SET title=$1, slug=$2, schema=$3, thanks_message=$4, published=$5 WHERE id=$6 RETURNING *',
    [title ?? cur.title, newSlug, { items }, thanks_message ?? cur.thanks_message, published ?? cur.published, cur.id]);
  res.json(rows[0]);
});
app.delete('/api/admin/surveys/:id', adminAuth, async (req, res) => {
  const keys = await keysOf('response_id IN (SELECT id FROM responses WHERE survey_id=$1)', req.params.id);
  await pool.query('DELETE FROM surveys WHERE id=$1', [req.params.id]);
  await s3Delete(keys);
  res.json({ ok: true });
});

app.get('/api/admin/surveys/:id/responses', adminAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.status, r.step, r.started_at, r.updated_at, r.completed_at, c.name, c.email,
       (SELECT count(*)::int FROM files f WHERE f.response_id=r.id) AS files, (r.share_token IS NOT NULL) AS shared
     FROM responses r JOIN clients c ON c.id=r.client_id WHERE r.survey_id=$1 ORDER BY r.updated_at DESC`, [req.params.id]);
  res.json({ responses: rows });
});
app.get('/api/admin/responses/:id', adminAuth, async (req, res) => {
  const r = (await pool.query(
    `SELECT r.*, c.name, c.email, s.title, s.schema, s.slug FROM responses r
     JOIN clients c ON c.id=r.client_id JOIN surveys s ON s.id=r.survey_id WHERE r.id=$1`, [req.params.id])).rows[0];
  if (!r) return res.status(404).json({ error: 'No existe' });
  r.files = (await pool.query('SELECT id, question_id, filename, size FROM files WHERE response_id=$1 ORDER BY id', [r.id])).rows;
  res.json(r);
});
app.delete('/api/admin/responses/:id', adminAuth, async (req, res) => {
  const keys = await keysOf('response_id=$1', req.params.id);
  await pool.query('DELETE FROM responses WHERE id=$1', [req.params.id]);
  await s3Delete(keys);
  res.json({ ok: true });
});
async function sendStoredFile(res, f) {
  if (f.s3_key) {
    const url = await S3.getSignedUrl(s3, new S3.GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: f.s3_key,
      ResponseContentType: f.mime, ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}` }), { expiresIn: 300 });
    return res.redirect(url);
  }
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.send(f.data);
}
app.get('/api/admin/files/:id', adminAuth, async (req, res) => {
  const f = (await pool.query('SELECT * FROM files WHERE id=$1', [req.params.id])).rows[0];
  if (!f) return res.status(404).end();
  await sendStoredFile(res, f);
});

/* ---------- compartir respuestas (enlace público de solo lectura) ---------- */
app.post('/api/admin/responses/:id/share', adminAuth, async (req, res) => {
  const token = crypto.randomBytes(24).toString('base64url');
  const { rows } = await pool.query('UPDATE responses SET share_token=COALESCE(share_token,$1), shared_at=COALESCE(shared_at,now()) WHERE id=$2 RETURNING share_token', [token, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'No existe' });
  res.json({ ok: true, token: rows[0].share_token, url: `${baseUrl(req)}/r/${rows[0].share_token}` });
});
app.delete('/api/admin/responses/:id/share', adminAuth, async (req, res) => {
  await pool.query('UPDATE responses SET share_token=NULL, shared_at=NULL WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});
const validToken = (t) => /^[A-Za-z0-9_-]{20,64}$/.test(t || '');
const noIndex = (res) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Cache-Control', 'no-store'); };
async function sharedResponse(token) {
  if (!validToken(token)) return null;
  return (await pool.query(
    `SELECT r.id, r.status, r.answers, r.started_at, r.updated_at, r.completed_at, c.name, s.title, s.schema
     FROM responses r JOIN clients c ON c.id=r.client_id JOIN surveys s ON s.id=r.survey_id WHERE r.share_token=$1`, [token])).rows[0] || null;
}
app.get('/api/share/:token', async (req, res) => {
  noIndex(res);
  const r = await sharedResponse(req.params.token);
  if (!r) return res.status(404).json({ error: 'Enlace no disponible' });
  r.files = (await pool.query('SELECT id, question_id, filename, size FROM files WHERE response_id=$1 ORDER BY id', [r.id])).rows;
  delete r.id;
  res.json(r);
});
app.get('/api/share/:token/files/:fid', async (req, res) => {
  noIndex(res);
  const r = await sharedResponse(req.params.token);
  if (!r) return res.status(404).end();
  const f = (await pool.query('SELECT * FROM files WHERE id=$1 AND response_id=$2', [req.params.fid, r.id])).rows[0];
  if (!f) return res.status(404).end();
  await sendStoredFile(res, f);
});

app.get('/api/admin/surveys/:id/export.csv', adminAuth, async (req, res) => {
  const s = (await pool.query('SELECT * FROM surveys WHERE id=$1', [req.params.id])).rows[0];
  if (!s) return res.status(404).end();
  const qs = s.schema.items.filter((i) => i.kind === 'question');
  const rows = (await pool.query(
    `SELECT r.*, c.name, c.email, (SELECT string_agg(f.filename, ' | ') FROM files f WHERE f.response_id=r.id) AS filenames
     FROM responses r JOIN clients c ON c.id=r.client_id WHERE r.survey_id=$1 ORDER BY r.started_at`, [s.id])).rows;
  const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['Nombre', 'Correo', 'Estado', 'Inicio', 'Última actualización', 'Completado', ...qs.map((q) => q.label), 'Archivos'];
  const lines = [head.map(cell).join(',')];
  for (const r of rows) {
    const vals = qs.map((q) => { const a = r.answers[q.id]; if (q.type === 'project') return fmtProjects(a, { in: ' | ', out: ' || ' }); return Array.isArray(a) ? a.join('; ') : (a && typeof a === 'object' ? [a, ...(a.extra || [])].map((x, i) => [x.q ? (i ? 'Pregunta adicional ' + i + ': ' : 'Pregunta: ') + x.q : '', x.a ? 'Respuesta: ' + x.a : ''].filter(Boolean).join(' / ')).filter(Boolean).join(' || ') : a); });
    lines.push([r.name, r.email, r.status === 'completed' ? 'Completado' : 'En curso', r.started_at.toISOString(), r.updated_at.toISOString(), r.completed_at ? r.completed_at.toISOString() : '', ...vals, r.filenames].map(cell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${s.slug}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

/* ---------- páginas ---------- */
const pub = path.join(__dirname, 'public');
app.use('/static', express.static(pub, { maxAge: '5m' }));
app.get('/health', (req, res) => res.send('ok'));
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.get('/s/:slug', (req, res) => res.sendFile(path.join(pub, 'survey.html')));
app.get('/r/:token', (req, res) => { noIndex(res); res.sendFile(path.join(pub, 'share.html')); });
app.get('/', (req, res) => res.redirect('/admin'));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Error del servidor.' }); });

initDb().then(() => app.listen(PORT, () => console.log('Encuesty escuchando en ' + PORT))).catch((e) => { console.error('No se pudo iniciar:', e); process.exit(1); });
