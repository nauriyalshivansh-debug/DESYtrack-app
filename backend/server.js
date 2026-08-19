// DESYtrack API server — Express + PostgreSQL (Neon) + JWT + role-based access control.
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
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.full_name }, JWT_SECRET, { expiresIn: '12h' });
}

// Auth middleware: verifies the bearer token, loads the live user row.
async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.prepare('SELECT id,email,full_name,role,organization,is_active FROM users WHERE id=?').get(payload.id);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid session' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' });

const isInternal = (u) => u.role === 'admin' || u.role === 'member';

// Can this user see this sample? Internal: always. Partner: only samples owned by
// their organization, or explicitly shared with them. Never another partner's.
async function accessRow(sampleId, user) {
  if (isInternal(user)) return { can_edit: 1 };
  const grant = await db.prepare('SELECT can_edit FROM sample_access WHERE sample_id=? AND user_id=?').get(sampleId, user.id);
  if (grant) return grant;
  if (user.organization) {
    const owned = await db.prepare('SELECT 1 AS ok FROM samples WHERE id=? AND owner_org=?').get(sampleId, user.organization);
    if (owned) return { can_edit: 0 };
  }
  return undefined;
}

// Write one immutable custody/audit row.
async function logEvent(sampleId, type, fromVal, toVal, note, actorId) {
  await db.prepare(`INSERT INTO custody_events(sample_id,event_type,from_value,to_value,note,actor_id)
              VALUES (?,?,?,?,?,?)`).run(sampleId, type, fromVal, toVal, note, actorId);
}

// ------------------------------------------------------------------
// Auth
// ------------------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { username, email, user_id, password } = req.body || {};
  const ident = String(username || email || user_id || '').trim();
  const user = await db.prepare('SELECT * FROM users WHERE (username=? OR email=?) AND is_active=1').get(ident, ident);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash))
    return res.status(401).json({ error: 'Invalid user ID or password' });
  res.json({ token: sign(user), publicUrl: PUBLIC_URL, user: { id: user.id, name: user.full_name, role: user.role, organization: user.organization } });
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

// ------------------------------------------------------------------
// Reference data
// ------------------------------------------------------------------
app.get('/api/statuses', auth, async (req, res) => {
  res.json(await db.prepare('SELECT * FROM statuses ORDER BY sort_order').all());
});
app.get('/api/statuses/:code/next', auth, async (req, res) => {
  const rows = await db.prepare(`SELECT s.* FROM status_transitions t
     JOIN statuses s ON s.code=t.to_status WHERE t.from_status=? ORDER BY s.sort_order`).all(req.params.code);
  res.json(rows);
});

// ------------------------------------------------------------------
// Users
// ------------------------------------------------------------------
app.get('/api/users', auth, requireRole('admin', 'member'), async (req, res) => {
  res.json(await db.prepare('SELECT id,username,full_name,email,role,organization,is_active FROM users ORDER BY role,full_name').all());
});

app.post('/api/users', auth, requireRole('admin'), async (req, res) => {
  const { username, email, full_name, password, role, organization } = req.body || {};
  if (!username || !full_name || !password) return res.status(400).json({ error: 'User ID, full name and password are required' });
  if (!['admin', 'member', 'partner'].includes(role)) return res.status(400).json({ error: 'bad role' });
  try {
    const row = await db.prepare(`INSERT INTO users(username,email,full_name,password_hash,role,organization)
      VALUES (?,?,?,?,?,?) RETURNING id`).get(String(username).trim(), email || null, full_name, bcrypt.hashSync(password, 10), role, organization || null);
    res.status(201).json({ id: row.id });
  } catch (e) {
    res.status(409).json({ error: 'That User ID or email is already taken' });
  }
});

app.post('/api/users/:id/password', auth, requireRole('admin'), async (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const u = await db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});

