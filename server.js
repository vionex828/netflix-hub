const express = require('express');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CONFIG (set these as Railway environment variables) ──
const GMAIL_USER = process.env.GMAIL_USER;   // your Gmail address
const GMAIL_PASS = process.env.GMAIL_PASS;   // your 16-char app password
const PORT = process.env.PORT || 3000;

// ── IMAP FETCH ────────────────────────────────────────────
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

    const results = [];
    const cutoff = new Date(Date.now() - 15 * 60 * 1000); // last 15 min

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err) { imap.end(); return reject(err); }

        // Search Netflix emails since 30 min ago (wider net, filter in code)
        const since = new Date(Date.now() - 30 * 60 * 1000);
        imap.search([
          ['FROM', 'netflix.com'],
          ['SINCE', since]
        ], (err, uids) => {
          if (err || !uids || uids.length === 0) {
            imap.end();
            return resolve([]);
          }

          const fetch = imap.fetch(uids, { bodies: '' });
          const promises = [];

          fetch.on('message', (msg) => {
            const p = new Promise((res) => {
              msg.on('body', (stream) => {
                simpleParser(stream, (err, mail) => {
                  if (err) return res(null);

                  const to = mail.to?.text || '';
                  const toEmail = (to.match(/<([^>]+)>/) || [, to])[1]?.toLowerCase().trim() || to.toLowerCase().trim();
                  const subject = (mail.subject || '').toLowerCase();
                  const bodyHtml = mail.html || '';
                  const bodyText = mail.text || '';
                  const body = bodyHtml || bodyText;
                  const bodyPlain = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
                  const ts = mail.date ? new Date(mail.date).getTime() : Date.now();

                  // Filter by email if provided
                  if (filterEmail && !toEmail.includes(filterEmail.toLowerCase())) {
                    return res(null);
                  }

                  // Filter to last 15 min
                  if (ts < cutoff.getTime()) return res(null);

                  const parsed = classifyEmail({ subject, body, bodyPlain, toEmail, ts });
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

    imap.once('error', reject);
    imap.connect();
  });
}

function classifyEmail({ subject, body, bodyPlain, toEmail, ts }) {
  const sl = subject.toLowerCase();

  // Household update link
  const linkMatch = body.match(/href=["'](https:\/\/[^"']*netflix\.com[^"']*(?:household|update|verify)[^"']*)/i);
  if (sl.includes('household') && linkMatch) {
    return { type: 'update', label: 'Household Update', link: linkMatch[1], to: toEmail, ts };
  }

  // Household code
  if (sl.includes('household')) {
    const m = bodyPlain.match(/\b(\d{4,6})\b/);
    if (m) return { type: 'household', label: 'Household Code', code: m[1], to: toEmail, ts };
  }

  // Sign-in code
  if (sl.includes('sign') || sl.includes('verify') || sl.includes('code')) {
    const m = bodyPlain.match(/\b(\d{6})\b/);
    if (m) return { type: 'signin', label: 'Sign-In Code', code: m[1], to: toEmail, ts };
  }

  // Generic 6-digit fallback
  const m6 = bodyPlain.match(/\b(\d{6})\b/);
  if (m6) return { type: 'signin', label: 'Sign-In Code', code: m6[1], to: toEmail, ts };

  return null;
}

// ── API ROUTES ────────────────────────────────────────────
app.get('/api/codes', async (req, res) => {
  const email = (req.query.email || '').trim();
  try {
    const codes = await fetchNetflixEmails(email);
    res.json({ success: true, codes, count: codes.length });
  } catch (err) {
    console.error('IMAP error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch emails. Check Gmail credentials.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, user: GMAIL_USER ? GMAIL_USER.split('@')[0] + '@...' : 'NOT SET' });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Netflix Code Hub running on port ${PORT}`);
  if (!GMAIL_USER || !GMAIL_PASS) {
    console.warn('⚠ GMAIL_USER or GMAIL_PASS not set! Set them as environment variables.');
  }
});
