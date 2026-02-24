const express = require('express');
const cors = require('cors');
const webPush = require('web-push');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// VAPID
const VAPID_PUBLIC = 'BGUFC8p3xu8fET2cHDEZTK8bV4kpKhOXpRSokRj3REvPM36FYpg7DOSW4qf2KDM8VSZZaZzhS8RBJtsWua2v5O4';
const VAPID_PRIVATE = 'Eqf3eWehvJ0tAdDW6Qz_m0UgYhZ-zAx671_5U-6eziA';
webPush.setVapidDetails('mailto:admin@tesla-mindledge.com', VAPID_PUBLIC, VAPID_PRIVATE);

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ===== DATABASE =====
const DB_DIR = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, 'mindledge.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id TEXT UNIQUE,
    first_name TEXT, last_name TEXT, email TEXT, phone TEXT,
    buyer TEXT, geo TEXT,
    device_info TEXT DEFAULT '{}', geo_info TEXT DEFAULT '{}', utm TEXT DEFAULT '{}',
    is_pwa INTEGER DEFAULT 0, page_time INTEGER DEFAULT 0,
    referrer TEXT DEFAULT '', landing TEXT DEFAULT '', user_agent TEXT DEFAULT '',
    status TEXT DEFAULT 'new', status_updated_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    device_id TEXT, session_id TEXT,
    is_pwa INTEGER DEFAULT 0, page TEXT,
    data TEXT DEFAULT '{}',
    user_agent TEXT, screen TEXT, lang TEXT, referrer TEXT,
    ts TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ev_event ON events(event);
  CREATE INDEX IF NOT EXISTS idx_ev_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
