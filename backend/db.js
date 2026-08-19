// Database layer — PostgreSQL (Neon) via the `pg` driver.
// Keeps the app's existing SQLite-style query strings working by translating
// placeholders (`?` and `@name`) to Postgres `$n`, plus a couple of SQLite-isms
// (datetime('now'), INSERT OR IGNORE, LIKE) at call time. This keeps the whole
// migration contained to this one file.
const fs = require('fs');
const path = require('path');
const pg = require('pg');
const { Pool } = pg;
const bcrypt = require('bcryptjs');

// Return bigint (int8) columns — e.g. COUNT(*) — as JS numbers, not strings.
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const CONN = process.env.DATABASE_URL || '';
if (!CONN) console.error('[db] DATABASE_URL is not set — set it to your Postgres/Neon connection string.');
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
const pool = new Pool({
  connectionString: CONN,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 8,
});

// --- SQLite-string -> Postgres translation ---
function translate(sql, params) {
  let s = sql
    .replace(/datetime\('now'\)/gi, "to_char(now(),'YYYY-MM-DD HH24:MI:SS')")
    .replace(/\bLIKE\b/gi, 'ILIKE')
    .replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT');
  if (/\bOR\s+IGNORE\b/i.test(sql) && !/ON\s+CONFLICT/i.test(s)) s += ' ON CONFLICT DO NOTHING';

  const values = [];
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const map = {};
    s = s.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
      if (!(name in map)) { values.push(params[name]); map[name] = '$' + values.length; }
      return map[name];
    });
  } else {
    const arr = Array.isArray(params) ? params : (params === undefined ? [] : [params]);
    let i = 0;
    s = s.replace(/\?/g, () => { values.push(arr[i++]); return '$' + values.length; });
  }
  return { text: s, values };
}
function norm(p) {
  if (p.length === 1) {
    const x = p[0];
    if (x !== null && typeof x === 'object' && !Array.isArray(x)) return x; // named object
    if (Array.isArray(x)) return x;                                          // explicit array
    return [x];                                                              // single scalar
  }
  return p;                                                                  // positional spread
}
async function q(sql, params) { const { text, values } = translate(sql, params); return pool.query(text, values); }

const db = {
  prepare(sql) {
    return {
      get: async (...p) => (await q(sql, norm(p))).rows[0],
      all: async (...p) => (await q(sql, norm(p))).rows,
      run: async (...p) => { const r = await q(sql, norm(p)); return { changes: r.rowCount, rows: r.rows }; },
    };
  },
  query: (text, values) => pool.query(text, values),
  pool,
  init,
};
module.exports = db;

