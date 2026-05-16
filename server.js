const express = require('express');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const PORT = process.env.PORT || 3000;
const TG_TOKEN = process.env.TG_TOKEN || '8653224571:AAEYZfrLWtRk_U-A0t6e3sudBSibrtW2meE';
const TG_CHAT = process.env.TG_CHAT || '-1002242163455';
const ADMIN_PASS = process.env.ADMIN_PASS || '@Orsha420@';
const LINKS_FILE = '/app/data/links.json';

// ── LINKS DB ───────────────────────────────────────────────
function loadLinks() {
  try { return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); }
  catch(e) { return {}; }
}
function saveLinks(links) {
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
}
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// ── STATS ──────────────────────────────────────────────────
let totalToday = 0;
let lastReset = new Date().toDateString();
const visitors = new Map();

function resetDailyIfNeeded() {
  const today = new Date().toDateString();
  if (today !== lastReset) { totalToday = 0; lastReset = today; }
}
function trackVisitor(ip) {
  visitors.set(ip, Date.now());
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [k, v] of visitors) { if (v < cutoff) visitors.delete(k); }
}
function getLiveVisitors() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  return [...visitors.values()].filter(v => v > cutoff).length;
}

// ── RATE LIMITING ──────────────────────────────────────────
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > 5 * 60 * 1000) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return false;
  }
  if (entry.count >= 10) return true;
  entry.count++;
  rateLimitMap.set(ip, entry);
  return false;
}

// ── CACHE ──────────────────────────────────────────────────
const cache = new Map();
function getCached(email) {
  const entry = cache.get(email);
  if (entry && Date.now() - entry.time < 60000) return entry.data;
  return null;
}
function setCache(email, data) { cache.set(email, { data, time: Date.now() }); }

// ── TELEGRAM ───────────────────────────────────────────────
async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' })
    });
  } catch(e) { console.error('Telegram error:', e.message); }
}

// ── AUTO OTP SCRAPER ───────────────────────────────────────
async function scrapeOTP(link) {
  try {
    const res = await fetch(link, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow'
    });
    const html = await res.text();
    const patterns = [
      />\s*(\d{4})\s*</g,
      /"code"\s*:\s*"(\d{4})"/,
      /code[^>]*>\s*(\d{4,6})\s*</i,
      />\s*(\d{4,6})\s*<\/(?:p|h\d|div|span)/,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const code = (match[1] || match[0]).replace(/\D/g, '');
        if (code && code.length >= 4 && code.length <= 6) return code;
      }
    }
    const allMatches = [...html.matchAll(/(?<![0-9])(\d{4})(?![0-9])/g)];
    const filtered = allMatches.filter(m => {
      const n = parseInt(m[1]);
      return n > 999 && !['2023','2024','2025','2026','1080','1920'].includes(m[1]);
    });
    if (filtered.length > 0) return filtered[0][1];
    return null;
  } catch(e) { console.error('OTP scrape error:', e.message); return null; }
}

// ── IMAP FETCH ─────────────────────────────────────────────
function fetchNetflixEmails(filterEmail, includeSignin = false) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: GMAIL_USER, password: GMAIL_PASS,
      host: 'imap.gmail.com', port: 993, tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) { imap.end(); return reject(err); }
        const since = new Date(Date.now() - 20 * 60 * 1000);
        imap.search([
          ['SINCE', since],
          ['OR', ['FROM', 'netflix'], ['SUBJECT', 'netflix']]
        ], (err, uids) => {
          if (err || !uids || uids.length === 0) { imap.end(); return resolve([]); }
          const fetch = imap.fetch(uids, { bodies: '' });
          const promises = [];
          fetch.on('message', (msg) => {
            const p = new Promise((res) => {
              msg.on('body', (stream) => {
                simpleParser(stream, async (err, mail) => {
                  if (err) return res(null);
                  const to = mail.to?.text || '';
                  const toEmail = (to.match(/<([^>]+)>/) || [, to])[1]?.toLowerCase().trim() || to.toLowerCase().trim();
                  const subject = (mail.subject || '').toLowerCase();
                  const bodyHtml = mail.html || '';
                  const bodyText = mail.text || '';
                  const bodyPlain = (bodyHtml || bodyText).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
                  const ts = mail.date ? new Date(mail.date).getTime() : Date.now();
                  if (filterEmail && !toEmail.includes(filterEmail.toLowerCase())) return res(null);
                  const parsed = await classifyEmail({ subject, bodyHtml, bodyText, bodyPlain, toEmail, ts, includeSignin });
                  res(parsed);
                });
              });
            });
            promises.push(p);
          });
          fetch.once('end', async () => {
            const items = (await Promise.all(promises)).filter(Boolean);
            imap.end();
            resolve(items.sort((a, b) => b.ts - a.ts));
          });
          fetch.once('error', (e) => { imap.end(); reject(e); });
        });
      });
    });
    imap.once('error', (err) => { console.error('IMAP error:', err.message); reject(err); });
    imap.connect();
  });
}

