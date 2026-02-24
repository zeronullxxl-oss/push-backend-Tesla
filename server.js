const express = require('express');
const cors = require('cors');
const webPush = require('web-push');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== SUPABASE CONFIG =====
// Render Environment Variables (no fallbacks — fail fast)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing env vars. Set in Render: SUPABASE_URL and SUPABASE_KEY');
  process.exit(1);
}

// Safe sanity logs (key is not printed)
console.log('✅ SUPABASE_URL:', SUPABASE_URL);
console.log('✅ SUPABASE_KEY exists:', !!SUPABASE_KEY);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// ===== VAPID CONFIG =====
const VAPID_PUBLIC_KEY = 'BGUFC8p3xu8fET2cHDEZTK8bV4kpKhOXpRSokRj3REvPM36FYpg7DOSW4qf2KDM8VSZZaZzhS8RBJtsWua2v5O4';
const VAPID_PRIVATE_KEY = 'Eqf3eWehvJ0tAdDW6Qz_m0UgYhZ-zAx671_5U-6eziA';
webPush.setVapidDetails('mailto:admin@tesla-mindledge.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Healthcheck
app.get('/health', (req, res) => res.json({ ok: true }));

let pushStats = { totalSent: 0, totalErrors: 0, lastSentAt: null };

// ===== PUSH ENDPOINTS =====

app.post('/api/subscribe', async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

  const { error } = await supabase.from('subscriptions').upsert({
    endpoint: sub.endpoint,
    keys_p256dh: sub.keys?.p256dh || '',
    keys_auth: sub.keys?.auth || '',
    data_json: sub
  }, { onConflict: 'endpoint' });

  if (error) {
    console.error('[Subscribe]', error.message);
    return res.status(500).json({ error: error.message });
  }
  const { count } = await supabase.from('subscriptions').select('*', { count: 'exact', head: true });
  res.json({ success: true, total: count || 0 });
});

app.post('/api/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  await supabase.from('subscriptions').delete().eq('endpoint', endpoint);
  const { count } = await supabase.from('subscriptions').select('*', { count: 'exact', head: true });
  res.json({ success: true, total: count || 0 });
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

  const { data: subs } = await supabase.from('subscriptions').select('endpoint, data_json');
  if (!subs || subs.length === 0) return res.json({ success: true, sent: 0, errors: 0, cleaned: 0, totalSubscribers: 0 });

  let sent = 0, errors = 0;
  const failed = [];

  await Promise.allSettled(subs.map(async (row) => {
    try {
      await webPush.sendNotification(row.data_json, payload);
      sent++;
    } catch (err) {
      errors++;
      if (err.statusCode === 404 || err.statusCode === 410) failed.push(row.endpoint);
    }
  }));

  if (failed.length > 0) {
    await supabase.from('subscriptions').delete().in('endpoint', failed);
  }

  pushStats.totalSent += sent;
  pushStats.totalErrors += errors;
  pushStats.lastSentAt = new Date().toISOString();

  const { count } = await supabase.from('subscriptions').select('*', { count: 'exact', head: true });
  res.json({ success: true, sent, errors, cleaned: failed.length, totalSubscribers: count || 0 });
});

// ===== LEAD ENDPOINTS =====

app.post('/api/lead', async (req, res) => {
  const l = req.body;
  const { error } = await supabase.from('leads').insert({
    lead_id: l.leadId,
    first_name: l.firstName,
    last_name: l.lastName,
    email: l.email,
    phone: l.phone,
    buyer: l.buyer,
    geo: l.geo,
    device_info: l.deviceInfo || {},
    geo_info: l.geoInfo || {},
    utm: l.utm || {},
    is_pwa: l.isPWA || false,
    page_time: l.pageTime || 0,
    referrer: l.referrer || '',
    landing: l.landing || '',
    user_agent: l.deviceInfo?.ua || '',
    status: 'new'
  });

  if (error) {
    console.error('[Lead]', error.message);
    return res.status(500).json({ error: error.message });
  }
  else console.log(`[Lead] ${l.firstName} ${l.lastName} — ${l.email} — Buyer: ${l.buyer}`);

  const { count } = await supabase.from('leads').select('*', { count: 'exact', head: true });
  res.json({ success: true, total: count || 0 });
});

