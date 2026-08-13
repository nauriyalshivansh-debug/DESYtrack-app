// SampleTrack API server — Express + SQLite + JWT + role-based access control.
// Hide Node's "SQLite is experimental" notice; the built-in driver is stable enough for this app.
const _emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  if (typeof w === 'string' && w.includes('SQLite')) return;
  return _emitWarning.call(process, w, ...rest);
};
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const storage = require('./storage');

const app = express();
// Parse JSON for every route EXCEPT the raw file-upload receiver (which streams bytes of any type).
app.use((req, res, next) => {
  if (req.path === '/api/uploads/local') return next();
  return express.json()(req, res, next);
});
app.use(express.static(path.join(__dirname, '..', 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3000;
// Public base URL of the deployed app. On Render this is provided automatically.
// When set, QR codes encode a full link (…/?code=SMP-…) so a normal phone camera opens the record.
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.full_name }, JWT_SECRET, { expiresIn: '12h' });
}

// Auth middleware: verifies the bearer token, loads the live user row.
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id,email,full_name,role,organization,is_active FROM users WHERE id=?').get(payload.id);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid session' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Restrict a route to specific roles.
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' });

const isInternal = (u) => u.role === 'admin' || u.role === 'member';

// Can this user see this sample? Internal: always. Partner: only if granted.
function accessRow(sampleId, user) {
  if (isInternal(user)) return { can_edit: 1 };
  return db.prepare('SELECT can_edit FROM sample_access WHERE sample_id=? AND user_id=?')
           .get(sampleId, user.id);
}

// Write one immutable custody/audit row.
function logEvent(sampleId, type, fromVal, toVal, note, actorId) {
  db.prepare(`INSERT INTO custody_events(sample_id,event_type,from_value,to_value,note,actor_id)
              VALUES (?,?,?,?,?,?)`).run(sampleId, type, fromVal, toVal, note, actorId);
}

// ------------------------------------------------------------------
// Auth
// ------------------------------------------------------------------
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email=? AND is_active=1').get(email);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash))
    return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: sign(user), publicUrl: PUBLIC_URL, user: { id: user.id, name: user.full_name, role: user.role, organization: user.organization } });
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

// ------------------------------------------------------------------
// Reference data
// ------------------------------------------------------------------
app.get('/api/statuses', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM statuses ORDER BY sort_order').all());
});
// Valid next statuses for a given current status.
app.get('/api/statuses/:code/next', auth, (req, res) => {
  const rows = db.prepare(`SELECT s.* FROM status_transitions t
     JOIN statuses s ON s.code=t.to_status WHERE t.from_status=? ORDER BY s.sort_order`).all(req.params.code);
  res.json(rows);
});

// ------------------------------------------------------------------
// Users (admin manages; internal users list for custodian dropdowns)
// ------------------------------------------------------------------
app.get('/api/users', auth, requireRole('admin', 'member'), (req, res) => {
  res.json(db.prepare('SELECT id,full_name,email,role,organization,is_active FROM users ORDER BY role,full_name').all());
});

app.post('/api/users', auth, requireRole('admin'), (req, res) => {
  const { email, full_name, password, role, organization } = req.body || {};
  if (!email || !full_name || !password) return res.status(400).json({ error: 'email, full_name, password required' });
  if (!['admin', 'member', 'partner'].includes(role)) return res.status(400).json({ error: 'bad role' });
  try {
    const info = db.prepare(`INSERT INTO users(email,full_name,password_hash,role,organization)
      VALUES (?,?,?,?,?)`).run(email, full_name, bcrypt.hashSync(password, 10), role, organization || null);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(409).json({ error: 'Email already exists' });
  }
});

