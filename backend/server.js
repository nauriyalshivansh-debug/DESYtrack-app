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

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3000;

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
  res.json({ token: sign(user), user: { id: user.id, name: user.full_name, role: user.role, organization: user.organization } });
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
  const sample = db.prepare(`SELECT s.*, st.label AS status_label, u.full_name AS custodian_name
     FROM samples s JOIN statuses st ON st.code=s.status
     LEFT JOIN users u ON u.id=s.custodian_id WHERE s.id=?`).get(id);
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

// Dashboard counts by status (respects partner scoping).
app.get('/api/stats', auth, (req, res) => {
  let sql = `SELECT s.status, st.label, COUNT(*) n FROM samples s JOIN statuses st ON st.code=s.status`;
  const args = {};
  if (!isInternal(req.user)) { sql += ' JOIN sample_access sa ON sa.sample_id=s.id AND sa.user_id=@uid'; args.uid = req.user.id; }
  sql += ' GROUP BY s.status ORDER BY st.sort_order';
  res.json(db.prepare(sql).all(args));
});

app.listen(PORT, () => console.log(`DESYtrack API + UI running on http://localhost:${PORT}`));