app.get('/api/leads', async (req, res) => {
  const { buyer, geo, status, limit } = req.query;
  let query = supabase.from('leads').select('*').order('created_at', { ascending: false });
  if (buyer) query = query.eq('buyer', buyer);
  if (geo) query = query.eq('geo', geo);
  if (status) query = query.eq('status', status);
  if (limit) query = query.limit(parseInt(limit));

  const { data, error } = await query;
  if (error) {
    console.error('[Leads GET]', error.message);
    return res.status(500).json({ error: error.message });
  }

  const { count, error: countErr } = await supabase.from('leads').select('*', { count: 'exact', head: true });
  if (countErr) console.error('[Leads COUNT]', countErr.message);

  const leads = (data || []).map(r => ({
    ...r,
    deviceInfo: r.device_info,
    geoInfo: r.geo_info,
    firstName: r.first_name,
    lastName: r.last_name,
    leadId: r.lead_id,
    isPWA: r.is_pwa,
    pageTime: r.page_time,
    createdAt: r.created_at,
    statusUpdatedAt: r.status_updated_at
  }));

  res.json({ leads, total: count || 0, filtered: leads.length });
});

app.post('/api/lead/status', async (req, res) => {
  const { leadId, status } = req.body;
  const { error } = await supabase.from('leads')
    .update({ status, status_updated_at: new Date().toISOString() })
    .eq('lead_id', leadId);
  if (error) return res.status(404).json({ error: 'Lead not found' });
  res.json({ success: true });
});

// ===== ANALYTICS ENDPOINTS =====

app.post('/api/track', async (req, res) => {
  const e = req.body;
  await supabase.from('events').insert({
    event: e.event,
    device_id: e.deviceId,
    session_id: e.sessionId,
    is_pwa: e.isPWA || false,
    page: e.page,
    data_json: e,
    user_agent: e.userAgent,
    screen: e.screen,
    lang: e.lang,
    referrer: e.referrer,
    timestamp: e.timestamp || new Date().toISOString()
  }).then(() => {}).catch(() => {});
  res.json({ success: true });
});