// ------------------------------------------------------------------
// Samples
// ------------------------------------------------------------------
// List: internal sees all (with filters); partner sees only granted samples.
app.get('/api/samples', auth, (req, res) => {
  const { status, q, material } = req.query;
  const where = [];
  const args = {};
  if (status) { where.push('s.status=@status'); args.status = status; }
  if (material) { where.push('s.material_type=@material'); args.material = material; }
  if (q) { where.push('(s.name LIKE @q OR s.sample_code LIKE @q OR s.origin LIKE @q)'); args.q = `%${q}%`; }

  let sql = `SELECT s.*, st.label AS status_label, u.full_name AS custodian_name
             FROM samples s
             JOIN statuses st ON st.code=s.status
             LEFT JOIN users u ON u.id=s.custodian_id`;
  if (!isInternal(req.user)) {
    sql += ` JOIN sample_access sa ON sa.sample_id=s.id AND sa.user_id=@uid`;
    args.uid = req.user.id;
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY s.created_at DESC';
  res.json(db.prepare(sql).all(args));
});

// Detail with tests, comments, custody timeline — access-checked.
app.get('/api/samples/:id', auth, (req, res) => {
  const id = req.params.id;
  const access = accessRow(id, req.user);
  if (!access) return res.status(404).json({ error: 'Not found' });
  const sample = db.prepare(`SELECT s.*, st.label AS status_label, u.full_name AS custodian_name,
       sn.label AS station_label
     FROM samples s JOIN statuses st ON st.code=s.status
     LEFT JOIN users u ON u.id=s.custodian_id
     LEFT JOIN stations sn ON sn.code=s.current_station WHERE s.id=?`).get(id);
  if (!sample) return res.status(404).json({ error: 'Not found' });

  const tests = db.prepare('SELECT t.*, u.full_name AS performer FROM tests t LEFT JOIN users u ON u.id=t.performed_by WHERE sample_id=? ORDER BY created_at DESC').all(id);
  // Partners never see internal-only comments.
  const commentSql = isInternal(req.user)
    ? 'SELECT c.*, u.full_name AS author FROM comments c JOIN users u ON u.id=c.author_id WHERE sample_id=? ORDER BY created_at'
    : `SELECT c.*, u.full_name AS author FROM comments c JOIN users u ON u.id=c.author_id WHERE sample_id=? AND visibility='shared' ORDER BY created_at`;
  const comments = db.prepare(commentSql).all(id);
  const events = db.prepare('SELECT e.*, u.full_name AS actor FROM custody_events e JOIN users u ON u.id=e.actor_id WHERE sample_id=? ORDER BY created_at DESC').all(id);

  res.json({ sample, tests, comments, events, can_edit: !!access.can_edit });
});

// Create (internal only). Generates the next accession code.
app.post('/api/samples', auth, requireRole('admin', 'member'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const year = new Date().getFullYear();
  const n = db.prepare("SELECT COUNT(*) c FROM samples WHERE sample_code LIKE ?").get(`SMP-${year}-%`).c + 1;
  const sample_code = `SMP-${year}-${String(n).padStart(4, '0')}`;
  const info = db.prepare(`INSERT INTO samples
     (sample_code,name,description,material_type,batch_lot,origin,quantity,unit,storage_location,hazard_class,status,custodian_id,created_by,received_at)
     VALUES (@sample_code,@name,@description,@material_type,@batch_lot,@origin,@quantity,@unit,@storage_location,@hazard_class,'received',@custodian_id,@uid,@received_at)`)
    .run({
      sample_code, name: b.name, description: b.description || null, material_type: b.material_type || null,
      batch_lot: b.batch_lot || null, origin: b.origin || null, quantity: b.quantity ?? null, unit: b.unit || null,
      storage_location: b.storage_location || null, hazard_class: b.hazard_class || 'none',
      custodian_id: b.custodian_id || req.user.id, uid: req.user.id,
      received_at: b.received_at || new Date().toISOString().slice(0, 10),
    });
  logEvent(info.lastInsertRowid, 'created', null, 'received', 'Sample logged', req.user.id);
  res.status(201).json({ id: info.lastInsertRowid, sample_code });
});

// Edit fields (internal only). Records an audit event.
app.put('/api/samples/:id', auth, requireRole('admin', 'member'), (req, res) => {
  const id = req.params.id;
  const cur = db.prepare('SELECT * FROM samples WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const fields = ['name', 'description', 'material_type', 'batch_lot', 'origin', 'quantity', 'unit', 'storage_location', 'hazard_class', 'custodian_id'];
  const sets = [], args = {};
  for (const f of fields) if (f in b) { sets.push(`${f}=@${f}`); args[f] = b[f]; }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  args.id = id;
  db.prepare(`UPDATE samples SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=@id`).run(args);
  // If custodian changed, record a transfer event.
  if ('custodian_id' in b && b.custodian_id != cur.custodian_id) {
    logEvent(id, 'transfer', String(cur.custodian_id || ''), String(b.custodian_id || ''), 'Custody transferred', req.user.id);
  } else {
    logEvent(id, 'edit', null, null, 'Fields updated', req.user.id);
  }
  res.json({ ok: true });
});

// Change status, enforcing the allowed-transition graph (internal only).
app.post('/api/samples/:id/status', auth, requireRole('admin', 'member'), (req, res) => {
  const id = req.params.id;
  const { to, note } = req.body || {};
  const cur = db.prepare('SELECT status FROM samples WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const allowed = db.prepare('SELECT 1 FROM status_transitions WHERE from_status=? AND to_status=?').get(cur.status, to);
  if (!allowed) return res.status(400).json({ error: `Transition ${cur.status} → ${to} not allowed` });
  db.prepare("UPDATE samples SET status=?, updated_at=datetime('now') WHERE id=?").run(to, id);
  logEvent(id, 'status_change', cur.status, to, note || null, req.user.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------
app.post('/api/samples/:id/tests', auth, requireRole('admin', 'member'), (req, res) => {
  const id = req.params.id;
  if (!db.prepare('SELECT 1 FROM samples WHERE id=?').get(id)) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (!b.test_type) return res.status(400).json({ error: 'test_type required' });
  const info = db.prepare(`INSERT INTO tests(sample_id,test_type,method,result_value,result_unit,outcome,performed_by,performed_at)
     VALUES (?,?,?,?,?,?,?,?)`).run(id, b.test_type, b.method || null, b.result_value || null, b.result_unit || null,
       b.outcome || 'pending', req.user.id, b.performed_at || new Date().toISOString().slice(0, 10));
  logEvent(id, 'test_logged', null, b.test_type, `Result: ${b.result_value ?? '—'} (${b.outcome || 'pending'})`, req.user.id);
  res.status(201).json({ id: info.lastInsertRowid });
});

// ------------------------------------------------------------------
// Comments (partners may add shared comments on samples they can access)
// ------------------------------------------------------------------
app.post('/api/samples/:id/comments', auth, (req, res) => {
  const id = req.params.id;
  const access = accessRow(id, req.user);
  if (!access) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (!b.body) return res.status(400).json({ error: 'body required' });
  // Only internal users may post internal-visibility comments.
  const visibility = (b.visibility === 'internal' && isInternal(req.user)) ? 'internal' : 'shared';
  const info = db.prepare('INSERT INTO comments(sample_id,author_id,body,visibility) VALUES (?,?,?,?)')
    .run(id, req.user.id, b.body, visibility);
  logEvent(id, 'note', null, null, 'Comment added', req.user.id);
  res.status(201).json({ id: info.lastInsertRowid });
});

// ------------------------------------------------------------------
// Partner access grants (admin only)
// ------------------------------------------------------------------
app.get('/api/samples/:id/access', auth, requireRole('admin', 'member'), (req, res) => {
  res.json(db.prepare(`SELECT sa.*, u.full_name, u.email, u.organization
     FROM sample_access sa JOIN users u ON u.id=sa.user_id WHERE sample_id=?`).all(req.params.id));
});
app.post('/api/samples/:id/access', auth, requireRole('admin'), (req, res) => {
  const { user_id, can_edit } = req.body || {};
  const partner = db.prepare("SELECT id FROM users WHERE id=? AND role='partner'").get(user_id);
  if (!partner) return res.status(400).json({ error: 'user must be a partner' });
  db.prepare(`INSERT INTO sample_access(sample_id,user_id,can_edit,granted_by) VALUES (?,?,?,?)
     ON CONFLICT(sample_id,user_id) DO UPDATE SET can_edit=excluded.can_edit`)
    .run(req.params.id, user_id, can_edit ? 1 : 0, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/samples/:id/access/:userId', auth, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM sample_access WHERE sample_id=? AND user_id=?').run(req.params.id, req.params.userId);
  res.json({ ok: true });
});

// Resolve a scanned/typed accession code to a sample id (respects access).
app.get('/api/resolve', auth, (req, res) => {
  const code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code required' });
  const s = db.prepare('SELECT id FROM samples WHERE sample_code=?').get(code);
  if (!s) return res.status(404).json({ error: `No sample found for code "${code}"` });
  const access = accessRow(s.id, req.user);
  if (!access) return res.status(404).json({ error: `No sample found for code "${code}"` });
  res.json({ id: s.id });
});

// ------------------------------------------------------------------
// Stations — designated physical spots, each with its own QR poster
// ------------------------------------------------------------------
app.get('/api/stations', auth, (req, res) => {
  res.json(db.prepare(`SELECT st.*, s.label AS status_label
     FROM stations st LEFT JOIN statuses s ON s.code=st.set_status
     WHERE st.is_active=1 ORDER BY st.sort_order, st.label`).all());
});

// Create or update a station (admin only).
app.post('/api/stations', auth, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const code = (b.code || '').trim().toUpperCase();
  if (!code || !b.label || !b.location) return res.status(400).json({ error: 'code, label, location required' });
  if (!/^STN-[A-Z0-9-]+$/.test(code)) return res.status(400).json({ error: 'code must look like STN-TESTING' });
  if (b.set_status && !db.prepare('SELECT 1 FROM statuses WHERE code=?').get(b.set_status))
    return res.status(400).json({ error: 'unknown set_status' });
  db.prepare(`INSERT INTO stations(code,label,location,set_status,sort_order,is_active)
     VALUES (@code,@label,@location,@set_status,@sort_order,1)
     ON CONFLICT(code) DO UPDATE SET label=excluded.label, location=excluded.location,
       set_status=excluded.set_status, sort_order=excluded.sort_order, is_active=1`)
    .run({ code, label: b.label, location: b.location, set_status: b.set_status || null,
           sort_order: Number.isFinite(+b.sort_order) ? +b.sort_order : 0 });
  res.status(201).json({ ok: true, code });
});

// Scan a sample at a station. Client sends both codes (captured in either order).
// Records the sample's physical location and advances its stage when the station
// maps to a status AND that transition is allowed. Internal users only.
app.post('/api/scan', auth, requireRole('admin', 'member'), (req, res) => {
  const b = req.body || {};
  const sampleCode = (b.sample_code || '').trim();
  const stationCode = (b.station_code || '').trim().toUpperCase();
  if (!sampleCode || !stationCode) return res.status(400).json({ error: 'sample_code and station_code required' });

  const sample = db.prepare('SELECT * FROM samples WHERE sample_code=?').get(sampleCode);
  if (!sample) return res.status(404).json({ error: `No sample found for code "${sampleCode}"` });
  const station = db.prepare('SELECT * FROM stations WHERE code=? AND is_active=1').get(stationCode);
  if (!station) return res.status(404).json({ error: `No station found for code "${stationCode}"` });

  // Optional handler badge (USR-<id>): who is taking custody at this spot.
  let handler = null;
  const handlerCode = (b.handler_code || '').trim().toUpperCase();
  if (handlerCode) {
    const m = /^USR-(\d+)$/.exec(handlerCode);
    if (m) handler = db.prepare('SELECT id, full_name FROM users WHERE id=? AND is_active=1').get(Number(m[1]));
    if (!handler) return res.status(404).json({ error: `Unknown handler badge "${handlerCode}"` });
  }

  const label = (code) => (db.prepare('SELECT label FROM statuses WHERE code=?').get(code) || {}).label || code;
  const fromStatus = sample.status;
  let toStatus = fromStatus, statusChanged = false, statusBlocked = false;

  if (station.set_status && station.set_status !== fromStatus) {
    const allowed = db.prepare('SELECT 1 FROM status_transitions WHERE from_status=? AND to_status=?')
      .get(fromStatus, station.set_status);
    if (allowed) { toStatus = station.set_status; statusChanged = true; }
    else { statusBlocked = true; }
  }

  db.prepare(`UPDATE samples SET current_station=?, current_location=?, status=?, updated_at=datetime('now') WHERE id=?`)
    .run(station.code, station.location, toStatus, sample.id);

  // Handler badge → custody handoff to that person.
  let custodyMsg = '';
  if (handler && handler.id !== sample.custodian_id) {
    db.prepare("UPDATE samples SET custodian_id=?, updated_at=datetime('now') WHERE id=?").run(handler.id, sample.id);
    logEvent(sample.id, 'transfer', String(sample.custodian_id || ''), String(handler.id),
      `Custody to ${handler.full_name} (badge scan)`, req.user.id);
    custodyMsg = ` Custody → ${handler.full_name}.`;
  }

  let message;
  if (statusChanged)      message = `Moved to ${station.label} — stage advanced to '${label(toStatus)}'.`;
  else if (statusBlocked) message = `Logged at ${station.label}. Stage kept at '${label(fromStatus)}' — ${label(fromStatus)} → ${label(station.set_status)} isn't an allowed step.`;
  else                    message = `Logged at ${station.label} — already at '${label(fromStatus)}'.`;
  message += custodyMsg;

  logEvent(sample.id, 'scan', statusChanged ? fromStatus : null, statusChanged ? toStatus : null,
    `Scanned at ${station.label} · ${station.location}${statusBlocked ? ' — stage change skipped (not an allowed step)' : ''}`,
    req.user.id);

  res.json({
    ok: true, statusChanged, statusBlocked, fromStatus, toStatus,
    fromStatusLabel: label(fromStatus), toStatusLabel: label(toStatus), message,
    handler: handler ? { id: handler.id, name: handler.full_name } : null,
    sample: { id: sample.id, sample_code: sample.sample_code, name: sample.name },
    station: { code: station.code, label: station.label, location: station.location, set_status: station.set_status },
  });
});

// Dashboard counts by status (respects partner scoping).
app.get('/api/stats', auth, (req, res) => {
  let sql = `SELECT s.status, st.label, COUNT(*) n FROM samples s JOIN statuses st ON st.code=s.status`;
  const args = {};
  if (!isInternal(req.user)) { sql += ' JOIN sample_access sa ON sa.sample_id=s.id AND sa.user_id=@uid'; args.uid = req.user.id; }
  sql += ' GROUP BY s.status ORDER BY st.sort_order';
  res.json(db.prepare(sql).all(args));
});

// ------------------------------------------------------------------
// Attachments / data files — object storage, partner-visible when 'shared'
// ------------------------------------------------------------------
const RAW_LIMIT = (process.env.MAX_UPLOAD_MB || '50') + 'mb';

// Step 1: browser asks where to upload → presigned S3 PUT, or a local URL in fallback mode.
app.post('/api/samples/:id/attachments/presign', auth, requireRole('admin', 'member'), async (req, res) => {
  const id = req.params.id;
  if (!db.prepare('SELECT 1 FROM samples WHERE id=?').get(id)) return res.status(404).json({ error: 'Not found' });
  const { filename, content_type } = req.body || {};
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const key = storage.newKey(id, filename);
  const target = await storage.presignPut(key, content_type);
  res.json({ ...target, key, storage_mode: storage.mode });
});

// Local-disk receiver (fallback mode only). S3 uploads go straight to the bucket, not here.
app.put('/api/uploads/local', auth, requireRole('admin', 'member'),
  express.raw({ type: '*/*', limit: RAW_LIMIT }), (req, res) => {
    if (storage.useS3) return res.status(400).json({ error: 'local upload disabled (S3 configured)' });
    const key = req.query.key || '';
    if (!/^samples\//.test(key)) return res.status(400).json({ error: 'bad key' });
    try { storage.saveLocal(key, req.body); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: 'save failed' }); }
  });

// Step 2: record the finished upload's metadata.
app.post('/api/samples/:id/attachments', auth, requireRole('admin', 'member'), (req, res) => {
  const id = req.params.id;
  if (!db.prepare('SELECT 1 FROM samples WHERE id=?').get(id)) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (!b.key || !b.filename) return res.status(400).json({ error: 'key and filename required' });
  const visibility = (b.visibility === 'internal') ? 'internal' : 'shared';
  const info = db.prepare(`INSERT INTO attachments(sample_id,filename,content_type,size_bytes,storage_key,storage_mode,visibility,uploaded_by)
     VALUES (?,?,?,?,?,?,?,?)`).run(id, b.filename, b.content_type || null, b.size_bytes || null, b.key, storage.mode, visibility, req.user.id);
  logEvent(id, 'attachment', null, b.filename, `Data file added: ${b.filename} (${visibility})`, req.user.id);
  res.status(201).json({ id: info.lastInsertRowid });
});

// List a sample's files (partners see only 'shared').
app.get('/api/samples/:id/attachments', auth, (req, res) => {
  const id = req.params.id;
  const access = accessRow(id, req.user);
  if (!access) return res.status(404).json({ error: 'Not found' });
  const base = `SELECT a.id,a.filename,a.content_type,a.size_bytes,a.visibility,a.storage_mode,a.created_at,
     u.full_name AS uploader FROM attachments a LEFT JOIN users u ON u.id=a.uploaded_by WHERE a.sample_id=?`;
  const sql = isInternal(req.user) ? base + ' ORDER BY a.created_at DESC'
                                   : base + " AND a.visibility='shared' ORDER BY a.created_at DESC";
  res.json(db.prepare(sql).all(id));
});

// Short-lived download link (access-checked). S3 → presigned bucket URL; local → tokenised app URL.
app.get('/api/attachments/:aid/link', auth, async (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.aid);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const access = accessRow(a.sample_id, req.user);
  if (!access) return res.status(404).json({ error: 'Not found' });
  if (!isInternal(req.user) && a.visibility !== 'shared') return res.status(403).json({ error: 'Forbidden' });
  if (a.storage_mode === 's3') {
    return res.json({ url: await storage.presignGet(a.storage_key, a.filename) });
  }
  if (!storage.existsLocal(a.storage_key))
    return res.status(410).json({ error: 'File no longer available — local storage was reset. Re-upload, or configure S3 for persistence.' });
  const t = jwt.sign({ aid: a.id, s: 'dl' }, JWT_SECRET, { expiresIn: '5m' });
  res.json({ url: `/api/attachments/${a.id}/raw?t=${encodeURIComponent(t)}` });
});

// Tokenised local streamer (no auth header needed; the token carries authorization).
app.get('/api/attachments/:aid/raw', (req, res) => {
  try { const p = jwt.verify(req.query.t || '', JWT_SECRET); if (p.s !== 'dl' || String(p.aid) !== String(req.params.aid)) throw new Error('bad'); }
  catch { return res.status(401).json({ error: 'Bad or expired download link' }); }
  const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.aid);
  if (!a || a.storage_mode !== 'local' || !storage.existsLocal(a.storage_key)) return res.status(410).json({ error: 'File not available' });
  res.setHeader('Content-Disposition', `attachment; filename="${String(a.filename || 'file').replace(/"/g, '')}"`);
  if (a.content_type) res.setHeader('Content-Type', a.content_type);
  storage.readLocalStream(a.storage_key).pipe(res);
});

// Remove an attachment record (admin/member).
app.delete('/api/attachments/:aid', auth, requireRole('admin', 'member'), (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.aid);
  if (!a) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
  logEvent(a.sample_id, 'note', null, null, `Data file removed: ${a.filename}`, req.user.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`DESYtrack API + UI running on http://localhost:${PORT} [storage: ${storage.mode}]`));
