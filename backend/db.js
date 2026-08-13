// Database bootstrap: opens SQLite, applies schema, seeds reference + demo data.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite'); // built into Node — no native build needed
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'sampletrack.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Apply schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Idempotent column upgrades for databases created before stations existed.
for (const ddl of [
  'ALTER TABLE samples ADD COLUMN current_location TEXT',
  'ALTER TABLE samples ADD COLUMN current_station TEXT',
]) { try { db.exec(ddl); } catch (e) { /* column already present */ } }

// ---- Seed status workflow (idempotent) ----
const STATUSES = [
  ['received',   'Received',           1, 0],
  ['registered', 'Registered',         2, 0],
  ['in_testing', 'In Testing',         3, 0],
  ['on_hold',    'On Hold',            4, 0],
  ['completed',  'Testing Complete',   5, 0],
  ['shared',     'Shared with Partner',6, 0],
  ['archived',   'Archived',           7, 1],
  ['disposed',   'Disposed',           8, 1],
  // DESY <-> industry logistics journey (added alongside the lab workflow)
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
  // DESY <-> industry logistics journey
  ['with_industry','in_transit_desy'], ['in_transit_desy','desy_storage'],
  ['desy_storage','at_beamline'],      ['at_beamline','desy_storage'],
  ['at_beamline','measured'],          ['measured','at_beamline'],
  ['measured','desy_storage'],         ['desy_storage','in_transit_return'],
  ['measured','in_transit_return'],    ['in_transit_return','returned'],
  ['returned','with_industry'],
  // bridges between the lab workflow and the logistics journey
  ['registered','with_industry'],      ['desy_storage','in_testing'],
  ['in_testing','desy_storage'],       ['returned','completed'],
];

const insStatus = db.prepare(
  'INSERT OR IGNORE INTO statuses(code,label,sort_order,is_terminal) VALUES (?,?,?,?)');
STATUSES.forEach(s => insStatus.run(...s));
const insTrans = db.prepare(
  'INSERT OR IGNORE INTO status_transitions(from_status,to_status) VALUES (?,?)');
TRANSITIONS.forEach(t => insTrans.run(...t));

// ---- Seed stations / designated spots (idempotent) ----
// Each spot has a printable QR. Scanning a sample here sets its location and,
// where set_status is given, advances its lifecycle stage. Order mirrors the
// status workflow so scanning spot-to-spot follows the allowed transitions.
const STATIONS = [
  ['STN-RECEIVING', 'Receiving Bench',   'Intake Room · Bench 1', 'received',   1],
  ['STN-REGISTER',  'Registration Desk', 'Intake Room · Desk 2',  'registered', 2],
  ['STN-TESTING',   'Testing Bench',     'Lab 2 · Bench A',       'in_testing', 3],
  ['STN-HOLD',      'Hold Rack',         'Lab 2 · Hold Shelf',    'on_hold',    4],
  ['STN-QA',        'QA / Completion',   'Lab 3 · QA Desk',       'completed',  5],
  ['STN-ARCHIVE',   'Archive Store',     'Store Room · Archive',  'archived',   6],
  // DESY <-> industry logistics spots
  ['STN-INDUSTRY',       'Industry Partner Site', 'Partner premises',        'with_industry',     10],
  ['STN-TRANSIT-DESY',   'In Transit to DESY',    'Courier / shipping',      'in_transit_desy',   11],
  ['STN-DESY-STORAGE',   'DESY Sample Storage',   'DESY · Sample store',     'desy_storage',      12],
  ['STN-BEAMLINE',       'Beamline',              'DESY · Beamline hutch',   'at_beamline',       13],
  ['STN-MEASURED',       'Measurement Complete',  'DESY · Beamline control', 'measured',          14],
  ['STN-TRANSIT-RETURN', 'In Transit to Industry','Courier / shipping',      'in_transit_return', 15],
  ['STN-RETURNED',       'Returned to Industry',  'Partner premises',        'returned',          16],
];
const insStation = db.prepare(
  'INSERT OR IGNORE INTO stations(code,label,location,set_status,sort_order) VALUES (?,?,?,?,?)');
STATIONS.forEach(s => insStation.run(...s));

// ---- Seed demo users + samples only if the DB is empty ----
const userCount = db.prepare('SELECT COUNT(*) n FROM users').get().n;
if (userCount === 0) {
  const hash = (pw) => bcrypt.hashSync(pw, 10);
  const insUser = db.prepare(
    `INSERT INTO users(email,full_name,password_hash,role,organization)
     VALUES (?,?,?,?,?)`);
  const admin  = insUser.run('admin@lab.test',   'Ana Admin',   hash('admin123'),  'admin',  null).lastInsertRowid;
  const member = insUser.run('tech@lab.test',    'Tom Tech',    hash('member123'), 'member', null).lastInsertRowid;
  const partner= insUser.run('partner@acme.test','Pat Partner', hash('partner123'),'partner','Acme Materials Co.').lastInsertRowid;

  const insSample = db.prepare(
    `INSERT INTO samples(sample_code,name,description,material_type,batch_lot,origin,
        quantity,unit,storage_location,hazard_class,status,custodian_id,created_by,received_at)
     VALUES (@sample_code,@name,@description,@material_type,@batch_lot,@origin,
        @quantity,@unit,@storage_location,@hazard_class,@status,@custodian_id,@created_by,@received_at)`);
  const insEvent = db.prepare(
    `INSERT INTO custody_events(sample_id,event_type,to_value,note,actor_id)
     VALUES (?,?,?,?,?)`);
  const insAccess = db.prepare(
    `INSERT INTO sample_access(sample_id,user_id,can_edit,granted_by) VALUES (?,?,?,?)`);
  const insTest = db.prepare(
    `INSERT INTO tests(sample_id,test_type,method,result_value,result_unit,outcome,performed_by,performed_at)
     VALUES (?,?,?,?,?,?,?,?)`);

  const now = new Date().toISOString().slice(0,10);
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
  const s1 = insSample.run(demo[0]).lastInsertRowid;
  const s2 = insSample.run(demo[1]).lastInsertRowid;
  const s3 = insSample.run(demo[2]).lastInsertRowid;

  insEvent.run(s1,'created','received','Logged into system',admin);
  insEvent.run(s1,'status_change','in_testing','Started tensile prep',member);
  insEvent.run(s1,'scan','in_testing','Scanned at Testing Bench · Lab 2 · Bench A',member);
  insEvent.run(s2,'created','received','Logged into system',admin);
  insEvent.run(s2,'status_change','completed','Corrosion panel finished',member);
  insEvent.run(s2,'scan','completed','Scanned at QA / Completion · Lab 3 · QA Desk',member);
  insEvent.run(s3,'created','received','Field core received',admin);

  // Record where each demo sample physically sits now (last station scan).
  const setLoc = db.prepare('UPDATE samples SET current_station=?, current_location=? WHERE id=?');
  setLoc.run('STN-TESTING',   'Lab 2 · Bench A',       s1);
  setLoc.run('STN-QA',        'Lab 3 · QA Desk',       s2);
  setLoc.run('STN-RECEIVING', 'Intake Room · Bench 1', s3);

  insTest.run(s2,'tensile','ASTM D638','310','MPa','pass',member,now);
  insTest.run(s2,'hardness','HRB','60','HRB','pass',member,now);
  insTest.run(s1,'FTIR','in-house-SOP-04','match','','pending',member,now);

  // Share sample 1 (and its completed sibling) with the partner, read-only
  insAccess.run(s1, partner, 0, admin);
  insAccess.run(s2, partner, 0, admin);
}

module.exports = db;
