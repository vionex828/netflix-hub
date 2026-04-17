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
          if (err || !uids || uids.length === 0) { imap.end(); return resolve([]); }

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
                  const ts = mail.date ? new Date(mail.date).getTime() : Date.now();

                  console.log('Email -> to:', toEmail, '| subject:', mail.subject);

                  if (filterEmail && !toEmail.includes(filterEmail.toLowerCase())) return res(null);

                  const parsed = classifyEmail({ subject, bodyHtml, bodyText, toEmail, ts });
                  console.log('Result:', parsed ? parsed.type + ' link=' + (parsed.link||'').substring(0,60) : 'null');
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
  // Fix HTML encoding first
  const b = body.replace(/&amp;/g, '&').replace(/&#38;/g, '&');

  // 1. Mobile/Tablet: travel/verify link
  const m1 = b.match(/https:\/\/www\.netflix\.com\/account\/travel\/verify\?nftoken=[^\s"'<>\\]+/i);
  if (m1) return { link: m1[0], type: 'household', label: 'Temporary Access Code 📱' };

  // 2. TV: update-primary-location link
  const m2 = b.match(/https:\/\/www\.netflix\.com\/account\/update-primary-location\?nftoken=[^\s"'<>\\]+/i);
  if (m2) return { link: m2[0], type: 'update', label: 'Update Household (TV) 📺' };

  // 3. Any netflix account link with nftoken inside href
  const m3 = b.match(/href=["'](https:\/\/[^"']*netflix\.com\/account[^"']*nftoken[^"']*)/i);
  if (m3) {
    const link = m3[1].replace(/&amp;/g, '&');
    const isUpdate = link.includes('update-primary') || link.includes('update-household');
    return { link, type: isUpdate ? 'update' : 'household', label: isUpdate ? 'Update Household (TV) 📺' : 'Temporary Access Code 📱' };
  }

  // 4. Plain text nftoken link
  const m4 = b.match(/https:\/\/[^\s<>"'\\]*netflix\.com[^\s<>"'\\]*nftoken[^\s<>"'\\]*/i);
  if (m4) {
    const link = m4[0].replace(/&amp;/g, '&');
    const isUpdate = link.includes('update-primary') || link.includes('update-household');
    return { link, type: isUpdate ? 'update' : 'household', label: isUpdate ? 'Update Household (TV) 📺' : 'Temporary Access Code 📱' };
  }

  return null;
}

function classifyEmail({ subject, bodyHtml, bodyText, toEmail, ts }) {
  const sl = subject.toLowerCase();

  const isRelevant = sl.includes('temporary') || sl.includes('access code') ||
                     sl.includes('travel') || sl.includes('household') ||
                     sl.includes('update') || sl.includes('verify');

  if (!isRelevant) return null;

  // Try HTML body first, then plain text
  const result = extractLink(bodyHtml) || extractLink(bodyText);
  if (result) return { ...result, to: toEmail, ts };

  return null; // No link found, skip
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

// Main
app.get('/api/codes', async (req, res) => {
  const email = (req.query.email || '').trim();
  console.log('Request for:', email || '(all)');
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