function extractLink(body) {
  const b = body.replace(/&amp;/g, '&').replace(/&#38;/g, '&');
  const m1 = b.match(/https:\/\/www\.netflix\.com\/account\/travel\/verify\?nftoken=[^\s"'<>\\]+/i);
  if (m1) return { link: m1[0], type: 'household', label: 'Temporary Access Code' };
  const m2 = b.match(/https:\/\/www\.netflix\.com\/account\/update-primary-location\?nftoken=[^\s"'<>\\]+/i);
  if (m2) return { link: m2[0], type: 'update', label: 'Update Household (TV)' };
  const m3 = b.match(/href=["'](https:\/\/[^"']*netflix\.com\/account[^"']*nftoken[^"']*)/i);
  if (m3) {
    const link = m3[1].replace(/&amp;/g, '&');
    const isUpdate = link.includes('update-primary') || link.includes('update-household');
    return { link, type: isUpdate ? 'update' : 'household', label: isUpdate ? 'Update Household (TV)' : 'Temporary Access Code' };
  }
  return null;
}

async function classifyEmail({ subject, bodyHtml, bodyText, bodyPlain, toEmail, ts, includeSignin }) {
  const sl = subject.toLowerCase();

  // Sign-in code (only for unique links)
  if (includeSignin && (sl.includes('sign-in code') || sl.includes('sign in code'))) {
    const m = bodyPlain.match(/\b(\d{4,6})\b/);
    if (m) return {
      type: 'signin', label: 'Sign-in Code', code: m[1],
      to: toEmail, ts, expiresAt: ts + 15 * 60 * 1000
    };
  }

  const isRelevant = sl.includes('temporary') || sl.includes('access code') ||
    sl.includes('travel') || sl.includes('household') || sl.includes('update') || sl.includes('verify');
  if (!isRelevant) return null;

  const result = extractLink(bodyHtml) || extractLink(bodyText);
  if (!result) return null;

  if (result.type === 'household') {
    const otp = await scrapeOTP(result.link);
    if (otp) return { type: 'household', label: 'Temporary Access Code', code: otp, to: toEmail, ts, expiresAt: ts + 15 * 60 * 1000 };
    return { ...result, to: toEmail, ts, expiresAt: ts + 15 * 60 * 1000 };
  }
  return { ...result, to: toEmail, ts };
}

// ── ADMIN MIDDLEWARE ────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── ADMIN ROUTES ────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASS) res.json({ success: true, token: ADMIN_PASS });
  else res.status(401).json({ success: false, error: 'Wrong password' });
});

app.get('/api/admin/links', adminAuth, (req, res) => {
  const links = loadLinks();
  res.json({ success: true, links });
});

app.post('/api/admin/create', adminAuth, (req, res) => {
  const { name, email, days } = req.body;
  if (!name || !email || !days) return res.status(400).json({ error: 'Missing fields' });
  const links = loadLinks();
  const token = generateToken();
  const now = Date.now();
  links[token] = {
    token, name, email: email.toLowerCase().trim(),
    days: parseInt(days),
    createdAt: now,
    expiresAt: now + parseInt(days) * 24 * 60 * 60 * 1000,
    uses: 0, lastUsed: null, active: true
  };
  saveLinks(links);
  sendTelegram(`🔗 <b>New Customer Link Created</b>\n\n👤 ${name}\n📧 ${email}\n📅 ${days} days\n🔗 /c/${token}`);
  res.json({ success: true, token, link: `/c/${token}` });
});

app.post('/api/admin/revoke/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error: 'Link not found' });
  links[req.params.token].active = false;
  saveLinks(links);
  res.json({ success: true });
});

app.delete('/api/admin/delete/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error: 'Link not found' });
  delete links[req.params.token];
  saveLinks(links);
  res.json({ success: true });
});

app.post('/api/admin/activate/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error: 'Link not found' });
  links[req.params.token].active = true;
  saveLinks(links);
  res.json({ success: true });
});

// ── CUSTOMER LINK ROUTE ─────────────────────────────────────
app.get('/api/link/:token', async (req, res) => {
  const links = loadLinks();
  const link = links[req.params.token];
  if (!link) return res.status(404).json({ success: false, error: 'Invalid link' });
  if (!link.active) return res.status(403).json({ success: false, error: 'revoked', message: 'Access revoked. Contact FanFlix BD.' });
  if (Date.now() > link.expiresAt) return res.status(403).json({ success: false, error: 'expired', message: 'Link expired. Contact FanFlix BD to renew.' });

  // Update usage
  link.uses += 1;
  link.lastUsed = Date.now();
  saveLinks(links);

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  trackVisitor(ip);

  // Notify on Telegram
  sendTelegram(`👤 <b>Customer Link Used</b>\n\n👤 ${link.name}\n📧 ${link.email}\n🔢 Uses: ${link.uses}\n⏳ Expires: ${new Date(link.expiresAt).toLocaleDateString()}`);

  // Fetch codes (with sign-in codes)
  const cacheKey = `link_${link.email}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json({ success: true, codes: cached, count: cached.length, cached: true, name: link.name, email: link.email });

  try {
    const codes = await fetchNetflixEmails(link.email, true);
    setCache(cacheKey, codes);
    if (codes.length > 0) totalToday += 1;
    res.json({ success: true, codes, count: codes.length, name: link.name, email: link.email });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── STATS ──────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  trackVisitor(ip); resetDailyIfNeeded();
  res.json({ live: getLiveVisitors(), today: totalToday });
});

// ── HEALTH ─────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, user: GMAIL_USER ? GMAIL_USER.replace(/(.{3}).*(@.*)/, '$1***$2') : 'NOT SET' });
});

// ── MAIN CODES ─────────────────────────────────────────────
app.get('/api/codes', async (req, res) => {
  const email = (req.query.email || '').trim();
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  trackVisitor(ip); resetDailyIfNeeded();
  if (isRateLimited(ip)) return res.status(429).json({ success: false, error: 'Too many requests. Please wait 5 minutes.' });

  const cached = getCached(email);
  if (cached) return res.json({ success: true, codes: cached, count: cached.length, cached: true, fetchTime: 0 });

  const start = Date.now();
  try {
    const codes = await fetchNetflixEmails(email, false);
    const fetchTime = ((Date.now() - start) / 1000).toFixed(1);
    setCache(email, codes);
    if (codes.length > 0) totalToday += 1;
    if (email) {
      const summary = codes.length > 0 ? codes.map(c => `• ${c.label}: ${c.code || 'link'}`).join('\n') : 'No codes found';
      sendTelegram(`🔍 <b>FanFlix Search</b>\n📧 <code>${email}</code>\n📊 ${codes.length} result(s)\n⏱ ${fetchTime}s\n\n${summary}`);
    }
    res.json({ success: true, codes, count: codes.length, fetchTime });
  } catch(err) {
    sendTelegram(`❌ <b>Error</b>\n<code>${email}</code>\n${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── SERVE ADMIN ─────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── CUSTOMER LINK PAGE ──────────────────────────────────────
app.get('/c/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Ensure data directory exists
try { require('fs').mkdirSync('/app/data', { recursive: true }); } catch(e) {}

app.listen(PORT, () => {
  console.log(`FanFlix running on port ${PORT}`);
  sendTelegram('🟢 <b>FanFlix Started</b>\nServer is online!');
});
