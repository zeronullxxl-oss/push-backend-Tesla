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

webPush.setVapidDetails(
  'mailto:admin@tesla-mindledge.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// ===== IN-MEMORY STORAGE =====
// For production, use a database (Redis, PostgreSQL, etc.)
let subscriptions = [];
let stats = {
  totalSubscriptions: 0,
  totalSent: 0,
  totalErrors: 0,
  lastSentAt: null
};

// Persist subscriptions to file (simple persistence for Render)
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');

function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      const data = fs.readFileSync(SUBS_FILE, 'utf8');
      subscriptions = JSON.parse(data);
      stats.totalSubscriptions = subscriptions.length;
      console.log(`Loaded ${subscriptions.length} subscriptions from file`);
    }
  } catch (err) {
    console.error('Error loading subscriptions:', err);
  }
}

function saveSubscriptions() {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2));
  } catch (err) {
    console.error('Error saving subscriptions:', err);
  }
}

loadSubscriptions();

// ===== ROUTES =====

// Subscribe endpoint
app.post('/api/subscribe', (req, res) => {
  const sub = req.body;

  if (!sub || !sub.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  // Check for duplicate
  const exists = subscriptions.find(s => s.endpoint === sub.endpoint);
  if (!exists) {
    subscriptions.push(sub);
    stats.totalSubscriptions = subscriptions.length;
    saveSubscriptions();
    console.log(`[Subscribe] New: ${sub.endpoint.slice(0, 60)}... Total: ${subscriptions.length}`);
  } else {
    console.log('[Subscribe] Already exists');
  }

  res.json({ success: true, total: subscriptions.length });
});

// Unsubscribe endpoint
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

  const before = subscriptions.length;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  stats.totalSubscriptions = subscriptions.length;
  saveSubscriptions();

  console.log(`[Unsubscribe] Removed ${before - subscriptions.length} sub(s). Total: ${subscriptions.length}`);
  res.json({ success: true, removed: before - subscriptions.length, total: subscriptions.length });
});

// Send push to all subscribers
app.post('/api/send', async (req, res) => {
  const { title, body, icon, image, url, tag } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required' });
  }

  const payload = JSON.stringify({
    title,
    body,
    icon: icon || '/icons/icon-192x192.png',
    badge: '/icons/icon-96x96.png',
    image: image || undefined,
    url: url || '/',
    tag: tag || 'push-' + Date.now()
  });

  console.log(`[Send] Sending to ${subscriptions.length} subscribers: "${title}"`);

  let sent = 0;
  let errors = 0;
  const failed = [];

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webPush.sendNotification(sub, payload);
        sent++;
      } catch (err) {
        errors++;
        if (err.statusCode === 404 || err.statusCode === 410) {
          // Subscription expired or invalid — remove it
          failed.push(sub.endpoint);
        }
        console.error(`[Send Error] ${err.statusCode || err.message} — ${sub.endpoint.slice(0, 50)}...`);
      }
    })
  );

  // Clean up invalid subscriptions
  if (failed.length > 0) {
    subscriptions = subscriptions.filter(s => !failed.includes(s.endpoint));
    stats.totalSubscriptions = subscriptions.length;
    saveSubscriptions();
    console.log(`[Cleanup] Removed ${failed.length} expired subscriptions`);
  }

  stats.totalSent += sent;
  stats.totalErrors += errors;
  stats.lastSentAt = new Date().toISOString();

  res.json({
    success: true,
    sent,
    errors,
    cleaned: failed.length,
    totalSubscribers: subscriptions.length
  });
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  res.json({
    subscribers: subscriptions.length,
    totalSent: stats.totalSent,
    totalErrors: stats.totalErrors,
    lastSentAt: stats.lastSentAt
  });
});

// Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Tesla Mindledge Push Backend',
    subscribers: subscriptions.length,
    uptime: process.uptime()
  });
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`\n🚀 Tesla Mindledge Push Backend`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Admin: http://localhost:${PORT}/admin`);
  console.log(`   Subscribers: ${subscriptions.length}\n`);
});
