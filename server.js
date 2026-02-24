const express = require('express');
const cors = require('cors');
const webPush = require('web-push');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== VAPID CONFIG =====
const VAPID_PUBLIC_KEY = 'BGUFC8p3xu8fET2cHDEZTK8bV4kpKhOXpRSokRj3REvPM36FYpg7DOSW4qf2KDM8VSZZaZzhS8RBJtsWua2v5O4';
const VAPID_PRIVATE_KEY = 'Eqf3eWehvJ0tAdDW6Qz_m0UgYhZ-zAx671_5U-6eziA';

webPush.setVapidDetails('mailto:admin@tesla-mindledge.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ===== FILE-BASED STORAGE =====
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadJSON(file, fallback = []) {
  const p = path.join(DATA_DIR, file);
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback; }
  catch (e) { return fallback; }
}

function saveJSON(file, data) {
  try { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2)); }
  catch (e) { console.error(`Save error ${file}:`, e); }
}

// ===== DATA STORES =====
let subscriptions = loadJSON('subscriptions.json', []);
let leads = loadJSON('leads.json', []);
let events = loadJSON('events.json', []);

let pushStats = { totalSent: 0, totalErrors: 0, lastSentAt: null };

// ===== PUSH ENDPOINTS =====

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  if (!subscriptions.find(s => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
    saveJSON('subscriptions.json', subscriptions);
  }
  res.json({ success: true, total: subscriptions.length });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  saveJSON('subscriptions.json', subscriptions);
  res.json({ success: true, total: subscriptions.length });
});

app.post('/api/send', async (req, res) => {
  const { title, body, icon, image, url, tag } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and body required' });

  const payload = JSON.stringify({
    title, body,
    icon: icon || '/icons/icon-192x192.png',
    badge: '/icons/icon-96x96.png',
    image: image || undefined,
    url: url || '/',
    tag: tag || 'push-' + Date.now()
  });

  let sent = 0, errors = 0;
  const failed = [];

  await Promise.allSettled(subscriptions.map(async (sub) => {
    try { await webPush.sendNotification(sub, payload); sent++; }
    catch (err) {
      errors++;
      if (err.statusCode === 404 || err.statusCode === 410) failed.push(sub.endpoint);
    }
  }));

  if (failed.length > 0) {
    subscriptions = subscriptions.filter(s => !failed.includes(s.endpoint));
    saveJSON('subscriptions.json', subscriptions);
  }

  pushStats.totalSent += sent;
  pushStats.totalErrors += errors;
  pushStats.lastSentAt = new Date().toISOString();

  res.json({ success: true, sent, errors, cleaned: failed.length, totalSubscribers: subscriptions.length });
});

// ===== LEAD ENDPOINTS =====

app.post('/api/lead', (req, res) => {
  const lead = { ...req.body, receivedAt: new Date().toISOString(), status: 'new' };
  leads.push(lead);
  saveJSON('leads.json', leads);
  console.log(`[Lead] New: ${lead.firstName} ${lead.lastName} — ${lead.email} — Buyer: ${lead.buyer}`);
  res.json({ success: true, total: leads.length });
});

app.get('/api/leads', (req, res) => {
  const { buyer, geo, status, from, to, limit } = req.query;
  let filtered = [...leads];
  if (buyer) filtered = filtered.filter(l => l.buyer === buyer);
  if (geo) filtered = filtered.filter(l => l.geo === geo);
  if (status) filtered = filtered.filter(l => l.status === status);
  if (from) filtered = filtered.filter(l => l.createdAt >= from);
  if (to) filtered = filtered.filter(l => l.createdAt <= to);
  filtered.reverse(); // newest first
  if (limit) filtered = filtered.slice(0, parseInt(limit));
  res.json({ leads: filtered, total: leads.length, filtered: filtered.length });
});

