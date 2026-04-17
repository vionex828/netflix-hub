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

                  const parsed = classifyEmail({ subject, body, bodyHtml, bodyPlain, bodyText, toEmail, ts });
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

function extractNetflixLink(body) {
  // Priority 1: exact travel/verify link with nftoken
  const travelMatch = body.match(/https:\/\/www\.netflix\.com\/account\/travel\/verify\?[^\s"'<>]+/i);
  if (travelMatch) return travelMatch[0].replace(/&amp;/g, '&');

  // Priority 2: any netflix verify/household/travel link inside href
  const hrefMatch = body.match(/href=["']([^"']*netflix\.com\/account\/(?:travel|household)[^"']*)/i);
  if (hrefMatch) return hrefMatch[1].replace(/&amp;/g, '&');

  // Priority 3: any netflix account link
  const accountMatch = body.match(/href=["']([^"']*netflix\.com\/account[^"']*nftoken[^"']*)/i);
  if (accountMatch) return accountMatch[1].replace(/&amp;/g, '&');

  // Priority 4: plain text netflix link with nftoken
  const plainMatch = body.match(/https:\/\/[^\s<>"']*netflix\.com[^\s<>"']*nftoken[^\s<>"']*/i);
  if (plainMatch) return plainMatch[0].replace(/&amp;/g, '&');

  return null;
}

function classifyEmail({ subject, body, bodyHtml, bodyPlain, bodyText, toEmail, ts }) {
  const sl = subject.toLowerCase();

  // ── Temporary access / household code emails ──
  const isTempAccess = sl.includes('temporary') || sl.includes('access code') || sl.includes('travel');
  const isHousehold = sl.includes('household');
  const isUpdate = sl.includes('update');

  if (isTempAccess || isHousehold || isUpdate) {
    // Try to extract the Netflix link from both HTML and plain text
    const link = extractNetflixLink(bodyHtml) || extractNetflixLink(bodyText) || extractNetflixLink(bodyPlain);

    if (link) {
      const type = isUpdate ? 'update' : 'household';
      const label = isUpdate ? 'Household Update' : 'Temporary Access Code';
      console.log('Found link:', link.substring(0, 80) + '...');
      return { type, label, link, to: toEmail, ts };
    }

    // Fallback: numeric code
    const m = bodyPlain.match(/\b(\d{4,6})\b/);
    if (m) return { type: 'household', label: 'Household Code', code: m[1], to: toEmail, ts };
  }

  return null; // ignore all other emails (sign-in etc)
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

// Debug - shows raw email data
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