app.get('/api/analytics', async (req, res) => {
  try {
    // Helper: count events
    const countEvent = async (name) => {
      const { count } = await supabase.from('events').select('*', { count: 'exact', head: true }).eq('event', name);
      return count || 0;
    };

    const countUniqueEvent = async (name) => {
      const { data } = await supabase.from('events').select('device_id').eq('event', name);
      return new Set((data || []).map(r => r.device_id)).size;
    };

    // Overview counts
    const [totalPageViews, installGateShown, installClicks, pwaInstalled, pwaOpens, pwaResumed, videoPlays, videoCompleted] = await Promise.all([
      countEvent('page_view'), countEvent('install_gate_shown'), countEvent('install_click'),
      countEvent('pwa_installed'), countEvent('pwa_open'), countEvent('pwa_resumed'),
      countEvent('video_play'), countEvent('video_complete')
    ]);

    // Unique visitors/sessions
    const { data: allEvents } = await supabase.from('events').select('device_id, session_id');
    const visitors = new Set((allEvents || []).map(r => r.device_id)).size;
    const sessions = new Set((allEvents || []).map(r => r.session_id)).size;

    // Avg time on page
    const { data: exitEvents } = await supabase.from('events').select('data_json').eq('event', 'page_exit');
    const times = (exitEvents || []).map(r => r.data_json?.timeSpent).filter(Boolean);
    const avgTimeOnPage = times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;

    // Funnel
    const [fInstallGate, fInstallClick, fPwaInstalled, fPwaOpen, fVideoPlay, fVideoComplete] = await Promise.all([
      countUniqueEvent('install_gate_shown'), countUniqueEvent('install_click'),
      countUniqueEvent('pwa_installed'), countUniqueEvent('pwa_open'),
      countUniqueEvent('video_play'), countUniqueEvent('video_complete')
    ]);

    const { data: funnelData } = await supabase.from('events').select('data_json').eq('event', 'funnel_step');
    const funnelByStep = {};
    (funnelData || []).forEach(r => {
      const step = r.data_json?.step || 'unknown';
      funnelByStep[step] = (funnelByStep[step] || 0) + 1;
    });

    // Lead statuses
    const { data: leadsAll } = await supabase.from('leads').select('status, geo');
    const leadStatuses = {};
    const geoDistribution = {};
    (leadsAll || []).forEach(l => {
      leadStatuses[l.status || 'new'] = (leadStatuses[l.status || 'new'] || 0) + 1;
      if (l.status !== 'test') {
        geoDistribution[l.geo || 'unknown'] = (geoDistribution[l.geo || 'unknown'] || 0) + 1;
      }
    });

    const totalLeads = (leadsAll || []).filter(l => l.status !== 'test').length;

    // Device distribution
    const { data: pvEvents } = await supabase.from('events').select('device_id, user_agent').eq('event', 'page_view');
    const seenDevices = {};
    const deviceDistribution = {};
    (pvEvents || []).forEach(r => {
      if (!seenDevices[r.device_id]) {
        seenDevices[r.device_id] = true;
        const ua = r.user_agent || '';
        let dev = 'Desktop';
        if (/iPhone|iPad/.test(ua)) dev = 'iOS';
        else if (/Android/.test(ua)) dev = 'Android';
        else if (/Mobile/.test(ua)) dev = 'Mobile Other';
        deviceDistribution[dev] = (deviceDistribution[dev] || 0) + 1;
      }
    });

    // Page views by page
    const { data: pvByPage } = await supabase.from('events').select('page').eq('event', 'page_view');
    const pageViews = {};
    (pvByPage || []).forEach(r => { pageViews[r.page || '/'] = (pageViews[r.page || '/'] || 0) + 1; });

    // Timeline last 7 days
    const timeline = {};
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const dayStart = key + 'T00:00:00';
      const dayEnd = key + 'T23:59:59';

      const { count: views } = await supabase.from('events').select('*', { count: 'exact', head: true }).eq('event', 'page_view').gte('timestamp', dayStart).lte('timestamp', dayEnd);
      const { count: installs } = await supabase.from('events').select('*', { count: 'exact', head: true }).eq('event', 'pwa_installed').gte('timestamp', dayStart).lte('timestamp', dayEnd);
      const { count: pwaO } = await supabase.from('events').select('*', { count: 'exact', head: true }).eq('event', 'pwa_open').gte('timestamp', dayStart).lte('timestamp', dayEnd);

      const { data: dayLeads } = await supabase.from('events').select('data_json').eq('event', 'funnel_step').gte('timestamp', dayStart).lte('timestamp', dayEnd);
      const dayLeadCount = (dayLeads || []).filter(r => r.data_json?.step === 'lead_complete').length;

      timeline[key] = { views: views || 0, installs: installs || 0, leads: dayLeadCount, pwa_opens: pwaO || 0 };
    }

    const { count: subCount } = await supabase.from('subscriptions').select('*', { count: 'exact', head: true });

    res.json({
      overview: {
        totalVisitors: visitors, totalSessions: sessions, totalPageViews,
        installGateShown, installClicks, pwaInstalled, pwaOpens, pwaResumed,
        videoPlays, videoCompleted, avgTimeOnPage, totalLeads,
        pushSubscribers: subCount || 0
      },
      funnel: {
        install_gate_shown: fInstallGate, install_click: fInstallClick,
        pwa_installed: fPwaInstalled, pwa_open: fPwaOpen,
        name_filled: funnelByStep['name_filled'] || 0,
        phone_filled: funnelByStep['phone_filled'] || 0,
        lead_complete: funnelByStep['lead_complete'] || 0,
        video_play: fVideoPlay, video_complete: fVideoComplete
      },
      leadStatuses, geoDistribution, deviceDistribution, pageViews, timeline
    });
  } catch (err) {
    console.error('[Analytics]', err.message);
    res.status(500).json({ error: 'Analytics failed' });
  }
});

// ===== STATS =====
app.get('/api/stats', async (req, res) => {
  const { count: subs } = await supabase.from('subscriptions').select('*', { count: 'exact', head: true });
  const { count: leads } = await supabase.from('leads').select('*', { count: 'exact', head: true });
  const { count: events } = await supabase.from('events').select('*', { count: 'exact', head: true });
  res.json({ subscribers: subs || 0, totalLeads: leads || 0, totalEvents: events || 0, ...pushStats });
});

// ===== ADMIN =====
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });

// ===== HEALTH =====
app.get('/', async (req, res) => {
  const { count: subs } = await supabase.from('subscriptions').select('*', { count: 'exact', head: true });
  const { count: leads } = await supabase.from('leads').select('*', { count: 'exact', head: true });
  res.json({ status: 'ok', service: 'Tesla Mindledge Backend', subscribers: subs || 0, leads: leads || 0 });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Tesla Mindledge Backend — Port ${PORT}`);
  console.log(`   Supabase: ${SUPABASE_URL}`);
  console.log(`   Admin: http://localhost:${PORT}/admin\n`);
});
