const express = require('express');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const PORT = process.env.PORT || 3000;
const TG_TOKEN = process.env.TG_TOKEN || '8653224571:AAEYZfrLWtRk_U-A0t6e3sudBSibrtW2meE';
const TG_CHAT = process.env.TG_CHAT || '-1002242163455';

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
const RATE_LIMIT = 10;
const RATE_WINDOW = 5 * 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  rateLimitMap.set(ip, entry);
  return false;
}

// ── CACHE ──────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 60 * 1000;

function getCached(email) {
  const entry = cache.get(email);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data;
  return null;
}
function setCache(email, data) {
  cache.set(email, { data, time: Date.now() });
}

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
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow'
    });
    const html = await res.text();

    // Try multiple patterns to find the OTP
    const patterns = [
      />\s*(\d{4})\s*</g,                          // 4-digit number in tags
      /"code"\s*:\s*"(\d{4})"/,                    // JSON code field
      /code[^>]*>\s*(\d{4})\s*</i,                 // code class/tag
      /verification[^>]*>\s*(\d{4,6})\s*</i,       // verification
      />\s*(\d{4,6})\s*<\/(?:p|h\d|div|span)/,    // number in common tags
      /data-code="(\d{4,6})"/,                     // data attribute
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const code = match[1] || match[0].replace(/\D/g, '');
        if (code && code.length >= 4 && code.length <= 6) {
          console.log('OTP scraped:', code);
          return code;
        }
      }
    }

    // Last resort: find any standalone 4-digit number
    const allMatches = [...html.matchAll(/(?<![0-9])(\d{4})(?![0-9])/g)];
    // Filter out common non-OTP numbers
    const filtered = allMatches.filter(m => {
      const n = parseInt(m[1]);
      return n > 999 && n < 10000 &&
        !['2023','2024','2025','2026','1080','1920'].includes(m[1]);
    });

    if (filtered.length > 0) {
      console.log('OTP found (fallback):', filtered[0][1]);
      return filtered[0][1];
    }

    return null;
  } catch(e) {
    console.error('OTP scrape error:', e.message);
    return null;
  }
}

// ── IMAP FETCH ─────────────────────────────────────────────
function fetchNetflixEmails(filterEmail) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: GMAIL_USER,
      password: GMAIL_PASS,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
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
          console.log('Emails found:', uids ? uids.length : 0);
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
                  const ts = mail.date ? new Date(mail.date).getTime() : Date.now();

                  if (filterEmail && !toEmail.includes(filterEmail.toLowerCase())) return res(null);

                  const parsed = await classifyEmail({ subject, bodyHtml, bodyText, toEmail, ts });
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

async function classifyEmail({ subject, bodyHtml, bodyText, toEmail, ts }) {
  const sl = subject.toLowerCase();
  const isRelevant = sl.includes('temporary') || sl.includes('access code') ||
                     sl.includes('travel') || sl.includes('household') ||
                     sl.includes('update') || sl.includes('verify');
  if (!isRelevant) return null;

  const result = extractLink(bodyHtml) || extractLink(bodyText);
  if (!result) return null;

  // Auto-scrape OTP for household/temporary codes only
  if (result.type === 'household') {
    console.log('Scraping OTP from:', result.link.substring(0, 60) + '...');
    const otp = await scrapeOTP(result.link);
    if (otp) {
      return {
        type: 'household',
        label: 'Temporary Access Code',
        code: otp,
        to: toEmail,
        ts,
        expiresAt: ts + 15 * 60 * 1000 // 15 min from email time
      };
    }
    // Fallback to link if scraping fails
    return { ...result, to: toEmail, ts, expiresAt: ts + 15 * 60 * 1000 };
  }

  return { ...result, to: toEmail, ts };
}

// ── API ROUTES ─────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  trackVisitor(ip);
  resetDailyIfNeeded();
  res.json({ live: getLiveVisitors(), today: totalToday });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    user: GMAIL_USER ? GMAIL_USER.replace(/(.{3}).*(@.*)/, '$1***$2') : 'NOT SET',
    pass_set: !!GMAIL_PASS,
    pass_length: GMAIL_PASS ? GMAIL_PASS.length : 0
  });
});

app.get('/api/debug', async (req, res) => {
  try {
    const codes = await fetchNetflixEmails('');
    res.json({ success: true, total: codes.length, codes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/codes', async (req, res) => {
  const email = (req.query.email || '').trim();
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

  // Track visitor
  trackVisitor(ip);
  resetDailyIfNeeded();

  // Rate limit check
  if (isRateLimited(ip)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Please wait 5 minutes.' });
  }

  console.log('Request for:', email || '(all)');

  // Cache check
  const cached = getCached(email);
  if (cached) {
    console.log('Cache hit for:', email);
    return res.json({ success: true, codes: cached, count: cached.length, cached: true, fetchTime: 0 });
  }

  const start = Date.now();
  try {
    const codes = await fetchNetflixEmails(email);
    const fetchTime = ((Date.now() - start) / 1000).toFixed(1);
    setCache(email, codes);

    // Only count actual results
    if (codes.length > 0) totalToday += 1;

    // Telegram notification
    if (email) {
      const resultSummary = codes.length > 0
        ? codes.map(c => `• ${c.label}: ${c.code || 'link'} → ${c.to}`).join('\n')
        : 'No codes found';
      sendTelegram(
        `🔍 <b>FanFlix Search</b>\n\n` +
        `📧 <code>${email}</code>\n` +
        `📊 ${codes.length} result(s)\n` +
        `⏱ ${fetchTime}s\n` +
        `👥 ${getLiveVisitors()} online\n\n` +
        `${resultSummary}`
      );
    }

    res.json({ success: true, codes, count: codes.length, fetchTime });
  } catch (err) {
    console.error('Error:', err.message);
    sendTelegram(`❌ <b>FanFlix Error</b>\n<code>${email}</code>\n${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`FanFlix running on port ${PORT}`);
  sendTelegram('🟢 <b>FanFlix Started</b>\nServer is online!');
});