// ------------------------------------------------------------------
// Schema + seed
// ------------------------------------------------------------------
const STATUSES = [
  ['received',   'Received',           1, 0],
  ['registered', 'Registered',         2, 0],
  ['in_testing', 'In Testing',         3, 0],
  ['on_hold',    'On Hold',            4, 0],
  ['completed',  'Testing Complete',   5, 0],
  ['shared',     'Shared with Partner',6, 0],
  ['archived',   'Archived',           7, 1],
  ['disposed',   'Disposed',           8, 1],
  ['with_industry',     'With Industry Partner', 9,  0],
  ['in_transit_desy',   'In Transit to DESY',    10, 0],
  ['desy_storage',      'DESY Storage',          11, 0],
  ['at_beamline',       'At Beamline',           12, 0],
  ['measured',          'Measurement Done',      13, 0],
  ['in_transit_return', 'In Transit to Industry',14, 0],
  ['returned',          'Returned to Industry',  15, 0],
];
const TRANSITIONS = [
  ['received','registered'], ['registered','in_testing'], ['in_testing','on_hold'],
  ['on_hold','in_testing'],  ['in_testing','completed'],  ['completed','shared'],
  ['shared','completed'],    ['completed','archived'],    ['shared','archived'],
  ['archived','disposed'],   ['completed','disposed'],
  ['with_industry','in_transit_desy'], ['in_transit_desy','desy_storage'],
  ['desy_storage','at_beamline'],      ['at_beamline','desy_storage'],
  ['at_beamline','measured'],          ['measured','at_beamline'],
  ['measured','desy_storage'],         ['desy_storage','in_transit_return'],
  ['measured','in_transit_return'],    ['in_transit_return','returned'],
  ['returned','with_industry'],
  ['registered','with_industry'],      ['desy_storage','in_testing'],
  ['in_testing','desy_storage'],       ['returned','completed'],
];
const STATIONS = [
  ['STN-RECEIVING', 'Receiving Bench',   'Intake Room · Bench 1', 'received',   1],
  ['STN-REGISTER',  'Registration Desk', 'Intake Room · Desk 2',  'registered', 2],
  ['STN-TESTING',   'Testing Bench',     'Lab 2 · Bench A',       'in_testing', 3],
  ['STN-HOLD',      'Hold Rack',         'Lab 2 · Hold Shelf',    'on_hold',    4],
  ['STN-QA',        'QA / Completion',   'Lab 3 · QA Desk',       'completed',  5],
  ['STN-ARCHIVE',   'Archive Store',     'Store Room · Archive',  'archived',   6],
  ['STN-INDUSTRY',       'Industry Partner Site', 'Partner premises',        'with_industry',     10],
  ['STN-TRANSIT-DESY',   'In Transit to DESY',    'Courier / shipping',      'in_transit_desy',   11],
  ['STN-DESY-STORAGE',   'DESY Sample Storage',   'DESY · Sample store',     'desy_storage',      12],
  ['STN-BEAMLINE',       'Beamline',              'DESY · Beamline hutch',   'at_beamline',       13],
  ['STN-MEASURED',       'Measurement Complete',  'DESY · Beamline control', 'measured',          14],
  ['STN-TRANSIT-RETURN', 'In Transit to Industry','Courier / shipping',      'in_transit_return', 15],
  ['STN-RETURNED',       'Returned to Industry',  'Partner premises',        'returned',          16],
];