`);

let pushStats = { totalSent: 0, totalErrors: 0, lastSentAt: null };

// ===== PUSH =====
app.post('/api/subscribe', (req, res) => {
  const s = req.body;
  if (!s?.endpoint) return res.status(400).json({ error: 'bad' });
  db.prepare('INSERT OR IGNORE INTO subs (endpoint,data) VALUES (?,?)').run(s.endpoint, JSON.stringify(s));
  res.json({ success: true, total: db.prepare('SELECT COUNT(*) as c FROM subs').get().c });
});

app.post('/api/unsubscribe', (req, res) => {
  db.prepare('DELETE FROM subs WHERE endpoint=?').run(req.body.endpoint || '');
  res.json({ success: true });
});

app.post('/api/send', async (req, res) => {
  const { title, body, icon, image, url, tag } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'title+body required' });
  const payload = JSON.stringify({ title, body, icon: icon||'/icons/icon-192x192.png', badge:'/icons/icon-96x96.png', image, url: url||'/', tag: tag||'p-'+Date.now() });
  const allSubs = db.prepare('SELECT endpoint,data FROM subs').all();
  let sent=0, errors=0; const failed=[];
  await Promise.allSettled(allSubs.map(async r => {
    try { await webPush.sendNotification(JSON.parse(r.data), payload); sent++; }
    catch(e) { errors++; if(e.statusCode===404||e.statusCode===410) failed.push(r.endpoint); }
  }));
  if (failed.length) { const d=db.prepare('DELETE FROM subs WHERE endpoint=?'); failed.forEach(e=>d.run(e)); }
  pushStats.totalSent+=sent; pushStats.totalErrors+=errors; pushStats.lastSentAt=new Date().toISOString();
  res.json({ success:true, sent, errors, cleaned:failed.length, totalSubscribers: db.prepare('SELECT COUNT(*) as c FROM subs').get().c });
});

// ===== LEADS =====
app.post('/api/lead', (req, res) => {
  const l = req.body;
  try {
    db.prepare('INSERT OR IGNORE INTO leads (lead_id,first_name,last_name,email,phone,buyer,geo,device_info,geo_info,utm,is_pwa,page_time,referrer,landing,user_agent,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      l.leadId||'TM-'+Date.now(), l.firstName||'', l.lastName||'', l.email||'', l.phone||'',
      l.buyer||'', l.geo||'',
      JSON.stringify(l.deviceInfo||{}), JSON.stringify(l.geoInfo||{}), JSON.stringify(l.utm||{}),
      l.isPWA?1:0, l.pageTime||0, l.referrer||'', l.landing||'', l.deviceInfo?.ua||'',
      l.createdAt||new Date().toISOString()
    );
    console.log(`[Lead] ${l.firstName} ${l.lastName} — ${l.email}`);
  } catch(e) { console.error('[Lead] err:', e.message); }
  res.json({ success:true, total: db.prepare('SELECT COUNT(*) as c FROM leads').get().c });
});

app.get('/api/leads', (req, res) => {
  const { buyer, geo, status, limit } = req.query;
  let sql='SELECT * FROM leads WHERE 1=1'; const p=[];
  if(buyer){sql+=' AND buyer=?';p.push(buyer);}
  if(geo){sql+=' AND geo=?';p.push(geo);}
  if(status){sql+=' AND status=?';p.push(status);}
  sql+=' ORDER BY id DESC';
  if(limit){sql+=' LIMIT ?';p.push(+limit);}
  const rows=db.prepare(sql).all(...p);
  const leads=rows.map(r=>({
    leadId:r.lead_id, firstName:r.first_name, lastName:r.last_name,
    email:r.email, phone:r.phone, buyer:r.buyer, geo:r.geo,
    deviceInfo:JSON.parse(r.device_info||'{}'), geoInfo:JSON.parse(r.geo_info||'{}'),
    utm:JSON.parse(r.utm||'{}'), isPWA:!!r.is_pwa, pageTime:r.page_time,
    referrer:r.referrer, landing:r.landing, status:r.status,
    createdAt:r.created_at, statusUpdatedAt:r.status_updated_at
  }));
  res.json({ leads, total:db.prepare('SELECT COUNT(*) as c FROM leads').get().c, filtered:leads.length });
});

app.post('/api/lead/status', (req, res) => {
  const {leadId,status}=req.body;
  const r=db.prepare("UPDATE leads SET status=?,status_updated_at=datetime('now') WHERE lead_id=?").run(status,leadId);
  res.json({ success:r.changes>0 });
});

// ===== ANALYTICS =====
app.post('/api/track', (req, res) => {
  const e=req.body;
  try {
    db.prepare('INSERT INTO events (event,device_id,session_id,is_pwa,page,data,user_agent,screen,lang,referrer,ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      e.event, e.deviceId, e.sessionId, e.isPWA?1:0, e.page,
      JSON.stringify(e), e.userAgent, e.screen, e.lang, e.referrer,
      e.timestamp||new Date().toISOString()
    );
  } catch(err){}
  res.json({ success:true });
});

app.get('/api/analytics', (req, res) => {
  const ce=(n)=>db.prepare('SELECT COUNT(*) as c FROM events WHERE event=?').get(n).c;
  const cue=(n)=>db.prepare('SELECT COUNT(DISTINCT device_id) as c FROM events WHERE event=?').get(n).c;
  const visitors=db.prepare('SELECT COUNT(DISTINCT device_id) as c FROM events').get().c;
  const sessions=db.prepare('SELECT COUNT(DISTINCT session_id) as c FROM events').get().c;
  const avgRow=db.prepare("SELECT AVG(json_extract(data,'$.timeSpent')) as a FROM events WHERE event='page_exit'").get();

  // Funnel
  const fRows=db.prepare("SELECT json_extract(data,'$.step') as s, COUNT(*) as c FROM events WHERE event='funnel_step' GROUP BY s").all();
  const fb={}; fRows.forEach(r=>{fb[r.s]=r.c;});

  // Page views
  const pvRows=db.prepare("SELECT page,COUNT(*) as c FROM events WHERE event='page_view' GROUP BY page").all();
  const pv={}; pvRows.forEach(r=>{pv[r.page||'/']=r.c;});

  // Geo
  const geo={}; 
  db.prepare("SELECT geo,COUNT(*) as c FROM leads WHERE status!='test' GROUP BY geo").all().forEach(r=>{geo[r.geo||'unknown']=r.c;});

  // Device
  const dev={};
  db.prepare("SELECT CASE WHEN user_agent LIKE '%iPhone%' OR user_agent LIKE '%iPad%' THEN 'iOS' WHEN user_agent LIKE '%Android%' THEN 'Android' WHEN user_agent LIKE '%Mobile%' THEN 'Mobile' ELSE 'Desktop' END as d, COUNT(DISTINCT device_id) as c FROM events WHERE event='page_view' GROUP BY d").all().forEach(r=>{dev[r.d]=r.c;});

  // Lead statuses
  const ls={};
  db.prepare('SELECT status,COUNT(*) as c FROM leads GROUP BY status').all().forEach(r=>{ls[r.status||'new']=r.c;});

  // Timeline 7d
  const tl={}; const now=new Date();
  for(let i=6;i>=0;i--){
    const d=new Date(now);d.setDate(d.getDate()-i);
    const k=d.toISOString().slice(0,10);
    const ds=k+'T00:00:00', de=k+'T23:59:59';
    tl[k]={
      views:db.prepare("SELECT COUNT(*) as c FROM events WHERE event='page_view' AND ts BETWEEN ? AND ?").get(ds,de).c,
      installs:db.prepare("SELECT COUNT(*) as c FROM events WHERE event='pwa_installed' AND ts BETWEEN ? AND ?").get(ds,de).c,
      leads:db.prepare("SELECT COUNT(*) as c FROM events WHERE event='funnel_step' AND json_extract(data,'$.step')='lead_complete' AND ts BETWEEN ? AND ?").get(ds,de).c,
      pwa_opens:db.prepare("SELECT COUNT(*) as c FROM events WHERE event='pwa_open' AND ts BETWEEN ? AND ?").get(ds,de).c
    };
  }

  res.json({
    overview:{
      totalVisitors:visitors, totalSessions:sessions, totalPageViews:ce('page_view'),
      installGateShown:ce('install_gate_shown'), installClicks:ce('install_click'),
      pwaInstalled:ce('pwa_installed'), pwaOpens:ce('pwa_open'), pwaResumed:ce('pwa_resumed'),
      videoPlays:ce('video_play'), videoCompleted:ce('video_complete'),
      avgTimeOnPage:Math.round(avgRow.a||0),
      totalLeads:db.prepare("SELECT COUNT(*) as c FROM leads WHERE status!='test'").get().c,
      pushSubscribers:db.prepare('SELECT COUNT(*) as c FROM subs').get().c
    },
    funnel:{
      install_gate_shown:cue('install_gate_shown'), install_click:cue('install_click'),
      pwa_installed:cue('pwa_installed'), pwa_open:cue('pwa_open'),
      name_filled:fb['name_filled']||0, phone_filled:fb['phone_filled']||0,
      lead_complete:fb['lead_complete']||0,
      video_play:cue('video_play'), video_complete:cue('video_complete')
    },
    leadStatuses:ls, geoDistribution:geo, deviceDistribution:dev, pageViews:pv, timeline:tl
  });
});

// ===== STATS =====
app.get('/api/stats', (req, res) => {
  res.json({
    subscribers:db.prepare('SELECT COUNT(*) as c FROM subs').get().c,
    totalLeads:db.prepare('SELECT COUNT(*) as c FROM leads').get().c,
    totalEvents:db.prepare('SELECT COUNT(*) as c FROM events').get().c,
    ...pushStats
  });
});

app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });

app.get('/', (req, res) => {
  res.json({
    status:'ok', db:DB_PATH,
    subs:db.prepare('SELECT COUNT(*) as c FROM subs').get().c,
    leads:db.prepare('SELECT COUNT(*) as c FROM leads').get().c,
    events:db.prepare('SELECT COUNT(*) as c FROM events').get().c
  });
});

process.on('SIGTERM',()=>{db.close();process.exit(0);});
process.on('SIGINT',()=>{db.close();process.exit(0);});

app.listen(PORT, () => {
  console.log(`\n🚀 Tesla Mindledge — Port ${PORT}`);
  console.log(`   DB: ${DB_PATH}`);
  console.log(`   Leads: ${db.prepare('SELECT COUNT(*) as c FROM leads').get().c}`);
  console.log(`   Admin: http://localhost:${PORT}/admin\n`);
});