// Update a user's details (admin). Does not touch the password (use the reset endpoint).
app.put('/api/users/:id', auth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.prepare('SELECT id, role FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if ('role' in b && !['admin', 'member', 'partner'].includes(b.role)) return res.status(400).json({ error: 'bad role' });
  // Don't let the last admin lose their admin role.
  if ('role' in b && u.role === 'admin' && b.role !== 'admin') {
    const admins = (await db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND is_active=1").get()).n;
    if (admins <= 1) return res.status(400).json({ error: 'Cannot change the role of the last active admin' });
  }
  const nullable = new Set(['username', 'email', 'organization']);
  const sets = [], args = {};
  for (const f of ['username', 'email', 'full_name', 'role', 'organization']) {
    if (f in b) { sets.push(`${f}=@${f}`); args[f] = nullable.has(f) ? (b[f] || null) : b[f]; }
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  args.id = id;
  try {
    await db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=@id`).run(args);
  } catch (e) {
    return res.status(409).json({ error: 'That User ID or email is already taken' });
  }
  res.json({ ok: true });
});

app.post('/api/users/:id/active', auth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const active = (req.body && req.body.active) ? 1 : 0;
  const u = await db.prepare('SELECT id, role FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (id === req.user.id) return res.status(400).json({ error: "You can't disable your own account" });
  if (!active && u.role === 'admin') {
    const admins = (await db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND is_active=1").get()).n;
    if (admins <= 1) return res.status(400).json({ error: 'Cannot disable the last active admin' });
  }
  await db.prepare('UPDATE users SET is_active=? WHERE id=?').run(active, id);
  res.json({ ok: true });
});

app.delete('/api/users/:id', auth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.prepare('SELECT id, role FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  if (u.role === 'admin') {
    const admins = (await db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get()).n;
    if (admins <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
  }
  const refs = (await db.prepare(`SELECT
      (SELECT COUNT(*) FROM samples WHERE created_by=@id OR custodian_id=@id)
    + (SELECT COUNT(*) FROM custody_events WHERE actor_id=@id)
    + (SELECT COUNT(*) FROM tests WHERE performed_by=@id)
    + (SELECT COUNT(*) FROM comments WHERE author_id=@id)
    + (SELECT COUNT(*) FROM attachments WHERE uploaded_by=@id) AS n`).get({ id })).n;
  if (refs > 0) return res.status(409).json({ error: 'This user has activity in the system — disable them instead so the audit trail stays intact.' });
  await db.prepare('UPDATE sample_access SET granted_by=NULL WHERE granted_by=?').run(id);
  await db.prepare('DELETE FROM sample_access WHERE user_id=?').run(id);
  await db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// Samples
// ------------------------------------------------------------------
app.get('/api/samples', auth, async (req, res) => {
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
    where.push('(s.owner_org=@porg OR EXISTS (SELECT 1 FROM sample_access sa WHERE sa.sample_id=s.id AND sa.user_id=@uid))');
    args.porg = req.user.organization || ' ';
    args.uid = req.user.id;
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY s.created_at DESC';
  res.json(await db.prepare(sql).all(args));
});

app.get('/api/samples/:id', auth, async (req, res) => {
  const id = req.params.id;
  const access = await accessRow(id, req.user);
  if (!access) return res.status(404).json({ error: 'Not found' });
  const sample = await db.prepare(`SELECT s.*, st.label AS status_label, u.full_name AS custodian_name,
       sn.label AS station_label
     FROM samples s JOIN statuses st ON st.code=s.status
     LEFT JOIN users u ON u.id=s.custodian_id
     LEFT JOIN stations sn ON sn.code=s.current_station WHERE s.id=?`).get(id);
  if (!sample) return res.status(404).json({ error: 'Not found' });

  const tests = await db.prepare('SELECT t.*, u.full_name AS performer FROM tests t LEFT JOIN users u ON u.id=t.performed_by WHERE sample_id=? ORDER BY created_at DESC').all(id);
  const commentSql = isInternal(req.user)
    ? 'SELECT c.*, u.full_name AS author FROM comments c JOIN users u ON u.id=c.author_id WHERE sample_id=? ORDER BY created_at'
    : `SELECT c.*, u.full_name AS author FROM comments c JOIN users u ON u.id=c.author_id WHERE sample_id=? AND visibility='shared' ORDER BY created_at`;
  const comments = await db.prepare(commentSql).all(id);
  const events = await db.prepare('SELECT e.*, u.full_name AS actor FROM custody_events e JOIN users u ON u.id=e.actor_id WHERE sample_id=? ORDER BY created_at DESC').all(id);
  let collaborators = [];
  if (isInternal(req.user)) {
    collaborators = await db.prepare(`SELECT u.id AS user_id, u.full_name, u.role, u.organization, sa.can_edit
       FROM sample_access sa JOIN users u ON u.id=sa.user_id WHERE sa.sample_id=? ORDER BY u.role, u.full_name`).all(id);
  }

  res.json({ sample, tests, comments, events, collaborators, can_edit: !!access.can_edit });
});

app.post('/api/samples', auth, requireRole('admin', 'member'), async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const year = new Date().getFullYear();
  const n = (await db.prepare("SELECT COUNT(*) c FROM samples WHERE sample_code LIKE ?").get(`SMP-${year}-%`)).c + 1;
  const sample_code = `SMP-${year}-${String(n).padStart(4, '0')}`;
  const row = await db.prepare(`INSERT INTO samples
     (sample_code,name,description,material_type,batch_lot,origin,quantity,unit,storage_location,hazard_class,owner_org,status,custodian_id,created_by,received_at)
     VALUES (@sample_code,@name,@description,@material_type,@batch_lot,@origin,@quantity,@unit,@storage_location,@hazard_class,@owner_org,'received',@custodian_id,@uid,@received_at) RETURNING id`)
    .get({
      sample_code, name: b.name, description: b.description || null, material_type: b.material_type || null,
      batch_lot: b.batch_lot || null, origin: b.origin || null, quantity: b.quantity ?? null, unit: b.unit || null,
      storage_location: b.storage_location || null, hazard_class: b.hazard_class || 'none', owner_org: b.owner_org || null,
      custodian_id: b.custodian_id || req.user.id, uid: req.user.id,
      received_at: b.received_at || new Date().toISOString().slice(0, 10),
    });
  await logEvent(row.id, 'created', null, 'received', 'Sample logged', req.user.id);
  res.status(201).json({ id: row.id, sample_code });
});

app.put('/api/samples/:id', auth, requireRole('admin', 'member'), async (req, res) => {
  const id = req.params.id;
  const cur = await db.prepare('SELECT * FROM samples WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const fields = ['name', 'description', 'material_type', 'batch_lot', 'origin', 'quantity', 'unit', 'storage_location', 'hazard_class', 'owner_org', 'custodian_id'];
  const sets = [], args = {};
  for (const f of fields) if (f in b) { sets.push(`${f}=@${f}`); args[f] = b[f]; }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  args.id = id;
  await db.prepare(`UPDATE samples SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=@id`).run(args);
  if ('custodian_id' in b && b.custodian_id != cur.custodian_id) {
    await logEvent(id, 'transfer', String(cur.custodian_id || ''), String(b.custodian_id || ''), 'Custody transferred', req.user.id);
  } else {
    await logEvent(id, 'edit', null, null, 'Fields updated', req.user.id);
  }
  res.json({ ok: true });
});

app.post('/api/samples/:id/status', auth, requireRole('admin', 'member'), async (req, res) => {
  const id = req.params.id;
  const { to, note } = req.body || {};
  const cur = await db.prepare('SELECT status FROM samples WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const allowed = await db.prepare('SELECT 1 AS ok FROM status_transitions WHERE from_status=? AND to_status=?').get(cur.status, to);
  if (!allowed) return res.status(400).json({ error: `Transition ${cur.status} → ${to} not allowed` });
  await db.prepare("UPDATE samples SET status=?, updated_at=datetime('now') WHERE id=?").run(to, id);
  await logEvent(id, 'status_change', cur.status, to, note || null, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/samples/:id', auth, requireRole('admin'), async (req, res) => {
  const s = await db.prepare('SELECT id FROM samples WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM samples WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------
app.post('/api/samples/:id/tests', auth, requireRole('admin', 'member'), async (req, res) => {
  const id = req.params.id;
  if (!(await db.prepare('SELECT 1 AS ok FROM samples WHERE id=?').get(id))) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (!b.test_type) return res.status(400).json({ error: 'test_type required' });
  const row = await db.prepare(`INSERT INTO tests(sample_id,test_type,method,result_value,result_unit,outcome,performed_by,performed_at)
     VALUES (?,?,?,?,?,?,?,?) RETURNING id`).get(id, b.test_type, b.method || null, b.result_value || null, b.result_unit || null,
       b.outcome || 'pending', req.user.id, b.performed_at || new Date().toISOString().slice(0, 10));
  await logEvent(id, 'test_logged', null, b.test_type, `Result: ${b.result_value ?? '—'} (${b.outcome || 'pending'})`, req.user.id);
  res.status(201).json({ id: row.id });
});

// ------------------------------------------------------------------
// Comments
// ------------------------------------------------------------------
app.post('/api/samples/:id/comments', auth, async (req, res) => {
  const id = req.params.id;
  const access = await accessRow(id, req.user);
  if (!access) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (!b.body) return res.status(400).json({ error: 'body required' });
  const visibility = (b.visibility === 'internal' && isInternal(req.user)) ? 'internal' : 'shared';
  const row = await db.prepare('INSERT INTO comments(sample_id,author_id,body,visibility) VALUES (?,?,?,?) RETURNING id')
    .get(id, req.user.id, b.body, visibility);
  await logEvent(id, 'note', null, null, 'Comment added', req.user.id);
  res.status(201).json({ id: row.id });
});

// ------------------------------------------------------------------
// Partner access grants (admin only)
// ------------------------------------------------------------------
app.get('/api/samples/:id/access', auth, requireRole('admin', 'member'), async (req, res) => {
  res.json(await db.prepare(`SELECT sa.*, u.full_name, u.email, u.organization, u.role
     FROM sample_access sa JOIN users u ON u.id=sa.user_id WHERE sample_id=?`).all(req.params.id));
});
// Add a collaborator (any active user). For partners this also grants view access.
app.post('/api/samples/:id/access', auth, requireRole('admin', 'member'), async (req, res) => {
  const { user_id, can_edit } = req.body || {};
  const user = await db.prepare('SELECT id FROM users WHERE id=? AND is_active=1').get(user_id);
  if (!user) return res.status(400).json({ error: 'unknown user' });
  await db.prepare(`INSERT INTO sample_access(sample_id,user_id,can_edit,granted_by) VALUES (?,?,?,?)
     ON CONFLICT(sample_id,user_id) DO UPDATE SET can_edit=excluded.can_edit`)
    .run(req.params.id, user_id, can_edit ? 1 : 0, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/samples/:id/access/:userId', auth, requireRole('admin', 'member'), async (req, res) => {
  await db.prepare('DELETE FROM sample_access WHERE sample_id=? AND user_id=?').run(req.params.id, req.params.userId);
  res.json({ ok: true });
});

// Resolve a scanned/typed accession code to a sample id (respects access).
app.get('/api/resolve', auth, async (req, res) => {
  const code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code required' });
  const s = await db.prepare('SELECT id FROM samples WHERE sample_code=?').get(code);
  if (!s) return res.status(404).json({ error: `No sample found for code "${code}"` });
  const access = await accessRow(s.id, req.user);
  if (!access) return res.status(404).json({ error: `No sample found for code "${code}"` });
  res.json({ id: s.id });
});

// ------------------------------------------------------------------
// Stations
// ------------------------------------------------------------------
app.get('/api/stations', auth, async (req, res) => {
  res.json(await db.prepare(`SELECT st.*, s.label AS status_label
     FROM stations st LEFT JOIN statuses s ON s.code=st.set_status
     WHERE st.is_active=1 ORDER BY st.sort_order, st.label`).all());
});

app.post('/api/stations', auth, requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const code = (b.code || '').trim().toUpperCase();
  if (!code || !b.label || !b.location) return res.status(400).json({ error: 'code, label, location required' });
  if (!/^STN-[A-Z0-9-]+$/.test(code)) return res.status(400).json({ error: 'code must look like STN-TESTING' });
  if (b.set_status && !(await db.prepare('SELECT 1 AS ok FROM statuses WHERE code=?').get(b.set_status)))
    return res.status(400).json({ error: 'unknown set_status' });
  await db.prepare(`INSERT INTO stations(code,label,location,set_status,sort_order,is_active)
     VALUES (@code,@label,@location,@set_status,@sort_order,1)
     ON CONFLICT(code) DO UPDATE SET label=excluded.label, location=excluded.location,
       set_status=excluded.set_status, sort_order=excluded.sort_order, is_active=1`)
    .run({ code, label: b.label, location: b.location, set_status: b.set_status || null,
           sort_order: Number.isFinite(+b.sort_order) ? +b.sort_order : 0 });
  res.status(201).json({ ok: true, code });
});

// Scan a sample at a station (either order). Records location; advances stage when allowed.
app.post('/api/scan', auth, requireRole('admin', 'member'), async (req, res) => {
  const b = req.body || {};
  const sampleCode = (b.sample_code || '').trim();
  const stationCode = (b.station_code || '').trim().toUpperCase();
  if (!sampleCode || !stationCode) return res.status(400).json({ error: 'sample_code and station_code required' });

  const sample = await db.prepare('SELECT * FROM samples WHERE sample_code=?').get(sampleCode);
  if (!sample) return res.status(404).json({ error: `No sample found for code "${sampleCode}"` });
  const station = await db.prepare('SELECT * FROM stations WHERE code=? AND is_active=1').get(stationCode);
  if (!station) return res.status(404).json({ error: `No station found for code "${stationCode}"` });

  let handler = null;
  const handlerCode = (b.handler_code || '').trim().toUpperCase();
  if (handlerCode) {
    const m = /^USR-(\d+)$/.exec(handlerCode);
    if (m) handler = await db.prepare('SELECT id, full_name FROM users WHERE id=? AND is_active=1').get(Number(m[1]));
    if (!handler) return res.status(404).json({ error: `Unknown handler badge "${handlerCode}"` });
  }

  const labelOf = async (code) => ((await db.prepare('SELECT label FROM statuses WHERE code=?').get(code)) || {}).label || code;
  const fromStatus = sample.status;
  let toStatus = fromStatus, statusChanged = false, statusBlocked = false;

  if (station.set_status && station.set_status !== fromStatus) {
    const allowed = await db.prepare('SELECT 1 AS ok FROM status_transitions WHERE from_status=? AND to_status=?')
      .get(fromStatus, station.set_status);
    if (allowed) { toStatus = station.set_status; statusChanged = true; }
    else { statusBlocked = true; }
  }

  await db.prepare(`UPDATE samples SET current_station=?, current_location=?, status=?, updated_at=datetime('now') WHERE id=?`)
    .run(station.code, station.location, toStatus, sample.id);

  let custodyMsg = '';
  if (handler && handler.id !== sample.custodian_id) {
    await db.prepare("UPDATE samples SET custodian_id=?, updated_at=datetime('now') WHERE id=?").run(handler.id, sample.id);
    await logEvent(sample.id, 'transfer', String(sample.custodian_id || ''), String(handler.id),
      `Custody to ${handler.full_name} (badge scan)`, req.user.id);
    custodyMsg = ` Custody → ${handler.full_name}.`;
  }

  const fromLabel = await labelOf(fromStatus);
  const toLabel = await labelOf(toStatus);
  const setLabel = station.set_status ? await labelOf(station.set_status) : '';
  let message;
  if (statusChanged)      message = `Moved to ${station.label} — stage advanced to '${toLabel}'.`;
  else if (statusBlocked) message = `Logged at ${station.label}. Stage kept at '${fromLabel}' — ${fromLabel} → ${setLabel} isn't an allowed step.`;
  else                    message = `Logged at ${station.label} — already at '${fromLabel}'.`;
  message += custodyMsg;

  await logEvent(sample.id, 'scan', statusChanged ? fromStatus : null, statusChanged ? toStatus : null,
    `Scanned at ${station.label} · ${station.location}${statusBlocked ? ' — stage change skipped (not an allowed step)' : ''}`,
    req.user.id);

  res.json({
    ok: true, statusChanged, statusBlocked, fromStatus, toStatus,
    fromStatusLabel: fromLabel, toStatusLabel: toLabel, message,
    handler: handler ? { id: handler.id, name: handler.full_name } : null,
    sample: { id: sample.id, sample_code: sample.sample_code, name: sample.name },
    station: { code: station.code, label: station.label, location: station.location, set_status: station.set_status },
  });
});

// Dashboard counts by status (respects partner scoping).
app.get('/api/stats', auth, async (req, res) => {
  let sql = `SELECT s.status, st.label, COUNT(*) n FROM samples s JOIN statuses st ON st.code=s.status`;
  const args = {};
  if (!isInternal(req.user)) {
    sql += ' WHERE (s.owner_org=@porg OR EXISTS (SELECT 1 FROM sample_access sa WHERE sa.sample_id=s.id AND sa.user_id=@uid))';
    args.porg = req.user.organization || ' '; args.uid = req.user.id;
  }
  sql += ' GROUP BY s.status, st.label, st.sort_order ORDER BY st.sort_order';
  res.json(await db.prepare(sql).all(args));
});

// ------------------------------------------------------------------
// Attachments / data files
// ------------------------------------------------------------------
const RAW_LIMIT = (process.env.MAX_UPLOAD_MB || '50') + 'mb';

app.post('/api/samples/:id/attachments/presign', auth, requireRole('admin', 'member'), async (req, res) => {
  const id = req.params.id;
  if (!(await db.prepare('SELECT 1 AS ok FROM samples WHERE id=?').get(id))) return res.status(404).json({ error: 'Not found' });
  const { filename, content_type } = req.body || {};
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const key = storage.newKey(id, filename);
  const target = await storage.presignPut(key, content_type);
  res.json({ ...target, key, storage_mode: storage.mode });
});

app.put('/api/uploads/local', auth, requireRole('admin', 'member'),
  express.raw({ type: '*/*', limit: RAW_LIMIT }), (req, res) => {
    if (storage.useS3) return res.status(400).json({ error: 'local upload disabled (S3 configured)' });
    const key = req.query.key || '';
    if (!/^samples\//.test(key)) return res.status(400).json({ error: 'bad key' });
    try { storage.saveLocal(key, req.body); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: 'save failed' }); }
  });

app.post('/api/samples/:id/attachments', auth, requireRole('admin', 'member'), async (req, res) => {
  const id = req.params.id;
  if (!(await db.prepare('SELECT 1 AS ok FROM samples WHERE id=?').get(id))) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (!b.key || !b.filename) return res.status(400).json({ error: 'key and filename required' });
  const visibility = (b.visibility === 'internal') ? 'internal' : 'shared';
  const row = await db.prepare(`INSERT INTO attachments(sample_id,filename,content_type,size_bytes,storage_key,storage_mode,visibility,uploaded_by)
     VALUES (?,?,?,?,?,?,?,?) RETURNING id`).get(id, b.filename, b.content_type || null, b.size_bytes || null, b.key, storage.mode, visibility, req.user.id);
  await logEvent(id, 'attachment', null, b.filename, `Data file added: ${b.filename} (${visibility})`, req.user.id);
  res.status(201).json({ id: row.id });
});

app.get('/api/samples/:id/attachments', auth, async (req, res) => {
  const id = req.params.id;
  const access = await accessRow(id, req.user);
  if (!access) return res.status(404).json({ error: 'Not found' });
  const base = `SELECT a.id,a.filename,a.content_type,a.size_bytes,a.visibility,a.storage_mode,a.created_at,
     u.full_name AS uploader FROM attachments a LEFT JOIN users u ON u.id=a.uploaded_by WHERE a.sample_id=?`;
  const sql = isInternal(req.user) ? base + ' ORDER BY a.created_at DESC'
                                   : base + " AND a.visibility='shared' ORDER BY a.created_at DESC";
  res.json(await db.prepare(sql).all(id));
});

app.get('/api/attachments/:aid/link', auth, async (req, res) => {
  const a = await db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.aid);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const access = await accessRow(a.sample_id, req.user);
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

app.get('/api/attachments/:aid/raw', async (req, res) => {
  try { const p = jwt.verify(req.query.t || '', JWT_SECRET); if (p.s !== 'dl' || String(p.aid) !== String(req.params.aid)) throw new Error('bad'); }
  catch { return res.status(401).json({ error: 'Bad or expired download link' }); }
  const a = await db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.aid);
  if (!a || a.storage_mode !== 'local' || !storage.existsLocal(a.storage_key)) return res.status(410).json({ error: 'File not available' });
  res.setHeader('Content-Disposition', `attachment; filename="${String(a.filename || 'file').replace(/"/g, '')}"`);
  if (a.content_type) res.setHeader('Content-Type', a.content_type);
  storage.readLocalStream(a.storage_key).pipe(res);
});

app.delete('/api/attachments/:aid', auth, requireRole('admin', 'member'), async (req, res) => {
  const a = await db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.aid);
  if (!a) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
  await logEvent(a.sample_id, 'note', null, null, `Data file removed: ${a.filename}`, req.user.id);
  res.json({ ok: true });
});

// JSON error handler (so failures return JSON, not HTML).
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error' });
});

db.init()
  .then(() => app.listen(PORT, () => console.log(`iFuelTracker API + UI running on http://localhost:${PORT} [db: postgres, storage: ${storage.mode}]`)))
  .catch((e) => { console.error('Database init failed:', e.message); process.exit(1); });