async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.pg.sql'), 'utf8');
  await pool.query(schema); // multi-statement DDL (no params) in one call

  // Idempotent column upgrades (for databases created before these columns existed).
  for (const ddl of [
    'ALTER TABLE samples ADD COLUMN IF NOT EXISTS current_location TEXT',
    'ALTER TABLE samples ADD COLUMN IF NOT EXISTS current_station TEXT',
    'ALTER TABLE samples ADD COLUMN IF NOT EXISTS owner_org TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT',
  ]) { try { await pool.query(ddl); } catch (e) { /* ignore */ } }

  const insStatus = db.prepare('INSERT OR IGNORE INTO statuses(code,label,sort_order,is_terminal) VALUES (?,?,?,?)');
  for (const s of STATUSES) await insStatus.run(...s);
  const insTrans = db.prepare('INSERT OR IGNORE INTO status_transitions(from_status,to_status) VALUES (?,?)');
  for (const t of TRANSITIONS) await insTrans.run(...t);
  const insStation = db.prepare('INSERT OR IGNORE INTO stations(code,label,location,set_status,sort_order) VALUES (?,?,?,?,?)');
  for (const s of STATIONS) await insStation.run(...s);

  const userCount = (await db.prepare('SELECT COUNT(*) n FROM users').get()).n;
  if (Number(userCount) !== 0) return;

  // ---- one-time demo seed (only when the DB is empty) ----
  const hash = (pw) => bcrypt.hashSync(pw, 10);
  const insUser = db.prepare(
    `INSERT INTO users(username,email,full_name,password_hash,role,organization)
     VALUES (?,?,?,?,?,?) RETURNING id`);
  const admin   = (await insUser.get('admin',    'admin@lab.test',    'Ana Admin',   hash('admin123'),  'admin',   null)).id;
  const member  = (await insUser.get('beamline', 'tech@lab.test',     'Tom Tech',    hash('member123'), 'member',  null)).id;
  const partner = (await insUser.get('acme',     'partner@acme.test', 'Pat Partner', hash('partner123'),'partner','Acme Materials Co.')).id;

  const insSample = db.prepare(
    `INSERT INTO samples(sample_code,name,description,material_type,batch_lot,origin,
        quantity,unit,storage_location,hazard_class,status,custodian_id,created_by,received_at)
     VALUES (@sample_code,@name,@description,@material_type,@batch_lot,@origin,
        @quantity,@unit,@storage_location,@hazard_class,@status,@custodian_id,@created_by,@received_at) RETURNING id`);
  const insEvent = db.prepare('INSERT INTO custody_events(sample_id,event_type,to_value,note,actor_id) VALUES (?,?,?,?,?)');
  const insAccess = db.prepare('INSERT INTO sample_access(sample_id,user_id,can_edit,granted_by) VALUES (?,?,?,?)');
  const insTest = db.prepare(
    `INSERT INTO tests(sample_id,test_type,method,result_value,result_unit,outcome,performed_by,performed_at)
     VALUES (?,?,?,?,?,?,?,?)`);

  const now = new Date().toISOString().slice(0, 10);
  const demo = [
    { sample_code:'SMP-2026-0001', name:'PLA filament spool A', description:'Biodegradable polymer for tensile study',
      material_type:'polymer', batch_lot:'LOT-PLA-77', origin:'Acme Materials Co.', quantity:250, unit:'g',
      storage_location:'Shelf B3', hazard_class:'none', status:'in_testing', custodian_id:member, created_by:admin, received_at:now },
    { sample_code:'SMP-2026-0002', name:'Aluminium 6061 coupon', description:'Corrosion resistance panel',
      material_type:'alloy', batch_lot:'AL-6061-12', origin:'Internal machine shop', quantity:4, unit:'pcs',
      storage_location:'Cabinet A1', hazard_class:'none', status:'completed', custodian_id:member, created_by:admin, received_at:now },
    { sample_code:'SMP-2026-0003', name:'Soil core #14', description:'Field sample, heavy-metal screen',
      material_type:'soil', batch_lot:null, origin:'Site 14, North field', quantity:500, unit:'g',
      storage_location:'Freezer -20 / Bin 7', hazard_class:'none', status:'received', custodian_id:admin, created_by:admin, received_at:now },
  ];
  const s1 = (await insSample.get(demo[0])).id;
  const s2 = (await insSample.get(demo[1])).id;
  const s3 = (await insSample.get(demo[2])).id;

  await insEvent.run(s1,'created','received','Logged into system',admin);
  await insEvent.run(s1,'status_change','in_testing','Started tensile prep',member);
  await insEvent.run(s1,'scan','in_testing','Scanned at Testing Bench · Lab 2 · Bench A',member);
  await insEvent.run(s2,'created','received','Logged into system',admin);
  await insEvent.run(s2,'status_change','completed','Corrosion panel finished',member);
  await insEvent.run(s2,'scan','completed','Scanned at QA / Completion · Lab 3 · QA Desk',member);
  await insEvent.run(s3,'created','received','Field core received',admin);

  const setLoc = db.prepare('UPDATE samples SET current_station=?, current_location=? WHERE id=?');
  await setLoc.run('STN-TESTING',   'Lab 2 · Bench A',       s1);
  await setLoc.run('STN-QA',        'Lab 3 · QA Desk',       s2);
  await setLoc.run('STN-RECEIVING', 'Intake Room · Bench 1', s3);
  await db.prepare('UPDATE samples SET owner_org=? WHERE id=?').run('Acme Materials Co.', s1);

  await insTest.run(s2,'tensile','ASTM D638','310','MPa','pass',member,now);
  await insTest.run(s2,'hardness','HRB','60','HRB','pass',member,now);
  await insTest.run(s1,'FTIR','in-house-SOP-04','match','','pending',member,now);

  await insAccess.run(s1, partner, 0, admin);
  await insAccess.run(s2, partner, 0, admin);
}
