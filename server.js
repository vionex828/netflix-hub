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

        const since = new Date(Date.now() - 2 * 60 * 60 * 1000);

        imap.search([
          ['SINCE', since],
          ['OR', ['FROM', 'netflix'], ['SUBJECT', 'netflix']]
        ], (err, uids) => {
          console.log('Emails found:', uids ? uids.length : 0);

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

                  console.log(`Email -> to: ${toEmail} | subject: ${mail.subject}`);

                  if (filterEmail && !toEmail.includes(filterEmail.toLowerCase())) {
                    return res(null);
                  }

                  const parsed = classifyEmail({ subject, body, bodyHtml, bodyPlain, toEmail, ts });
                  console.log('Classified:', parsed ? JSON.stringify(parsed) : 'null');
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

    imap.once('error', (err) => {
      console.error('IMAP error:', err.message);
      reject(err);
    });

    imap.connect();
  });
}

function classifyEmail({ subject, body, bodyHtml, bodyPlain, toEmail, ts }) {
  const sl = subject.toLowerCase();

  // ── Household update link (button style like "Get code" button) ──
  // Netflix sends a button with a link to get the code - extract that link
  const householdLinkPatterns = [
    /href=["'](https:\/\/[^"']*netflix\.com[^"']*(?:household|temporary|access|getcode|get-code|tac)[^"']*)/i,
    /href=["'](https:\/\/www\.netflix\.com\/account[^"']*)/i,
    /href=["'](https:\/\/[^"']*netflix\.com[^"']*code[^"']*)/i,
  ];

  for (const pattern of householdLinkPatterns) {
    const linkMatch = body.match(pattern);
    if (linkMatch && (sl.includes('household') || sl.includes('temporary') || sl.includes('access code'))) {
      return { type: 'household', label: 'Household Code', link: linkMatch[1], to: toEmail, ts };
    }
  }

  // ── Household update link (update household) ──
  const updateMatch = body.match(/href=["'](https:\/\/[^"']*netflix\.com[^"']*(?:update|verify)[^"']*)/i);
  if (updateMatch && sl.includes('household')) {
    return { type: 'update', label: 'Household Update', link: updateMatch[1], to: toEmail, ts };
  }

  // ── Household numeric code ──
  if (sl.includes('household') || sl.includes('temporary') || sl.includes('access code')) {
    const m = bodyPlain.match(/\b(\d{4,6})\b/);
    if (m) return { type: 'household', label: 'Household Code', code: m[1], to: toEmail, ts };
    // If no code found but has a link button, return the first netflix link
    const anyLink = body.match(/href=["'](https:\/\/[^"']*netflix\.com[^"']*)/i);
    if (anyLink) return { type: 'household', label: 'Household Code', link: anyLink[1], to: toEmail, ts };
  }

  return null; // Skip sign-in codes completely
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    user: GMAIL_USER ? GMAIL_USER.replace(/(.{3}).*(@.*)/, '$1***$2') : 'NOT SET',
    pass_set: !!GMAIL_PASS,
    pass_length: GMAIL_PASS ? GMAIL_PASS.length : 0
  });
});

// Debug
app.get('/api/debug', async (req, res) => {
  try {
    const codes = await fetchNetflixEmails('');
    res.json({ success: true, total: codes.length, codes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Main endpoint
app.get('/api/codes', async (req, res) => {
  const email = (req.query.email || '').trim();
  console.log('Request for email:', email || '(all)');
  try {
    const codes = await fetchNetflixEmails(email);
    res.json({ success: true, codes, count: codes.length });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Netflix Code Hub running on port ${PORT}`);
  console.log(`GMAIL_USER: ${GMAIL_USER ? GMAIL_USER.replace(/(.{3}).*(@.*)/, '$1***$2') : 'NOT SET'}`);
  console.log(`GMAIL_PASS: ${GMAIL_PASS ? 'SET (' + GMAIL_PASS.length + ' chars)' : 'NOT SET'}`);
});
