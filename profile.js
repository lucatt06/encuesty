/* Perfil del cliente, preguntas y respuestas, y sincronización con la base de conocimientos de GHL */
const crypto = require('crypto');
const util = require('util');

module.exports = function (ctx) {
  const { app, pool, readToken, makeToken, cookies, setCookie, validEmail, baseUrl, esc, adminAuth, s3Delete, rateLimit, SECRET, PUB } = ctx;
  const path = require('path');
  const GHL_BASE = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
  const DEBOUNCE_MS = Number(process.env.KB_DEBOUNCE_MS || 60000);
  const WORKER_MS = Number(process.env.KB_WORKER_MS || 30000);
  const VIRTUAL = '__proyectos', PROFILE_SLUG = '__perfil', PROFILE_QID = 'perfil_proyectos';
  const FAQ_MAX = 1000;
  const virtualSchema = { items: [{ kind: 'question', type: 'project', id: 'proyectos', label: 'Proyectos', required: false, first_tag: '' }] };

  /* ---------- cifrado de tokens de GHL ---------- */
  const KEY = crypto.createHash('sha256').update('ghl-token:' + (process.env.ENCRYPTION_KEY || SECRET)).digest();
  const enc = (t) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', KEY, iv); const e = Buffer.concat([c.update(t, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), e]).toString('base64url'); };
  const dec = (s) => { const b = Buffer.from(s, 'base64url'); const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); };

  let lastBase = '';
  const setBase = (b) => { if (!lastBase && b) lastBase = b; };
  const publicBase = () => (process.env.APP_URL || '').replace(/\/$/, '') || lastBase;

  /* ---------- esquema ---------- */
  let profileSurveyId = null;
  async function init() {
    await pool.query(`
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS ghl_token_enc TEXT;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS ghl_location_id TEXT;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS ghl_kb_id TEXT;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS kb_token TEXT;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS kb_dirty_at TIMESTAMPTZ;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS kb_synced_at TIMESTAMPTZ;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS kb_error TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS clients_kb_token_idx ON clients (kb_token) WHERE kb_token IS NOT NULL;
      CREATE TABLE IF NOT EXISTS client_faqs (
        id SERIAL PRIMARY KEY,
        client_id INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        ghl_faq_id TEXT,
        sync_state TEXT NOT NULL DEFAULT 'local',
        sync_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    profileSurveyId = await ensureProfileSurvey();
    if (process.env.GHL_SYNC !== 'off') setInterval(workerTick, WORKER_MS).unref();
  }
  async function ensureProfileSurvey() {
    const { rows } = await pool.query('SELECT id FROM surveys WHERE slug=$1', [PROFILE_SLUG]);
    if (rows[0]) return rows[0].id;
    const r = await pool.query('INSERT INTO surveys (slug,title,schema,published) VALUES ($1,$2,$3,false) RETURNING id',
      [PROFILE_SLUG, 'Perfil del cliente (proyectos añadidos desde el perfil)', { items: [{ kind: 'question', type: 'project', id: PROFILE_QID, label: 'Proyectos', required: false, first_tag: '' }] }]);
    return r.rows[0].id;
  }
  async function profileResponse(clientId) {
    return (await pool.query(`INSERT INTO responses (survey_id, client_id) VALUES ($1,$2)
      ON CONFLICT (survey_id, client_id) DO UPDATE SET survey_id=EXCLUDED.survey_id RETURNING *`, [profileSurveyId, clientId])).rows[0];
  }

  /* ---------- proyectos del cliente (agregados de todas sus respuestas) ---------- */
  const T = (v) => String(v ?? '').trim();
  const isBlank = (p) => !(T(p.name) || T(p.location) || T(p.type) || T(p.delivery) || T(p.payment) || T(p.amenities_other) || (p.amenities || []).length || (p.links || []).length || (p.units || []).some((u) => T(u.type) || T(u.price) || T(u.size)));
  const S = (v, n) => String(v ?? '').slice(0, n);
  function cleanProject(p) {
    const arr = (x, n, m) => (Array.isArray(x) ? x : []).slice(0, n).map((v) => S(v, m)).filter((v) => v.trim());
    return {
      id: S(p.id, 40), name: S(p.name, 200), location: S(p.location, 300),
      type: ['Villas', 'Apartamentos', 'Ambos'].includes(p.type) ? p.type : '',
      units: (Array.isArray(p.units) ? p.units : []).slice(0, 40).map((u) => ({ type: S(u && u.type, 200), price: S(u && u.price, 100), size: S(u && u.size, 100) })),
      links: arr(p.links, 30, 500).filter((l) => /^https?:\/\//i.test(l)),
      delivery: S(p.delivery, 100), payment: S(p.payment, 3000), amenities: arr(p.amenities, 60, 100), amenities_other: S(p.amenities_other, 400),
    };
  }
  async function clientProjects(clientId) {
    const { rows } = await pool.query(`SELECT r.id AS rid, r.answers, s.slug, s.title, s.schema FROM responses r JOIN surveys s ON s.id=r.survey_id
      WHERE r.client_id=$1 ORDER BY r.started_at, r.id`, [clientId]);
    const out = [];
    for (const r of rows) for (const it of (r.schema.items || [])) {
      if (it.kind !== 'question' || it.type !== 'project') continue;
      const arr = r.answers[it.id]; if (!Array.isArray(arr)) continue;
      for (const p of arr) if (p && typeof p === 'object' && p.id) out.push({ uid: p.id, project: p, rid: r.rid, qid: it.id, slug: r.slug, title: r.title });
    }
    return out;
  }
  async function mutateAnswers(rid, fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = (await c.query('SELECT answers FROM responses WHERE id=$1 FOR UPDATE', [rid])).rows[0];
      const a = r.answers || {}; fn(a);
      await c.query('UPDATE responses SET answers=$1, updated_at=now() WHERE id=$2', [a, rid]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async function markKbDirty(clientId) {
    await pool.query('UPDATE clients SET kb_dirty_at=now() WHERE id=$1 AND ghl_token_enc IS NOT NULL AND ghl_kb_id IS NOT NULL', [clientId]);
  }
  function afterAnswers(survey, clientId, answers) {
    const ids = ((survey.schema && survey.schema.items) || []).filter((i) => i.kind === 'question' && i.type === 'project').map((i) => i.id);
    if (ids.some((id) => id in answers)) markKbDirty(clientId).catch(() => {});
  }

  /* ---------- editor de proyectos del perfil (encuesta virtual "__proyectos") ---------- */
  async function virtualAuth(req, res, next) {
    const t = readToken(cookies(req).enc_perfil);
    const c = t && t.c ? (await pool.query('SELECT * FROM clients WHERE id=$1', [t.c])).rows[0] : null;
    if (!c) return res.status(401).json({ error: 'Sesión expirada', relogin: true });
    req.client = c; req.virtual = true;
    req.survey = { id: 0, slug: VIRTUAL, title: 'Proyectos', schema: virtualSchema, thanks_message: '' };
    const pr = await profileResponse(c.id);
    req.resp = { ...pr, email: c.email, name: c.name };
    next();
  }
  async function virtualPayload(client) {
    const [projs, files] = await Promise.all([
      clientProjects(client.id),
      pool.query('SELECT f.id, f.question_id, f.filename, f.size FROM files f JOIN responses r ON r.id=f.response_id WHERE r.client_id=$1 ORDER BY f.id', [client.id]),
    ]);
    const toVirtual = new Map(projs.map((x) => [`${x.qid}#${x.uid}`, `proyectos#${x.uid}`]));
    const vfiles = files.rows.filter((f) => toVirtual.has(f.question_id)).map((f) => ({ ...f, question_id: toVirtual.get(f.question_id) }));
    const withFiles = new Set(vfiles.map((f) => f.question_id.split('#')[1]));
    const list = projs.filter((x) => !isBlank(x.project) || withFiles.has(x.uid)).map((x) => x.project);
    return { survey: { title: 'Proyectos', slug: VIRTUAL, schema: virtualSchema, thanks: '' }, answers: { proyectos: list }, step: 0, status: 'in_progress', files: vfiles };
  }
  async function virtualSave(clientId, arr) {
    if (!Array.isArray(arr)) return;
    const cur = await clientProjects(clientId);
    const curMap = new Map(cur.map((x) => [x.uid, x]));
    const incoming = arr.filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(p.id)).slice(0, 200).map(cleanProject);
    const incIds = new Set(incoming.map((p) => p.id));
    const ops = new Map(); const push = (rid, qid, op) => { const k = rid + '|' + qid; if (!ops.has(k)) ops.set(k, { rid, qid, list: [] }); ops.get(k).list.push(op); };
    let prof = null; const removedKeys = [];
    for (const p of incoming) {
      const e = curMap.get(p.id);
      if (e) { if (!util.isDeepStrictEqual(cleanProject(e.project), p)) push(e.rid, e.qid, { t: 'replace', p }); }
      else if (!isBlank(p)) { prof = prof || (await profileResponse(clientId)); push(prof.id, PROFILE_QID, { t: 'add', p }); }
    }
    for (const e of cur) if (!incIds.has(e.uid)) { push(e.rid, e.qid, { t: 'remove', uid: e.uid }); removedKeys.push([e.rid, `${e.qid}#${e.uid}`]); }
    for (const { rid, qid, list } of ops.values()) {
      await mutateAnswers(rid, (a) => {
        let cur2 = Array.isArray(a[qid]) ? a[qid] : [];
        for (const op of list) {
          if (op.t === 'replace') { const i = cur2.findIndex((x) => x && x.id === op.p.id); if (i >= 0) cur2[i] = op.p; }
          else if (op.t === 'add') { if (!cur2.some((x) => x && x.id === op.p.id)) cur2.push(op.p); }
          else if (op.t === 'remove') cur2 = cur2.filter((x) => !(x && x.id === op.uid));
        }
        a[qid] = cur2;
      });
    }
    for (const [rid, key] of removedKeys) {
      const { rows } = await pool.query('DELETE FROM files WHERE response_id=$1 AND question_id=$2 RETURNING s3_key', [rid, key]);
      await s3Delete(rows.map((r) => r.s3_key));
    }
    if (ops.size) markKbDirty(clientId).catch(() => {});
  }
  // a qué respuesta/clave real pertenece un archivo subido desde el editor del perfil
  async function resolveVirtualFile(req, qidParam) {
    const m = /^proyectos#([A-Za-z0-9_-]{1,40})$/.exec(qidParam || ''); if (!m) return null;
    const uid = m[1];
    const e = (await clientProjects(req.client.id)).find((x) => x.uid === uid);
    if (e) return { rid: e.rid, qid: `${e.qid}#${uid}` };
    const pr = await profileResponse(req.client.id);
    await mutateAnswers(pr.id, (a) => { const arr = Array.isArray(a[PROFILE_QID]) ? a[PROFILE_QID] : []; if (!arr.some((x) => x && x.id === uid)) arr.push(cleanProject({ id: uid, units: [{}] })); a[PROFILE_QID] = arr; });
    return { rid: pr.id, qid: `${PROFILE_QID}#${uid}` };
  }

  /* ---------- texto de los proyectos (para el web crawler de GHL y el panel) ---------- */
  const nl = (s) => esc(s).replace(/\n/g, '<br>');
  async function kbHtml(client) {
    const projs = (await clientProjects(client.id)).filter((x) => !isBlank(x.project));
    const body = projs.map((x, i) => {
      const p = x.project;
      const units = (p.units || []).filter((u) => T(u.type) || T(u.price) || T(u.size));
      const am = [...(p.amenities || []), p.amenities_other].map(T).filter(Boolean);
      const links = (p.links || []).map(T).filter(Boolean);
      return `<section>\n<h2>Proyecto ${i + 1}: ${esc(T(p.name) || '(sin nombre)')}</h2>\n`
        + (T(p.location) ? `<p>Ubicación: ${esc(T(p.location))}</p>\n` : '')
        + (T(p.type) ? `<p>Tipo de proyecto: ${esc(T(p.type))}</p>\n` : '')
        + (T(p.delivery) ? `<p>Fecha de entrega: ${esc(T(p.delivery))}</p>\n` : '')
        + (units.length ? `<h3>Tipos de unidad, precios y metrajes</h3>\n<ul>\n${units.map((u) => `<li>${esc(T(u.type) || 'Unidad')}${T(u.price) ? ' — Precio: ' + esc(T(u.price)) : ''}${T(u.size) ? ' — Metraje: ' + esc(T(u.size)) : ''}</li>`).join('\n')}\n</ul>\n` : '')
        + (T(p.payment) ? `<h3>Plan de pago</h3>\n<p>${nl(T(p.payment))}</p>\n` : '')
        + (am.length ? `<h3>Amenidades</h3>\n<p>${esc(am.join(', '))}</p>\n` : '')
        + (links.length ? `<h3>Enlaces</h3>\n<ul>\n${links.map((l) => `<li>${esc(l)}</li>`).join('\n')}\n</ul>\n` : '')
        + '</section>';
    }).join('\n');
    return `<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<title>Proyectos de ${esc(client.name)}</title>\n</head>\n<body>\n<h1>Proyectos de ${esc(client.name)}</h1>\n`
      + (projs.length ? `<p>Información de los proyectos inmobiliarios de ${esc(client.name)}. Total de proyectos: ${projs.length}.</p>\n${body}\n` : `<p>${esc(client.name)} aún no ha registrado proyectos.</p>\n`)
      + '</body>\n</html>\n';
  }
  function projectText(p, n) {
    const units = (p.units || []).filter((u) => T(u.type) || T(u.price) || T(u.size)).map((u) => `   • ${T(u.type) || '?'} — ${T(u.price) || '?'} — ${T(u.size) || '?'}`);
    const am = [...(p.amenities || []), p.amenities_other].map(T).filter(Boolean).join(', ');
    return [`Proyecto ${n}: ${T(p.name) || '(sin nombre)'}`, `Ubicación: ${T(p.location)}`, `Tipo: ${T(p.type)}`, `Entrega: ${T(p.delivery)}`, 'Unidades:', ...units, `Plan de pago: ${T(p.payment)}`, `Amenidades: ${am}`, ...((p.links || []).length ? [`Enlaces: ${p.links.join(', ')}`] : [])].join('\n');
  }
  app.get('/kb/:token', async (req, res) => {
    const t = req.params.token;
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return res.status(404).type('text/plain').send('No disponible');
    const c = (await pool.query('SELECT id, name FROM clients WHERE kb_token=$1', [t])).rows[0];
    if (!c) return res.status(404).type('text/plain').send('No disponible');
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(await kbHtml(c));
  });
  async function ensureKbToken(clientId) {
    const { rows } = await pool.query('UPDATE clients SET kb_token=COALESCE(kb_token,$1) WHERE id=$2 RETURNING kb_token', [crypto.randomBytes(24).toString('base64url'), clientId]);
    return rows[0] && rows[0].kb_token;
  }

  /* ---------- API de GHL ---------- */
  async function ghlReq(c, method, p, { query, body } = {}) {
    const url = new URL(GHL_BASE + p);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const r = await fetch(url, {
      method, signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${c.tok}`, Version: '2021-07-28', Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text(); let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 200) }; }
    if (!r.ok) throw new Error(`GHL ${method} ${p} → ${r.status}: ${JSON.stringify(j).slice(0, 220)}`);
    return j;
  }
  async function listKbs(c) {
    const j = await ghlReq(c, 'GET', '/knowledge-bases/', { query: { locationId: c.loc, limit: 50 } });
    return (j.data || j.knowledgeBases || []).map((k) => ({ id: k.id || k._id, name: k.name || '(sin nombre)' })).filter((k) => k.id);
  }
  const connOf = (row) => (row.ghl_token_enc && row.ghl_location_id && row.ghl_kb_id ? { tok: dec(row.ghl_token_enc), loc: row.ghl_location_id, kb: row.ghl_kb_id } : null);

  async function syncProjects(row, c) {
    const token = row.kb_token || (await ensureKbToken(row.id));
    if (!publicBase()) throw new Error('Falta la dirección pública de Encuesty (APP_URL)');
    const url = `${publicBase()}/kb/${token}`;
    let ids = [];
    try {
      const j = await ghlReq(c, 'GET', '/knowledge-bases/crawler', { query: { knowledgeBaseId: c.kb, locationId: c.loc, query: token, page: 1, pageLength: 50 } });
      ids = (j.urls || []).filter((u) => String(u.url || '').includes(token)).map((u) => u.id || u._id).filter(Boolean);
    } catch { /* si no se puede listar, se intenta igual el escaneo */ }
    if (ids.length) await ghlReq(c, 'DELETE', '/knowledge-bases/crawler', { body: { knowledgeBaseId: c.kb, locationId: c.loc, urlIds: ids, deleteAll: false } });
    await ghlReq(c, 'POST', '/knowledge-bases/crawler', { body: { url, option: 'Exact', knowledgeBaseId: c.kb, locationId: c.loc, autoTrain: true } });
  }
  async function syncFaqs(row, c) {
    const { rows } = await pool.query("SELECT * FROM client_faqs WHERE client_id=$1 AND sync_state IN ('pending','delete','error') ORDER BY id", [row.id]);
    const errs = [];
    for (const f of rows) {
      try {
        if (f.sync_state === 'delete') {
          if (f.ghl_faq_id) await ghlReq(c, 'DELETE', `/knowledge-bases/faqs/${encodeURIComponent(f.ghl_faq_id)}`);
          await pool.query('DELETE FROM client_faqs WHERE id=$1', [f.id]);
        } else if (f.ghl_faq_id) {
          await ghlReq(c, 'PUT', `/knowledge-bases/faqs/${encodeURIComponent(f.ghl_faq_id)}`, { body: { question: f.question, answer: f.answer } });
          await pool.query("UPDATE client_faqs SET sync_state='synced', sync_error=NULL WHERE id=$1", [f.id]);
        } else {
          const j = await ghlReq(c, 'POST', '/knowledge-bases/faqs', { body: { question: f.question, answer: f.answer, knowledgeBaseId: c.kb, locationId: c.loc } });
          const id = (j.faq && (j.faq.id || j.faq._id)) || j.id;
          if (!id) throw new Error('GHL no devolvió el id de la pregunta');
          await pool.query("UPDATE client_faqs SET ghl_faq_id=$1, sync_state='synced', sync_error=NULL WHERE id=$2", [String(id), f.id]);
        }
      } catch (e) { errs.push(e.message); await pool.query("UPDATE client_faqs SET sync_state=CASE WHEN sync_state='delete' THEN 'delete' ELSE 'error' END, sync_error=$1 WHERE id=$2", [e.message.slice(0, 300), f.id]); }
    }
    if (errs.length) throw new Error(`Preguntas y respuestas: ${errs[0]}${errs.length > 1 ? ` (+${errs.length - 1} más)` : ''}`);
  }
  const syncing = new Set();
  async function syncClient(clientId, opts = {}) {
    if (syncing.has(clientId)) return { skipped: 'ya en curso' };
    syncing.add(clientId);
    try {
      const row = (await pool.query('SELECT * FROM clients WHERE id=$1', [clientId])).rows[0];
      const c = row && connOf(row); if (!c) return { skipped: 'sin conexión con GHL' };
      const started = new Date(); const errors = [];
      const projects = opts.projects !== false && (opts.force || row.kb_dirty_at);
      if (projects) {
        try { await syncProjects(row, c); await pool.query('UPDATE clients SET kb_dirty_at=NULL WHERE id=$1 AND kb_dirty_at <= $2', [clientId, started]); }
        catch (e) { errors.push('Proyectos: ' + e.message); }
      }
      if (opts.faqs !== false) { try { await syncFaqs(row, c); } catch (e) { errors.push(e.message); } }
      await pool.query('UPDATE clients SET kb_synced_at=CASE WHEN $2::text IS NULL THEN now() ELSE kb_synced_at END, kb_error=$2 WHERE id=$1', [clientId, errors.join(' | ').slice(0, 600) || null]);
      return { ok: !errors.length, errors, projects: !!projects };
    } catch (e) { console.error('[sync]', e.message); return { ok: false, errors: [e.message] }; }
    finally { syncing.delete(clientId); }
  }
  let busy = false;
  async function workerTick() {
    if (busy) return; busy = true;
    try {
      const { rows } = await pool.query(`SELECT id FROM clients WHERE ghl_token_enc IS NOT NULL AND ghl_kb_id IS NOT NULL AND (
        (kb_dirty_at IS NOT NULL AND kb_dirty_at < now() - make_interval(secs => $1))
        OR EXISTS (SELECT 1 FROM client_faqs f WHERE f.client_id=clients.id AND f.sync_state IN ('pending','delete')))`, [DEBOUNCE_MS / 1000]);
      for (const r of rows) {
        const dirty = (await pool.query('SELECT (kb_dirty_at IS NOT NULL AND kb_dirty_at < now() - make_interval(secs => $2)) AS d FROM clients WHERE id=$1', [r.id, DEBOUNCE_MS / 1000])).rows[0].d;
        await syncClient(r.id, { projects: dirty, force: dirty });
      }
    } catch (e) { console.error('[worker]', e.message); } finally { busy = false; }
  }

  /* ---------- perfil del cliente ---------- */
  async function perfilAuth(req, res, next) {
    const t = readToken(cookies(req).enc_perfil);
    const c = t && t.c ? (await pool.query('SELECT * FROM clients WHERE id=$1', [t.c])).rows[0] : null;
    if (!c) return res.status(401).json({ error: 'Sesión expirada', relogin: true });
    req.client = c; next();
  }
  app.get('/perfil', (req, res) => res.sendFile(path.join(PUB, 'perfil.html')));
  app.post('/api/perfil/start', async (req, res) => {
    try {
      if (rateLimit('pstart:' + req.ip, 30, 10 * 60 * 1000)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
      const email = String(req.body.email || '').trim().toLowerCase(), name = String(req.body.name || '').trim();
      if (!validEmail(email)) return res.status(400).json({ error: 'Escribe un correo válido.' });
      let c = (await pool.query('SELECT * FROM clients WHERE email=$1', [email])).rows[0];
      if (!c) {
        if (!name) return res.json({ needName: true });
        c = (await pool.query('INSERT INTO clients (email,name) VALUES ($1,$2) RETURNING *', [email, name.slice(0, 120)])).rows[0];
      }
      setCookie(res, 'enc_perfil', makeToken({ c: c.id }), 90);
      res.json({ ok: true, name: c.name });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error del servidor.' }); }
  });
  app.post('/api/perfil/logout', (req, res) => { setCookie(res, 'enc_perfil', '', 0); res.json({ ok: true }); });
  const faqRow = (f) => ({ id: f.id, question: f.question, answer: f.answer, state: f.sync_state });
  app.get('/api/perfil/me', perfilAuth, async (req, res) => {
    const c = req.client;
    const surveys = (await pool.query(`SELECT s.slug, s.title, r.status, r.completed_at FROM responses r JOIN surveys s ON s.id=r.survey_id
      WHERE r.client_id=$1 AND left(s.slug,2)<>'__' AND s.published ORDER BY r.started_at`, [c.id])).rows;
    const faqs = (await pool.query("SELECT * FROM client_faqs WHERE client_id=$1 AND sync_state<>'delete' ORDER BY id", [c.id])).rows.map(faqRow);
    res.json({ name: c.name, email: c.email, surveys, faqs, faqMax: FAQ_MAX,
      connected: !!(c.ghl_token_enc && c.ghl_kb_id), syncedAt: c.kb_synced_at, syncError: !!c.kb_error, pendingSync: !!c.kb_dirty_at });
  });
  function faqInput(body) {
    const q = String(body.question || '').trim(), a = String(body.answer || '').trim();
    if (!q || !a) return { error: 'Escribe la pregunta y la respuesta.' };
    if (q.length > FAQ_MAX || a.length > FAQ_MAX) return { error: `La pregunta y la respuesta pueden tener máximo ${FAQ_MAX} caracteres.` };
    return { q, a };
  }
  const kick = (clientId) => setImmediate(() => syncClient(clientId, { projects: false }).catch(() => {}));
  const connected = (c) => !!(c.ghl_token_enc && c.ghl_kb_id);
  app.post('/api/perfil/faqs', perfilAuth, async (req, res) => {
    const v = faqInput(req.body); if (v.error) return res.status(400).json({ error: v.error });
    const n = (await pool.query("SELECT count(*)::int AS n FROM client_faqs WHERE client_id=$1 AND sync_state<>'delete'", [req.client.id])).rows[0].n;
    if (n >= 500) return res.status(400).json({ error: 'Llegaste al máximo de preguntas y respuestas.' });
    const f = (await pool.query('INSERT INTO client_faqs (client_id, question, answer, sync_state) VALUES ($1,$2,$3,$4) RETURNING *', [req.client.id, v.q, v.a, connected(req.client) ? 'pending' : 'local'])).rows[0];
    if (connected(req.client)) kick(req.client.id);
    res.json({ ok: true, faq: faqRow(f) });
  });
  app.put('/api/perfil/faqs/:id', perfilAuth, async (req, res) => {
    const v = faqInput(req.body); if (v.error) return res.status(400).json({ error: v.error });
    const f = (await pool.query(`UPDATE client_faqs SET question=$1, answer=$2, updated_at=now(), sync_state=$3 WHERE id=$4 AND client_id=$5 AND sync_state<>'delete' RETURNING *`,
      [v.q, v.a, connected(req.client) ? 'pending' : 'local', req.params.id, req.client.id])).rows[0];
    if (!f) return res.status(404).json({ error: 'No existe.' });
    if (connected(req.client)) kick(req.client.id);
    res.json({ ok: true, faq: faqRow(f) });
  });
  app.delete('/api/perfil/faqs/:id', perfilAuth, async (req, res) => {
    const f = (await pool.query('SELECT * FROM client_faqs WHERE id=$1 AND client_id=$2', [req.params.id, req.client.id])).rows[0];
    if (!f) return res.status(404).json({ error: 'No existe.' });
    if (connected(req.client) && f.ghl_faq_id) { await pool.query("UPDATE client_faqs SET sync_state='delete' WHERE id=$1", [f.id]); kick(req.client.id); }
    else await pool.query('DELETE FROM client_faqs WHERE id=$1', [f.id]);
    res.json({ ok: true });
  });

  /* ---------- panel de administración: clientes y conexión con GHL ---------- */
  app.get('/api/admin/clients', adminAuth, async (req, res) => {
    setBase(baseUrl(req));
    const { rows } = await pool.query(`SELECT c.id, c.name, c.email, c.created_at, (c.ghl_token_enc IS NOT NULL AND c.ghl_kb_id IS NOT NULL) AS connected,
      c.kb_synced_at, c.kb_error, c.kb_dirty_at,
      (SELECT count(*)::int FROM responses r JOIN surveys s ON s.id=r.survey_id WHERE r.client_id=c.id AND left(s.slug,2)<>'__') AS surveys,
      (SELECT count(*)::int FROM client_faqs f WHERE f.client_id=c.id AND f.sync_state<>'delete') AS faqs
      FROM clients c ORDER BY c.created_at DESC`);
    for (const r of rows) r.projects = (await clientProjects(r.id)).filter((x) => !isBlank(x.project)).length;
    res.json({ clients: rows });
  });
  async function clientDetail(req, id) {
    const c = (await pool.query('SELECT * FROM clients WHERE id=$1', [id])).rows[0]; if (!c) return null;
    setBase(baseUrl(req));
    const token = await ensureKbToken(id);
    const projs = (await clientProjects(id)).filter((x) => !isBlank(x.project));
    const faqs = (await pool.query("SELECT * FROM client_faqs WHERE client_id=$1 AND sync_state<>'delete' ORDER BY id", [id])).rows;
    return {
      client: { id: c.id, name: c.name, email: c.email },
      ghl: { hasToken: !!c.ghl_token_enc, locationId: c.ghl_location_id || '', kbId: c.ghl_kb_id || '', connected: !!(c.ghl_token_enc && c.ghl_kb_id), syncedAt: c.kb_synced_at, error: c.kb_error, dirty: !!c.kb_dirty_at },
      kbUrl: `${publicBase()}/kb/${token}`,
      projects: projs.map((x, i) => ({ origin: x.slug === PROFILE_SLUG ? 'Perfil' : x.title, text: projectText(x.project, i + 1) })),
      faqs: faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer, state: f.sync_state, error: f.sync_error })),
    };
  }
  app.get('/api/admin/clients/:id', adminAuth, async (req, res) => {
    const d = await clientDetail(req, req.params.id); if (!d) return res.status(404).json({ error: 'No existe' });
    res.json(d);
  });
  // guardar credenciales de la subcuenta, probar y elegir la base de conocimientos
  app.put('/api/admin/clients/:id/ghl', adminAuth, async (req, res) => {
    const id = req.params.id;
    const c = (await pool.query('SELECT * FROM clients WHERE id=$1', [id])).rows[0]; if (!c) return res.status(404).json({ error: 'No existe' });
    const locationId = String(req.body.locationId || c.ghl_location_id || '').trim();
    const newToken = String(req.body.token || '').trim();
    if (!locationId) return res.status(400).json({ error: 'Falta el Location ID de la subcuenta.' });
    if (!newToken && !c.ghl_token_enc) return res.status(400).json({ error: 'Falta el token de API.' });
    const tokEnc = newToken ? enc(newToken) : c.ghl_token_enc;
    const tok = newToken || dec(c.ghl_token_enc);
    let kbs;
    try { kbs = await listKbs({ tok, loc: locationId }); }
    catch (e) {
      await pool.query('UPDATE clients SET ghl_token_enc=$1, ghl_location_id=$2, ghl_kb_id=NULL, kb_error=$3 WHERE id=$4', [tokEnc, locationId, e.message.slice(0, 300), id]);
      return res.json({ ok: false, error: e.message });
    }
    if (!kbs.length) {
      await pool.query('UPDATE clients SET ghl_token_enc=$1, ghl_location_id=$2, ghl_kb_id=NULL, kb_error=$3 WHERE id=$4', [tokEnc, locationId, 'La subcuenta no tiene bases de conocimiento', id]);
      return res.json({ ok: false, error: 'La conexión funciona, pero esa subcuenta no tiene ninguna base de conocimientos.', knowledgeBases: [] });
    }
    const want = String(req.body.kbId || '').trim();
    const pick = kbs.find((k) => k.id === want) || kbs.find((k) => k.id === c.ghl_kb_id) || kbs.find((k) => /existing|default|predeterminad/i.test(k.name)) || kbs[0];
    const changed = pick.id !== c.ghl_kb_id;
    await pool.query(`UPDATE clients SET ghl_token_enc=$1, ghl_location_id=$2, ghl_kb_id=$3, kb_error=NULL, kb_dirty_at=now() - interval '1 hour', kb_token=COALESCE(kb_token,$4) WHERE id=$5`,
      [tokEnc, locationId, pick.id, crypto.randomBytes(24).toString('base64url'), id]);
    if (changed) {
      await pool.query("DELETE FROM client_faqs WHERE client_id=$1 AND sync_state='delete'", [id]);
      await pool.query("UPDATE client_faqs SET sync_state='pending', ghl_faq_id=NULL WHERE client_id=$1", [id]);
    } else await pool.query("UPDATE client_faqs SET sync_state='pending' WHERE client_id=$1 AND sync_state='local'", [id]);
    setBase(baseUrl(req));
    setImmediate(() => syncClient(Number(id), { force: true }).catch(() => {}));
    res.json({ ok: true, knowledgeBases: kbs, kbId: pick.id, kbName: pick.name });
  });
  app.delete('/api/admin/clients/:id/ghl', adminAuth, async (req, res) => {
    await pool.query('UPDATE clients SET ghl_token_enc=NULL, ghl_location_id=NULL, ghl_kb_id=NULL, kb_dirty_at=NULL, kb_error=NULL, kb_synced_at=NULL WHERE id=$1', [req.params.id]);
    await pool.query("DELETE FROM client_faqs WHERE client_id=$1 AND sync_state='delete'", [req.params.id]);
    await pool.query("UPDATE client_faqs SET sync_state='local', ghl_faq_id=NULL, sync_error=NULL WHERE client_id=$1", [req.params.id]);
    res.json({ ok: true });
  });
  app.post('/api/admin/clients/:id/sync', adminAuth, async (req, res) => {
    setBase(baseUrl(req));
    const r = await syncClient(Number(req.params.id), { force: true });
    res.json(r);
  });

  return { VIRTUAL, init, setBase, virtualAuth, virtualPayload, virtualSave, resolveVirtualFile, afterAnswers, markKbDirty, syncClient };
};
