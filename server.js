const express = require('express');
const cors = require('cors');
const webPush = require('web-push');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== FB CONVERSIONS API =====
const FB_PIXEL_ID = '2740435919629825';
const FB_ACCESS_TOKEN = 'EAAQyAUopLEUBQ1iqD56VZByViEcaMLnYc5JyFJWQXmGv2yUSkLnnmZB0pqjvZAcotchYN6f3NQiDeEGHEiWgOZCPSb7BvcTyE11IJFTpEhsFjhG8YmiDV7Fc7xwCUPeSzfSlZCpZB6ZCeb4t4tWMilpZC6uLiJaiJGWFZBlWoXIe0k1MVtKScc2kHLtZCZC3B21QQZDZD';
const FB_API_VERSION = 'v21.0';
const FB_TEST_CODE = ''; // set test code for debugging, empty for production

async function sendFBEvent(eventName, eventId, userData, customData, eventUrl, actionSource = 'website') {
  const hashedData = {};
  if (userData.em) hashedData.em = [crypto.createHash('sha256').update(userData.em.toLowerCase().trim()).digest('hex')];
  if (userData.ph) hashedData.ph = [crypto.createHash('sha256').update(userData.ph.replace(/\D/g, '')).digest('hex')];
  if (userData.fn) hashedData.fn = [crypto.createHash('sha256').update(userData.fn.toLowerCase().trim()).digest('hex')];
  if (userData.ln) hashedData.ln = [crypto.createHash('sha256').update(userData.ln.toLowerCase().trim()).digest('hex')];
  if (userData.client_ip_address) hashedData.client_ip_address = userData.client_ip_address;
  if (userData.client_user_agent) hashedData.client_user_agent = userData.client_user_agent;
  if (userData.fbc) hashedData.fbc = userData.fbc;
  if (userData.fbp) hashedData.fbp = userData.fbp;
  if (userData.external_id) hashedData.external_id = [crypto.createHash('sha256').update(userData.external_id).digest('hex')];

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      event_source_url: eventUrl || '',
      action_source: actionSource,
      user_data: hashedData,
      custom_data: customData || {}
    }]
  };
  if (FB_TEST_CODE) payload.test_event_code = FB_TEST_CODE;

  try {
    const resp = await fetch(`https://graph.facebook.com/${FB_API_VERSION}/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await resp.json();
    console.log(`[FB CAPI] ${eventName} (${eventId}):`, result);
    return result;
  } catch (e) {
    console.error(`[FB CAPI] Error:`, e.message);
    return { error: e.message };
  }
}

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
  
  CREATE TABLE IF NOT EXISTS push_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    image TEXT DEFAULT '',
    url TEXT DEFAULT '/',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blacklisted_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT UNIQUE NOT NULL,
    label TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS theft_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    url TEXT DEFAULT '',
    referrer TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
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
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
  
  // Skip if IP is blacklisted
  const blocked = db.prepare('SELECT 1 FROM blacklisted_ips WHERE ip=?').get(clientIp);
  if (blocked) return res.json({ success:true, filtered:true });
  
  try {
    db.prepare('INSERT INTO events (event,device_id,session_id,is_pwa,page,data,user_agent,screen,lang,referrer,ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      e.event, e.deviceId, e.sessionId, e.isPWA?1:0, e.page,
      JSON.stringify({ ...e, ip: clientIp }), e.userAgent, e.screen, e.lang, e.referrer,
      e.timestamp||new Date().toISOString()
    );
  } catch(err){}
  res.json({ success:true });
});

app.get('/api/analytics', (req, res) => {
  const period = req.query.period || 'all'; // today, yesterday, 7d, 30d, month, year, all
  
  // Calculate date range
  const now = new Date();
  let dateFrom = null, dateTo = null;
  
  if (period === 'today') {
    dateFrom = now.toISOString().slice(0,10) + 'T00:00:00';
    dateTo = now.toISOString().slice(0,10) + 'T23:59:59';
  } else if (period === 'yesterday') {
    const y = new Date(now); y.setDate(y.getDate()-1);
    dateFrom = y.toISOString().slice(0,10) + 'T00:00:00';
    dateTo = y.toISOString().slice(0,10) + 'T23:59:59';
  } else if (period === '7d') {
    const d = new Date(now); d.setDate(d.getDate()-6);
    dateFrom = d.toISOString().slice(0,10) + 'T00:00:00';
    dateTo = now.toISOString().slice(0,10) + 'T23:59:59';
  } else if (period === '30d') {
    const d = new Date(now); d.setDate(d.getDate()-29);
    dateFrom = d.toISOString().slice(0,10) + 'T00:00:00';
    dateTo = now.toISOString().slice(0,10) + 'T23:59:59';
  } else if (period === 'month') {
    // Previous calendar month
    const d = new Date(now.getFullYear(), now.getMonth()-1, 1);
    dateFrom = d.toISOString().slice(0,10) + 'T00:00:00';
    const e = new Date(now.getFullYear(), now.getMonth(), 0);
    dateTo = e.toISOString().slice(0,10) + 'T23:59:59';
  } else if (period === 'year') {
    dateFrom = now.getFullYear() + '-01-01T00:00:00';
    dateTo = now.getFullYear() + '-12-31T23:59:59';
  }
  // 'all' = no date filter
  
  // Build WHERE clause for events
  const ewhere = dateFrom ? " AND ts BETWEEN '"+dateFrom+"' AND '"+dateTo+"'" : '';
  const lwhere = dateFrom ? " AND created_at BETWEEN '"+dateFrom+"' AND '"+dateTo+"'" : '';
  
  // Get blacklisted IPs for device_id exclusion
  const blackIps = db.prepare('SELECT ip FROM blacklisted_ips').all().map(r=>r.ip);
  
  // Find device_ids from blacklisted IPs to exclude from stats
  let deviceExclude = '';
  if (blackIps.length) {
    const placeholders = blackIps.map(()=>'?').join(',');
    const blackDevices = db.prepare(`SELECT DISTINCT device_id FROM events WHERE json_extract(data,'$.ip') IN (${placeholders})`).all(...blackIps).map(r=>r.device_id).filter(Boolean);
    if (blackDevices.length) {
      deviceExclude = " AND device_id NOT IN ('" + blackDevices.join("','") + "')";
    }
  }
  
  const ef = ewhere + deviceExclude; // events filter
  
  const ce=(n)=>db.prepare('SELECT COUNT(*) as c FROM events WHERE event=?'+ef).get(n).c;
  const cue=(n)=>db.prepare('SELECT COUNT(DISTINCT device_id) as c FROM events WHERE event=?'+ef).get(n).c;
  const visitors=db.prepare('SELECT COUNT(DISTINCT device_id) as c FROM events WHERE 1=1'+ef).get().c;
  const sessions=db.prepare('SELECT COUNT(DISTINCT session_id) as c FROM events WHERE 1=1'+ef).get().c;
  const avgRow=db.prepare("SELECT AVG(json_extract(data,'$.timeSpent')) as a FROM events WHERE event='page_exit'"+ef).get();

  // Funnel steps from events
  const fRows=db.prepare("SELECT json_extract(data,'$.step') as s, COUNT(*) as c FROM events WHERE event='funnel_step'"+ef+" GROUP BY s").all();
  const fb={}; fRows.forEach(r=>{fb[r.s]=r.c;});
  
  // Override lead-related funnel counts using leads table (excluding test)
  const nonTestLeads = db.prepare("SELECT COUNT(*) as c FROM leads WHERE status!='test'"+lwhere).get().c;
  fb['lead_complete'] = nonTestLeads;
  fb['name_filled'] = nonTestLeads;
  fb['phone_filled'] = nonTestLeads;

  // Page views
  const pvRows=db.prepare("SELECT page,COUNT(*) as c FROM events WHERE event='page_view'"+ef+" GROUP BY page").all();
  const pv={}; pvRows.forEach(r=>{pv[r.page||'/']=r.c;});

  // Geo
  const geo={}; 
  db.prepare("SELECT geo,COUNT(*) as c FROM leads WHERE status!='test'"+lwhere+" GROUP BY geo").all().forEach(r=>{geo[r.geo||'unknown']=r.c;});

  // Device
  const dev={};
  db.prepare("SELECT CASE WHEN user_agent LIKE '%iPhone%' OR user_agent LIKE '%iPad%' THEN 'iOS' WHEN user_agent LIKE '%Android%' THEN 'Android' WHEN user_agent LIKE '%Mobile%' THEN 'Mobile' ELSE 'Desktop' END as d, COUNT(DISTINCT device_id) as c FROM events WHERE event='page_view'"+ef+" GROUP BY d").all().forEach(r=>{dev[r.d]=r.c;});

  // Lead statuses (exclude test completely)
  const ls={};
  db.prepare("SELECT status,COUNT(*) as c FROM leads WHERE status!='test'"+lwhere+" GROUP BY status").all().forEach(r=>{ls[r.status||'new']=r.c;});

  // Timeline — dynamic based on period
  const tl={};
  let tlDays = 7;
  if (period === 'today' || period === 'yesterday') tlDays = 1;
  else if (period === '7d') tlDays = 7;
  else if (period === '30d' || period === 'month') tlDays = 30;
  else if (period === 'year') tlDays = 12; // months
  else tlDays = 7; // all → last 7 days
  
  if (period === 'year') {
    // Monthly timeline for year
    for (let i=0; i<12; i++) {
      const m = new Date(now.getFullYear(), i, 1);
      const mEnd = new Date(now.getFullYear(), i+1, 0);
      const k = m.toISOString().slice(0,7); // YYYY-MM
      const ds = m.toISOString().slice(0,10)+'T00:00:00';
      const de = mEnd.toISOString().slice(0,10)+'T23:59:59';
      tl[k]={
        views:db.prepare("SELECT COUNT(*) as c FROM events WHERE event='page_view' AND ts BETWEEN ? AND ?"+deviceExclude).get(ds,de).c,
        installs:db.prepare("SELECT COUNT(*) as c FROM events WHERE event='pwa_installed' AND ts BETWEEN ? AND ?"+deviceExclude).get(ds,de).c,
        leads:db.prepare("SELECT COUNT(*) as c FROM leads WHERE status!='test' AND created_at BETWEEN ? AND ?").get(ds,de).c,
        pwa_opens:db.prepare("SELECT COUNT(*) as c FROM events WHERE event='pwa_open' AND ts BETWEEN ? AND ?"+deviceExclude).get(ds,de).c
      };
    }
  } else {
    const startDate = period === 'yesterday' ? new Date(now.getTime()-86400000) : (dateFrom ? new Date(dateFrom) : new Date(now.getTime()-6*86400000));
    const endDate = period === 'yesterday' ? new Date(now.getTime()-86400000) : now;
    const dayCount = Math.min(Math.ceil((endDate-startDate)/86400000)+1, 31);
    for (let i=0; i<dayCount; i++) {
      const d = new Date(startDate); d.setDate(d.getDate()+i);
      const k = d.toISOString().slice(0,10);
      const ds=k+'T00:00:00', de=k+'T23:59:59';
      tl[k]={
        views:db.prepare("SELECT COUNT(*) as c FROM events WHERE event='page_view' AND ts BETWEEN ? AND ?"+deviceExclude).get(ds,de).c,
        installs:db.prepare("SELECT COUNT(*) as c FROM events WHERE event='pwa_installed' AND ts BETWEEN ? AND ?"+deviceExclude).get(ds,de).c,
        leads:db.prepare("SELECT COUNT(*) as c FROM leads WHERE status!='test' AND created_at BETWEEN ? AND ?").get(ds,de).c,
        pwa_opens:db.prepare("SELECT COUNT(*) as c FROM events WHERE event='pwa_open' AND ts BETWEEN ? AND ?"+deviceExclude).get(ds,de).c
      };
    }
  }

  res.json({
    period,
    overview:{
      totalVisitors:visitors, totalSessions:sessions, totalPageViews:ce('page_view'),
      installGateShown:ce('install_gate_shown'), installClicks:ce('install_click'),
      pwaInstalled:ce('pwa_installed'), pwaOpens:ce('pwa_open'), pwaResumed:ce('pwa_resumed'),
      videoPlays:ce('video_play'), videoCompleted:ce('video_complete'),
      avgTimeOnPage:Math.round(avgRow.a||0),
      totalLeads:db.prepare("SELECT COUNT(*) as c FROM leads WHERE status!='test'"+lwhere).get().c,
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

// ===== FB CONVERSIONS API ENDPOINT =====
app.post('/api/fb-event', async (req, res) => {
  const { eventName, eventId, userData, customData, eventUrl } = req.body;
  if (!eventName || !eventId) return res.status(400).json({ error: 'eventName + eventId required' });
  
  // Add server-side IP and UA if not provided
  const enrichedUserData = { ...userData };
  if (!enrichedUserData.client_ip_address) {
    enrichedUserData.client_ip_address = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  }
  if (!enrichedUserData.client_user_agent) {
    enrichedUserData.client_user_agent = req.headers['user-agent'];
  }
  
  const result = await sendFBEvent(eventName, eventId, enrichedUserData, customData, eventUrl);
  res.json({ success: true, fb: result });
});

// ===== RESET STATS =====
app.post('/api/reset-stats', (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'подтвердить') return res.status(400).json({ error: 'Type подтвердить to confirm' });
  
  // Backup events count before delete
  const count = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
  
  // Copy events to backup table
  db.exec(`
    DROP TABLE IF EXISTS events_backup;
    CREATE TABLE events_backup AS SELECT * FROM events;
  `);
  
  // Clear events only (NOT leads, NOT subs)
  db.prepare('DELETE FROM events').run();
  
  console.log(`[RESET] Events cleared (${count} backed up to events_backup)`);
  res.json({ success: true, cleared: count });
});

app.post('/api/restore-stats', (req, res) => {
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events_backup'").get();
    if (!has) return res.status(400).json({ error: 'No backup found' });
    
    const count = db.prepare('SELECT COUNT(*) as c FROM events_backup').get().c;
    db.exec('INSERT INTO events SELECT * FROM events_backup');
    db.exec('DROP TABLE events_backup');
    
    console.log(`[RESTORE] ${count} events restored`);
    res.json({ success: true, restored: count });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup-status', (req, res) => {
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events_backup'").get();
    if (!has) return res.json({ hasBackup: false });
    const count = db.prepare('SELECT COUNT(*) as c FROM events_backup').get().c;
    res.json({ hasBackup: true, count });
  } catch(e) { res.json({ hasBackup: false }); }
});

// ===== IP BLACKLIST =====
app.get('/api/blacklist', (req, res) => {
  const ips = db.prepare('SELECT * FROM blacklisted_ips ORDER BY id DESC').all();
  res.json({ ips });
});

app.post('/api/blacklist', (req, res) => {
  const { ip, label } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });
  try {
    db.prepare('INSERT OR IGNORE INTO blacklisted_ips (ip,label) VALUES (?,?)').run(ip.trim(), label || '');
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/blacklist/:id', (req, res) => {
  db.prepare('DELETE FROM blacklisted_ips WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Get my IP (helper for admin)
app.get('/api/my-ip', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
  res.json({ ip });
});

// ===== PUSH TEMPLATES =====
app.get('/api/templates', (req, res) => {
  const templates = db.prepare('SELECT * FROM push_templates ORDER BY id DESC').all();
  res.json({ templates });
});

app.post('/api/templates', (req, res) => {
  const { name, title, body, image, url } = req.body;
  if (!name || !title || !body) return res.status(400).json({ error: 'name, title, body required' });
  db.prepare('INSERT INTO push_templates (name,title,body,image,url) VALUES (?,?,?,?,?)').run(name, title, body, image || '', url || '/');
  res.json({ success: true });
});

app.delete('/api/templates/:id', (req, res) => {
  db.prepare('DELETE FROM push_templates WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ===== THEFT DETECTION =====
app.get('/api/theft', (req, res) => {
  const { d, u, r, t } = req.query;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
  const ua = req.headers['user-agent'] || '';
  
  if (d) {
    db.prepare('INSERT INTO theft_alerts (domain,url,referrer,ip,user_agent) VALUES (?,?,?,?,?)').run(d, u||'', r||'', ip, ua);
    console.log(`\n🚨 [THEFT ALERT] Domain: ${d} | IP: ${ip} | URL: ${u}\n`);
  }
  
  // Return 1x1 transparent pixel
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': pixel.length, 'Cache-Control': 'no-store' });
  res.end(pixel);
});

app.get('/api/theft-alerts', (req, res) => {
  const alerts = db.prepare('SELECT * FROM theft_alerts ORDER BY id DESC LIMIT 100').all();
  res.json({ alerts, total: db.prepare('SELECT COUNT(*) as c FROM theft_alerts').get().c });
});

app.delete('/api/theft-alerts', (req, res) => {
  db.prepare('DELETE FROM theft_alerts').run();
  res.json({ success: true });
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
