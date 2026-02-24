const express = require('express');
const webpush = require('web-push');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── VAPID Config ──
const VAPID_PUBLIC = 'BLoXep0vFSR60eX0m8TSOa_lgtD9oOrTzf5eA1ZnWOvyeKVhOgRgZmTCvCwWrkxfTBttppaJFFwjVqeZsDY0o3I';
const VAPID_PRIVATE = '-lWCOoFPYkdi9YI_ojl2FybFywgNH3_1jwOCwSMnN2w';

webpush.setVapidDetails(
  'mailto:admin@teslamindledge.com',
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

// ── Middleware ──
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory subscriptions store ──
const subscriptions = new Map(); // key = endpoint, value = subscription object
let stats = { sent: 0, failed: 0, lastSent: null };

// ── Routes ──

// Subscribe
app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  subscriptions.set(sub.endpoint, sub);
  console.log(`[+] New subscription. Total: ${subscriptions.size}`);
  res.json({ success: true, total: subscriptions.size });
});

// Send push to all subscribers
app.post('/api/send', async (req, res) => {
  const { title, body, icon, image, url, tag } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'title and body are required' });
  }

  const payload = JSON.stringify({
    title,
    body,
    icon: icon || '/icons/icon-192x192.png',
    image: image || undefined,
    url: url || '/',
    tag: tag || 'mindledge-push'
  });

  let sent = 0;
  let failed = 0;
  const toRemove = [];

  for (const [endpoint, sub] of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 404 || err.statusCode === 410) {
        toRemove.push(endpoint);
      }
      console.error(`[!] Push failed (${err.statusCode}):`, endpoint.slice(0, 60));
    }
  }

  // Cleanup expired subscriptions
  toRemove.forEach(ep => subscriptions.delete(ep));

  stats.sent += sent;
  stats.failed += failed;
  stats.lastSent = new Date().toISOString();

  console.log(`[>] Sent: ${sent}, Failed: ${failed}, Cleaned: ${toRemove.length}`);
  res.json({ sent, failed, cleaned: toRemove.length, totalSubscribers: subscriptions.size });
});

// Stats
app.get('/api/stats', (req, res) => {
  res.json({
    subscribers: subscriptions.size,
    totalSent: stats.sent,
    totalFailed: stats.failed,
    lastSent: stats.lastSent
  });
});

// Admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', subscribers: subscriptions.size });
});

app.listen(PORT, () => {
  console.log(`🚀 Push server running on port ${PORT}`);
});