app.post('/api/lead/status', (req, res) => {
  const { leadId, status } = req.body;
  const lead = leads.find(l => l.leadId === leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  lead.status = status;
  lead.statusUpdatedAt = new Date().toISOString();
  saveJSON('leads.json', leads);
  res.json({ success: true });
});

// ===== ANALYTICS ENDPOINTS =====

app.post('/api/track', (req, res) => {
  const event = { ...req.body, receivedAt: new Date().toISOString() };
  events.push(event);
  // Save every 10 events to reduce disk writes
  if (events.length % 10 === 0) saveJSON('events.json', events);
  res.json({ success: true });
});

app.get('/api/analytics', (req, res) => {
  const { from, to } = req.query;
  let filtered = [...events];
  if (from) filtered = filtered.filter(e => e.timestamp >= from);
  if (to) filtered = filtered.filter(e => e.timestamp <= to);

  // Aggregate stats
  const uniqueDevices = new Set(filtered.map(e => e.deviceId).filter(Boolean));
  const uniqueSessions = new Set(filtered.map(e => e.sessionId).filter(Boolean));

  const countEvent = (name) => filtered.filter(e => e.event === name).length;
  const countUniqueEvent = (name) => new Set(filtered.filter(e => e.event === name).map(e => e.deviceId)).size;

  // Funnel steps
  const funnelSteps = filtered.filter(e => e.event === 'funnel_step');
  const funnelByStep = {};
  funnelSteps.forEach(e => {
    const step = e.step || 'unknown';
    funnelByStep[step] = (funnelByStep[step] || 0) + 1;
  });

  // Platform actions
  const platformActions = filtered.filter(e => e.event === 'platform_action');
  const actionCounts = {};
  platformActions.forEach(e => {
    const a = e.action || 'unknown';
    actionCounts[a] = (actionCounts[a] || 0) + 1;
  });

  // Page views by page
  const pageViews = {};
  filtered.filter(e => e.event === 'page_view').forEach(e => {
    const p = e.page || '/';
    pageViews[p] = (pageViews[p] || 0) + 1;
  });

  // Time on page averages
  const exitEvents = filtered.filter(e => e.event === 'page_exit' && e.timeSpent);
  const avgTimeOnPage = exitEvents.length > 0
    ? Math.round(exitEvents.reduce((sum, e) => sum + e.timeSpent, 0) / exitEvents.length)
    : 0;

  // Geo distribution from leads
  const geoDistribution = {};
  leads.forEach(l => {
    const country = l.geoInfo?.country || l.geo || 'unknown';
    geoDistribution[country] = (geoDistribution[country] || 0) + 1;
  });

  // Device distribution
  const deviceDistribution = {};
  const uniqueDeviceEvents = {};
  filtered.filter(e => e.event === 'page_view').forEach(e => {
    if (!uniqueDeviceEvents[e.deviceId]) {
      uniqueDeviceEvents[e.deviceId] = true;
      const ua = e.userAgent || '';
      let dev = 'Desktop';
      if (/iPhone|iPad/.test(ua)) dev = 'iOS';
      else if (/Android/.test(ua)) dev = 'Android';
      else if (/Mobile/.test(ua)) dev = 'Mobile Other';
      deviceDistribution[dev] = (deviceDistribution[dev] || 0) + 1;
    }
  });

  // Lead statuses
  const leadStatuses = {};
  leads.forEach(l => {
    const s = l.status || 'new';
    leadStatuses[s] = (leadStatuses[s] || 0) + 1;
  });

  // Events timeline (last 7 days, by day)
  const timeline = {};
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    timeline[key] = { views: 0, installs: 0, leads: 0, pwa_opens: 0 };
  }
  filtered.forEach(e => {
    const day = (e.timestamp || e.receivedAt || '').slice(0, 10);
    if (timeline[day]) {
      if (e.event === 'page_view') timeline[day].views++;
      if (e.event === 'pwa_installed') timeline[day].installs++;
      if (e.event === 'funnel_step' && e.step === 'lead_complete') timeline[day].leads++;
      if (e.event === 'pwa_open') timeline[day].pwa_opens++;
    }
  });

  res.json({
    overview: {
      totalVisitors: uniqueDevices.size,
      totalSessions: uniqueSessions.size,
      totalPageViews: countEvent('page_view'),
      installGateShown: countEvent('install_gate_shown'),
      installClicks: countEvent('install_click'),
      pwaInstalled: countEvent('pwa_installed'),
      pwaOpens: countEvent('pwa_open'),
      pwaResumed: countEvent('pwa_resumed'),
      videoPlays: countEvent('video_play'),
      videoCompleted: countEvent('video_complete'),
      avgTimeOnPage,
      totalLeads: leads.length,
      pushSubscribers: subscriptions.length
    },
    funnel: {
      install_gate_shown: countUniqueEvent('install_gate_shown'),
      install_click: countUniqueEvent('install_click'),
      pwa_installed: countUniqueEvent('pwa_installed'),
      pwa_open: countUniqueEvent('pwa_open'),
      name_filled: funnelByStep['name_filled'] || 0,
      phone_filled: funnelByStep['phone_filled'] || 0,
      lead_complete: funnelByStep['lead_complete'] || 0,
      video_play: countUniqueEvent('video_play'),
      video_complete: countUniqueEvent('video_complete')
    },
    leadStatuses,
    geoDistribution,
    deviceDistribution,
    pageViews,
    timeline
  });
});

// Force save on interval
setInterval(() => { saveJSON('events.json', events); }, 60000);

// ===== STATS =====
app.get('/api/stats', (req, res) => {
  res.json({
    subscribers: subscriptions.length,
    totalLeads: leads.length,
    totalEvents: events.length,
    totalSent: pushStats.totalSent,
    totalErrors: pushStats.totalErrors,
    lastSentAt: pushStats.lastSentAt
  });
});

// ===== ADMIN PANEL =====
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });

// ===== HEALTH =====
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Tesla Mindledge Backend', subscribers: subscriptions.length, leads: leads.length, events: events.length });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Tesla Mindledge Backend — Port ${PORT}`);
  console.log(`   Subscribers: ${subscriptions.length} | Leads: ${leads.length} | Events: ${events.length}`);
  console.log(`   Admin: http://localhost:${PORT}/admin\n`);
});
