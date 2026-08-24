const express = require('express');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

// ── EMAIL CODE CACHE + PERSISTENT IMAP POLLER ───────────────────────────────
const emailCodeCache = new Map(); // email → { codes: [], fetchedAt: timestamp }
const alertedSignins = new Set(); // dedup outside-BD login alerts (ts+email)
const alertedBanned = new Set(); // dedup Netflix account-banned alerts (ts+email)
const deletedAccountEmails = new Set(); // emails of deleted accounts - suppress all further alerts for them
const alertedPinChanges = new Set(); // dedup PIN change alerts (ts+email+profile)

function getCodesFromCache(email) {
  const entry = emailCodeCache.get(email.toLowerCase());
  if (!entry) return null;
  const age = Date.now() - entry.fetchedAt;
  const ttl = entry.codes.length > 0 ? 60 * 1000 : 15 * 1000;
  if (age > ttl) { emailCodeCache.delete(email.toLowerCase()); return null; }
  return entry.codes;
}

function clearEmailCache(email) {
  emailCodeCache.delete(email.toLowerCase());
}

function setCodesInCache(email, codes) {
  emailCodeCache.set(email.toLowerCase(), { codes, fetchedAt: Date.now() });
}

// ── PERSISTENT IMAP CONNECTION ───────────────────────────────────────────────
let _imap = null;
let _imapReady = false;
let _imapPolling = false;
let _reconnTimer = null;

function startIMAPPoller() {
  if (!GMAIL_USER || !GMAIL_PASS) return;
  _connectIMAP();
}

function _connectIMAP() {
  if (_imap) { try { _imap.destroy(); } catch(e) {} _imap = null; }
  _imapReady = false;

  const imap = new Imap({
    user: GMAIL_USER, password: GMAIL_PASS,
    host: 'imap.gmail.com', port: 993, tls: true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 10000, authTimeout: 8000,
    keepalive: { interval: 10000, idleInterval: 300000, forceNoop: true }
  });

  _imap = imap;

  imap.once('ready', () => {
    imap.openBox('INBOX', true, (err) => {
      if (err) { console.error('IMAP openBox:', err.message); _scheduleReconnect(); return; }
      _imapReady = true;
      console.log('IMAP: persistent connection ready');
      _pollAll(); // immediate first poll
    });
  });

  imap.on('error', (err) => {
    console.error('IMAP error:', err.message);
    _imapReady = false;
    _scheduleReconnect();
  });

  imap.once('end', () => {
    console.log('IMAP: connection ended');
    _imapReady = false;
    _imap = null;
    _scheduleReconnect();
  });

  imap.connect();
}

function _scheduleReconnect() {
  if (_reconnTimer) return;
  _reconnTimer = setTimeout(() => { _reconnTimer = null; _connectIMAP(); }, 20000);
}

const _processedUids = new Set(); // tracks emails already classified, prevents skipping due to volume

async function _pollAll() {
  if (!_imapReady || !_imap || _imapPolling) return;
  _imapPolling = true;
  try {
    await new Promise((resolve) => {
      const since = new Date(Date.now() - 20*60*1000);
      _imap.search([['SINCE', since], ['OR', ['FROM', 'netflix'], ['SUBJECT', 'netflix']]], async (err, uids) => {
        if (err || !uids || !uids.length) { resolve(); return; }
        // Process every UID not yet seen - never skip emails due to volume
        const newUids = uids.filter(uid => !_processedUids.has(uid));
        if (!newUids.length) { resolve(); return; }
        const fetch = _imap.fetch(newUids, { bodies: '' });
        const promises = [];
        fetch.on('message', (msg, seqno) => {
          let uid = null;
          msg.once('attributes', (attrs) => { uid = attrs.uid; });
          const p = new Promise((res) => {
            msg.on('body', (stream) => {
              simpleParser(stream, async (err, mail) => {
                if (err) { res(); return; }
                await _updateCacheFromMail(mail);
                if (uid) {
                  _processedUids.add(uid);
                  if (_processedUids.size > 2000) {
                    const arr = [..._processedUids];
                    _processedUids.clear();
                    arr.slice(-1000).forEach(u => _processedUids.add(u));
                  }
                }
                res();
              });
            });
          });
          promises.push(p);
        });
        fetch.once('end', async () => { await Promise.all(promises); resolve(); });
        fetch.once('error', () => resolve());
      });
    });
  } catch(e) { console.error('IMAP poll error:', e.message); }
  _imapPolling = false;
}

async function _updateCacheFromMail(mail) {
  const toValues = (mail.to?.value || []).map(a => (a.address||'').toLowerCase());
  const toText = mail.to?.text || '';
  const fromValues = (mail.from?.value || []).map(a => (a.address||'').toLowerCase());
  const subject = (mail.subject || '').toLowerCase();
  const bodyHtml = mail.html || '';
  const bodyText = mail.text || '';
  const bodyPlain = (bodyHtml || bodyText).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  const ts = mail.date ? new Date(mail.date).getTime() : Date.now();
  const toEmail = toValues[0] || toText.toLowerCase().trim();

  const accounts = loadAccounts().filter(a => a.active);
  for (const account of accounts) {
    const emailLower = account.email.toLowerCase();
    const matched = toValues.some(a => a === emailLower)
      || toText.toLowerCase().includes(emailLower)
      || fromValues.some(a => a === emailLower)
      || (mail.text||'').toLowerCase().includes(emailLower);
    if (!matched) continue;

    const parsed = await classifyEmail({ subject, bodyHtml, bodyText, bodyPlain, toEmail, ts, includeSignin: true });
    if (!parsed) continue;

    const existing = emailCodeCache.get(emailLower);
    const codes = existing ? existing.codes : [];
    const key = parsed.code || parsed.link;
    if (key && !codes.find(c => (c.code||c.link) === key)) {
      setCodesInCache(emailLower, [parsed, ...codes].slice(0, 10));
    }
  }
}

// Smart polling - 15s when customers active, 2min when idle
setInterval(() => {
  if (hasRecentActivity()) {
    _pollAll();
  }
}, 15000);
// Always poll every 2 minutes regardless (keep cache fresh)
setInterval(() => _pollAll(), 2*60*1000);



const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
// nfpro.store fallback API - used only by the public /api/codes tool when our own
// IMAP finds nothing. Key lives in an env var (NFPRO_API_KEY); the literal below is a
// fallback default so it still works if the env var isn't set yet.
const NFPRO_API_KEY = process.env.NFPRO_API_KEY || '5f9233eec713d7d8e5ab213c99d1b532';
const NFPRO_API_URL = process.env.NFPRO_API_URL || 'https://nfpro.store/api/v1/fetch';
// Second fallback code-fetch provider (different vendor from nfpro.store). Only
// known choice so far is 'login_code' - add more to FFU_CHOICES below once their
// docs/testing reveal what else they support (e.g. household, update, 2FA, reset).
// Confirmed full choice list from FFU's docs (6 total). 'household' and
// 'login_code' are approved for the customer dashboard (via publicSafeCodes);
// the other 4 are new/unverified and stay admin-only (/vionex) until confirmed
// safe - see FFU_CHOICE_META below for the type each one maps to.
const FFU_API_KEY = process.env.FFU_API_KEY || 'ffu_CXfcaE7pQ3QHjFsE4mKxjAbNJXP0GErfhtSBqPxS';
const FFU_API_URL = process.env.FFU_API_URL || 'https://web-household-30-production.up.railway.app/api/v1/fetch';
const FFU_CHOICES = ['household', 'reset', 'login_code', 'verification_code_after_login', 'verify_email', 'tv_login'];
// Secret full-access tool page - same UI as the public tool, but unlocks 4-digit
// (sign-in) and 6-digit (verification) codes on top of household/update. Gated by
// BOTH the secret path AND a secret key baked into the page server-side (never in
// the public index.html file), so guessing the path alone isn't enough.
const ADMIN_TOOL_PATH = process.env.ADMIN_TOOL_PATH || '/vionex';
const ADMIN_TOOL_KEY = process.env.ADMIN_TOOL_KEY || 'e5c66efb023a701785177b83';

// ── MULTI-DOMAIN WHITE-LABEL BRANDING ────────────────────────────────────────
// Each entry customizes the public tool page for one domain: brand name, accent
// color, WhatsApp contact, title/description, and footer line. To add a new
// domain: point its DNS at this Railway service (Custom Domain in Railway
// settings), then add an entry below keyed by the exact hostname (no https://,
// no trailing slash, no www). Any domain not listed here gets DEFAULT_BRAND.
const BRANDS = {
  'household.fanflixbd.com': {
    name: 'FANFLIX',
    accent: '#e11d3c', accentDark: '#c8102f', accentSoft: 'rgba(225,29,60,.1)',
    whatsapp: '8801928382918',
    title: 'FANFLIX \u2013 Netflix & Combo Subscriptions in Bangladesh',
    description: 'Netflix and combo subscriptions delivered instantly in Bangladesh. Get your household verification code in one click.',
    footer: '\u00a9 FANFLIX BD \u00b7 Household Code Tool \u00b7 All rights reserved',
  },
  // Add more domains below, following the same shape. Example:
  // 'yourbrand.com': {
  //   name: 'YOURBRAND',
  //   accent: '#2f6fd6', accentDark: '#1f4fa0', accentSoft: 'rgba(47,111,214,.1)',
  //   whatsapp: '8801XXXXXXXXX',
  //   title: 'YOURBRAND \u2013 Netflix Subscriptions',
  //   description: 'Netflix subscriptions delivered instantly.',
  //   footer: '\u00a9 YOURBRAND \u00b7 Household Code Tool \u00b7 All rights reserved',
  // },
};
const DEFAULT_BRAND = BRANDS['household.fanflixbd.com'];

function getBrand(hostname) {
  const h = (hostname || '').toLowerCase().replace(/^www\./, '');
  return BRANDS[h] || DEFAULT_BRAND;
}

// Rewrites brand-specific strings in a page's HTML (title, meta description,
// accent color CSS vars, WhatsApp number, footer, and every "FANFLIX" logo
// mention) to match the requesting domain's brand.
function applyBrand(html, brand) {
  let out = html;
  out = out.replace(/<title>[^<]*<\/title>/, `<title>${brand.title}</title>`);
  out = out.replace(/(<meta name="description" content=")[^"]*(")/, `$1${brand.description}$2`);
  out = out.replace(/--accent:#[0-9a-fA-F]{3,8};--accent-h:#[0-9a-fA-F]{3,8};--accent-soft:rgba\([^)]*\);/,
    `--accent:${brand.accent};--accent-h:${brand.accentDark};--accent-soft:${brand.accentSoft};`);
  out = out.replace(/\u00a9 FANFLIX BD[^<]*/, brand.footer);
  out = out.replaceAll('FANFLIX', brand.name);
  out = out.replaceAll('8801928382918', brand.whatsapp);
  return out;
}
const PORT = process.env.PORT || 3000;
const TG_TOKEN = process.env.TG_TOKEN || '8653224571:AAEYZfrLWtRk_U-A0t6e3sudBSibrtW2meE';
const TG_CHAT = process.env.TG_CHAT || '-1002242163455';
const ADMIN_PASS = process.env.ADMIN_PASS || '@Orsha420@';
const DATA_DIR = (() => {
  const preferred = '/app/data';
  const fallback = '/tmp/fanflix-data';
  try {
    require('fs').mkdirSync(preferred, { recursive: true });
    require('fs').writeFileSync(preferred + '/.test', '1');
    require('fs').unlinkSync(preferred + '/.test');
    return preferred;
  } catch(e) {
    console.log('Volume not available, using fallback:', fallback);
    require('fs').mkdirSync(fallback, { recursive: true });
    return fallback;
  }
})();
const LINKS_FILE = `${DATA_DIR}/links.json`;
const ANALYTICS_FILE = `${DATA_DIR}/analytics.json`;
const IP_FILE = `${DATA_DIR}/ips.json`;

// Streaming product credential stores - one accounts + links file per product
const STREAMING_PRODUCTS = {
  prime:     { name: 'Amazon Prime Video',  accountsFile: `${DATA_DIR}/prime-accounts.json`,   linksFile: `${DATA_DIR}/prime-links.json`   },
  hbo:       { name: 'HBO Max',             accountsFile: `${DATA_DIR}/hbo-accounts.json`,     linksFile: `${DATA_DIR}/hbo-links.json`     },
  disney:    { name: 'Disney+',             accountsFile: `${DATA_DIR}/disney-accounts.json`,  linksFile: `${DATA_DIR}/disney-links.json`  },
  chatgpt:   { name: 'ChatGPT Plus',        accountsFile: `${DATA_DIR}/chatgpt-accounts.json`, linksFile: `${DATA_DIR}/chatgpt-links.json` },
  netflix3p: { name: 'Netflix Account',     accountsFile: `${DATA_DIR}/netflix3p-accounts.json`, linksFile: `${DATA_DIR}/netflix3p-links.json` },
};

// Slot layouts per product - slots = max people sharing one profile
const STREAMING_PROFILES = {
  prime:     [ {profile:'Profile A',slots:2,pin:'56561'},{profile:'Profile B',slots:2,pin:'56562'},{profile:'Profile C',slots:2,pin:'56563'},{profile:'Profile D',slots:2,pin:'56564'},{profile:'Profile E',slots:1,pin:'56565'},{profile:'Profile F',slots:1,pin:'56566'} ],
  hbo:       [ {profile:'Profile A',slots:2,pin:'5651'},{profile:'Profile B',slots:2,pin:'5652'},{profile:'Profile C',slots:2,pin:'5653'},{profile:'Profile D',slots:2,pin:'5654'},{profile:'Profile E',slots:2,pin:'5655'} ],
  disney:    [ {profile:'Profile A',slots:2,pin:'5651'},{profile:'Profile B',slots:2,pin:'5652'},{profile:'Profile C',slots:2,pin:'5653'},{profile:'Profile D',slots:2,pin:'5654'},{profile:'Profile E',slots:2,pin:'5655'},{profile:'Profile F',slots:2,pin:'5656'},{profile:'Profile G',slots:2,pin:'5657'} ],
  chatgpt:   null, // no profiles - fixed credentials, capacity tracked by customer count per account (max 15)
  netflix3p: [ {profile:'Profile A',slots:2,pin:'5651'},{profile:'Profile B',slots:2,pin:'5652'},{profile:'Profile C',slots:1,pin:'5653'},{profile:'Profile D',slots:1,pin:'5654'},{profile:'Profile E',slots:1,pin:'5655'} ],
};

function loadStreamingAccounts(type) { try { return JSON.parse(fs.readFileSync(STREAMING_PRODUCTS[type].accountsFile,'utf8')); } catch(e) { return []; } }
function saveStreamingAccounts(type, data) { ensureDataDir(); fs.writeFileSync(STREAMING_PRODUCTS[type].accountsFile, JSON.stringify(data,null,2)); }
function loadStreamingLinks(type) { try { return JSON.parse(fs.readFileSync(STREAMING_PRODUCTS[type].linksFile,'utf8')); } catch(e) { return {}; } }
function saveStreamingLinks(type, data) { ensureDataDir(); fs.writeFileSync(STREAMING_PRODUCTS[type].linksFile, JSON.stringify(data,null,2)); }

function generateStreamingToken(type) {
  return type + '-' + crypto.randomBytes(6).toString('hex');
}

function getMaxSlotsForStreamingAccount(type) {
  const profiles = STREAMING_PROFILES[type];
  if (!profiles) return 15; // chatgpt: 15 per account
  return profiles.reduce((sum, p) => sum + p.slots, 0);
}

function getNextAvailableStreamingSlot(type, days) {
  const accounts = loadStreamingAccounts(type);
  const links = loadStreamingLinks(type);
  const profiles = STREAMING_PROFILES[type];
  const now = Date.now();

  for (const account of accounts) {
    if (!account.active) continue;
    const accountLinks = Object.values(links).filter(l => l.accountId === account.id && l.active && !l.released);

    if (!profiles) {
      // ChatGPT: no profiles, just count active customers per account
      if (accountLinks.length < 15) {
        return { accountId: account.id, email: account.email, password: account.password, profile: null, pin: null };
      }
    } else {
      const usedProfiles = accountLinks.map(l => l.profile);
      for (const prof of profiles) {
        const used = usedProfiles.filter(p => p === prof.profile).length;
        if (used < prof.slots) {
          return { accountId: account.id, email: account.email, password: account.password, profile: prof.profile, pin: account.pins?.[prof.profile] || prof.pin || null };
        }
      }
    }
  }
  return null;
}
const LOGIN_VIDEO = process.env.LOGIN_VIDEO || 'https://youtu.be/PLACEHOLDER1';
const HOUSEHOLD_VIDEO = process.env.HOUSEHOLD_VIDEO || 'https://youtu.be/PLACEHOLDER2';
const SITE_URL = process.env.SITE_URL || 'https://household.fanflixbd.com';
const UDDOKTAPAY_API_KEY = process.env.UDDOKTAPAY_API_KEY || 'WCHHkn251WojpUh2zKc8UKSVe5UXCRR0sOLkS6tL';
const RESPONDIO_API_KEY = process.env.RESPONDIO_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MzMzNjQsInNwYWNlSWQiOjM1MjU5OCwib3JnSWQiOjM0NzU3MywidHlwZSI6ImFwaSIsImlhdCI6MTc4NTQxMTk5M30.K1MNnRwqq2kZDdW8lg-EXH1vLEc8p_yTYNKr_uEWVF4';
const RESPONDIO_CHANNEL_ID = 442671;

// Generic WhatsApp template sender via Respond.io's Messages API.
// Respond.io requires the contact to already exist before you can message them -
// so we create (or update, if already exists) the contact first, then send.
// Returns true if Respond.io accepted the send request, false otherwise.
// NOTE: "accepted" is not the same as "delivered" - Respond.io may still fail
// to actually deliver (bad number, no WhatsApp, etc.) after accepting the call.
async function sendWhatsAppTemplate(phone, customerName, templateName, components) {
  try {
    const num = String(phone).replace(/\D/g,'');
    if (!num || num.length < 7) return false;
    // Keep the number's own country code. Only add 880 (Bangladesh) when the number
    // clearly has no country code - i.e. a local BD number starting with 0 or a bare
    // 10-digit 1XXXXXXXXX mobile. Numbers that already include a country code (11+ digits
    // not starting with 0) are used as-is, so foreign customers receive delivery too.
    let respondPhone;
    if (num.startsWith('880')) {
      respondPhone = num;
    } else if (num.startsWith('0')) {
      respondPhone = '880' + num.replace(/^0+/, ''); // local BD format 01XXXXXXXXX
    } else if (num.length === 10 && num.startsWith('1')) {
      respondPhone = '880' + num; // bare BD mobile without leading 0
    } else {
      respondPhone = num; // already has a country code (foreign or otherwise) - use as-is
    }
    const firstName = (customerName || 'FanFlix Customer').split(' ')[0] || 'FanFlix';
    const lastName = (customerName || '').split(' ').slice(1).join(' ') || '';

    // Step 1: create (or update) the contact - required before messaging is possible.
    try {
      const contactRes = await fetch(`https://api.respond.io/v2/contact/phone:${respondPhone}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RESPONDIO_API_KEY}`,
        },
        body: JSON.stringify({ phone: `+${respondPhone}`, firstName, lastName }),
      });
      if (!contactRes.ok) {
        const errText = await contactRes.text();
        const alreadyExists = contactRes.status === 403 && /already exist/i.test(errText);
        if (!alreadyExists) {
          console.error(`Respond.io contact create failed (${templateName}):`, contactRes.status, errText.slice(0,300));
        }
      }
    } catch(e) {
      console.error(`Respond.io contact create error (${templateName}):`, e.message);
    }

    const payload = {
      channelId: RESPONDIO_CHANNEL_ID,
      message: {
        type: 'whatsapp_template',
        template: { name: templateName, languageCode: 'en', components },
      },
    };

    // Respond.io's own guidance: wait after creating a contact before the next
    // action - the contact resource needs time to finish being created first.
    await new Promise(r => setTimeout(r, 8000));

    // Retry on 449 (Respond.io's own "queued, try again shortly" status).
    let res, lastErrText = '';
    const backoffs = [10000, 20000, 30000];
    for (let attempt = 1; attempt <= 4; attempt++) {
      res = await fetch(`https://api.respond.io/v2/contact/phone:${respondPhone}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RESPONDIO_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) break;
      lastErrText = await res.text();
      if (res.status !== 449 || attempt > backoffs.length) break;
      const wait = backoffs[attempt-1];
      console.error(`Respond.io send queued (${templateName}, attempt ${attempt}/4), retrying in ${wait/1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }

    if (!res.ok) {
      console.error(`Respond.io send failed (${templateName}):`, res.status, lastErrText.slice(0,300));
      return false;
    }
    // Respond.io returns 200 even when a message is only "queued". Parse the body and
    // confirm it wasn't rejected - a failed/rejected status means the number couldn't
    // receive it (e.g. not on WhatsApp), and we must treat that as a failure so the
    // caller releases the slot instead of wasting it.
    try {
      const okBody = await res.json();
      const status = (okBody.status || okBody.messageStatus || '').toString().toLowerCase();
      if (status && /fail|reject|error|invalid|undeliver/.test(status)) {
        console.error(`Respond.io message rejected (${templateName}):`, status);
        return false;
      }
    } catch(e) { /* no JSON body / not parseable - treat 200 as accepted */ }
    return true;
  } catch(e) {
    console.error(`sendWhatsAppTemplate error (${templateName}):`, e.message);
    return false;
  }
}

// netflix_delivery - approved template, sends account credentials + dashboard link
async function sendWhatsAppDelivery(phone, email, profile, dashboardLink, customerName) {
  return sendWhatsAppTemplate(phone, customerName, 'netflix_delivery', [
    { type: 'header', format: 'text', text: 'Your Netflix Account Is Ready!', parameters: [] },
    {
      type: 'body',
      text: 'Email: {{1}}\nProfile: {{2}}\n\nDashboard Link: {{3}}\n\nLogin Guide (Must Watch):\nhttps://youtu.be/QGbMYXSumVc\n\n⚠️ Rules: Use this account only on the devices included in your purchase, do not change anything, and use the service only from Bangladesh. Violation may result in immediate subscription cancellation.',
      parameters: [
        { type: 'text', text: email },
        { type: 'text', text: profile },
        { type: 'text', text: dashboardLink },
      ],
    },
    { type: 'footer', text: 'Thank you for choosing FanFlix BD.', parameters: [] },
  ]);
}

// order_confirmation - approved template, sent instantly when payment is confirmed
async function sendOrderConfirmation(phone, customerName, product, amount, orderId) {
  return sendWhatsAppTemplate(phone, customerName, 'order_confirmation', [
    { type: 'header', format: 'text', text: 'Order Confirmation', parameters: [] },
    {
      type: 'body',
      text: 'This is an automated confirmation from FanFlix BD regarding your recent order.\n\nProduct: {{1}}\nAmount paid: ৳{{2}}\nOrder id: {{3}}\n\nYour payment has been received and your order is now being processed. You will receive your account details shortly.',
      parameters: [
        { type: 'text', text: product },
        { type: 'text', text: String(amount) },
        { type: 'text', text: orderId },
      ],
    },
  ]);
}

// universal_renewal_notice - approved template, 2 days before expiry, any product
async function sendUniversalRenewalNotice(phone, customerName, product, daysLeft) {
  return sendWhatsAppTemplate(phone, customerName, 'universal_renewal_notice', [
    { type: 'header', format: 'text', text: 'Account Status Update', parameters: [] },
    {
      type: 'body',
      text: 'This is an automated notice regarding your {{1}} account. Your current service period ends in {{2}} day(s). Please reply this text to manage your renewal.',
      parameters: [
        { type: 'text', text: product },
        { type: 'text', text: String(daysLeft) },
      ],
    },
    { type: 'footer', text: 'Thank you for choosing FanFlix BD!', parameters: [] },
  ]);
}

// universal_account_delivery - approved template, sends credentials + dashboard link
// Works for Prime, HBO, Disney+, ChatGPT and any future streaming product.
async function sendUniversalAccountDelivery(phone, customerName, product, email, password, profile, pin) {
  return sendWhatsAppTemplate(phone, customerName, 'universal_account_delivery', [
    { type: 'header', format: 'text', text: 'Account Delivery', parameters: [] },
    {
      type: 'body',
      text: 'This is an automated delivery from FanFlix BD regarding your recent order.\n\n📦 Product: {{1}}\n\n📧 Email: {{2}}\n🔑 Password: {{3}}\n👤 Profile: {{4}}\n🔢 PIN: {{5}}\n\n⚠️ Please use only the profile assigned to you. Do not change anything and do not login on more than 2 devices.',
      parameters: [
        { type: 'text', text: product },
        { type: 'text', text: email },
        { type: 'text', text: password },
        { type: 'text', text: profile || 'Shared Account (no profile)' },
        { type: 'text', text: pin || 'Not required' },
      ],
    },
    { type: 'footer', text: 'Thank you for choosing FanFlix BD!', parameters: [] },
  ]);
}

async function sendPaymentPendingNotice(phone, customerName, product, orderId) {
  return sendWhatsAppTemplate(phone, customerName, 'payment_pending_notice', [
    { type: 'header', format: 'text', text: 'Payment Pending', parameters: [] },
    {
      type: 'body',
      text: 'This is an automated notice from FanFlix BD regarding your recent order.\n\nProduct: {{1}}\nOrder id: {{2}}\n\nOur records show that payment has not yet been completed for this order. If you have already made the payment, please reply to this message with your payment details so we can verify and process your order.',
      parameters: [
        { type: 'text', text: product },
        { type: 'text', text: orderId },
      ],
    },
  ]);
}

const UDDOKTAPAY_BASE_URL = process.env.UDDOKTAPAY_BASE_URL || 'https://payment.fanflixbd.com/api';
const PAYMENT_URL = process.env.PAYMENT_URL || 'https://pg.eps.com.bd/DefaultPaymentLink?id=805A9AEE';
const WA_NUMBER = '8801928382918';
const EPS_BOT_URL = process.env.EPS_BOT_URL || 'https://eps-fanflix-ipn-production.up.railway.app';

const PLANS = [
  { id:'netflix-mobile-1m', name:'Netflix Mobile 1M', price:350, days:30, product:'Netflix Subscription' },
  { id:'netflix-tv-1m',     name:'Netflix TV 1M',     price:450, days:30, product:'Netflix TV Subscription' },
  { id:'netflix-tv-3m',     name:'Netflix TV 3M',     price:1350,days:90, product:'Netflix TV Subscription 3M' },
  { id:'combo-mobile-1m',   name:'Combo Mobile 1M',   price:389, days:30, product:'Netflix+Prime Mobile 1M' },
  { id:'combo-tv-1m',       name:'Combo TV 1M',       price:489, days:30, product:'Netflix+Prime TV 1M' },
  { id:'combo-tv-3m',       name:'Combo TV 3M',       price:1500,days:90, product:'Netflix+Prime TV 3M' },
];
const MAX_SLOTS = 8; // default (mobile accounts) - use getSlotConfig(account) for actual per-account total
const BLOCKED_CODES = ['2023','2024','2025','2026','2027','2028','0000'];

// Mobile accounts (default/unchanged): 8 slots total
const MOBILE_PROFILES = [
  { profile: 'Profile A', pin: '5651', slots: 2 },
  { profile: 'Profile B', pin: '5652', slots: 2 },
  { profile: 'Profile C', pin: '5653', slots: 2 },
  { profile: 'Profile D', pin: '5654', slots: 1 },
  { profile: 'Profile E', pin: '5655', slots: 1 },
];
// TV accounts: 7 slots total - Profile C reduced to 1 slot (TV usage causes more household churn)
const TV_PROFILES = [
  { profile: 'Profile A', pin: '5651', slots: 2 },
  { profile: 'Profile B', pin: '5652', slots: 2 },
  { profile: 'Profile C', pin: '5653', slots: 1 },
  { profile: 'Profile D', pin: '5654', slots: 1 },
  { profile: 'Profile E', pin: '5655', slots: 1 },
];
// Backward-compat alias - existing code that references FIXED_PROFILES keeps working (mobile behavior)
const FIXED_PROFILES = MOBILE_PROFILES;

// Returns the correct profile/slot layout for an account based on its tagged device type.
// Untagged accounts (deviceType missing) default to mobile behavior for backward compatibility.
function getSlotConfig(account) {
  return (account && account.deviceType === 'tv') ? TV_PROFILES : MOBILE_PROFILES;
}
function getMaxSlotsForAccount(account) {
  return getSlotConfig(account).reduce((sum,p) => sum+p.slots, 0);
}
// Determines mobile vs tv from a product/plan name string. Defaults to 'mobile' if unclear.
function detectDeviceType(productName) {
  return String(productName||'').toLowerCase().includes('tv') ? 'tv' : 'mobile';
}

function ensureDataDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {} }
function loadLinks() { try { return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); } catch(e) { return {}; } }
function saveLinks(links) { ensureDataDir(); fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2)); }
function loadAnalytics() { try { return JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8')); } catch(e) { return {}; } }
function saveAnalytics(data) { ensureDataDir(); fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(data, null, 2)); }
function loadIPs() { try { return JSON.parse(fs.readFileSync(IP_FILE, 'utf8')); } catch(e) { return {}; } }
function saveIPs(data) { ensureDataDir(); fs.writeFileSync(IP_FILE, JSON.stringify(data, null, 2)); }
const GEO_FILE      = DATA_DIR + '/geo.json';
const ACCOUNTS_FILE = DATA_DIR + '/accounts.json';
const SETTINGS_FILE  = DATA_DIR + '/settings.json';
const NETFLIX_ALERTS_FILE = DATA_DIR + '/netflix-alerts.json';
const DELETED_EMAILS_FILE = DATA_DIR + '/deleted-emails.json';
// Load persisted deleted-account emails on startup so alerts stay suppressed across restarts.
try {
  const savedDeleted = JSON.parse(fs.readFileSync(DELETED_EMAILS_FILE, 'utf8'));
  if (Array.isArray(savedDeleted)) savedDeleted.forEach(e => deletedAccountEmails.add(e));
} catch(e) { /* file doesn't exist yet - fine */ }
function persistDeletedEmails() {
  try { ensureDataDir(); fs.writeFileSync(DELETED_EMAILS_FILE, JSON.stringify([...deletedAccountEmails], null, 2)); }
  catch(e) { console.error('persistDeletedEmails error:', e.message); }
}
function loadNetflixAlerts() { try { return JSON.parse(fs.readFileSync(NETFLIX_ALERTS_FILE,'utf8')); } catch(e) { return []; } }
function saveNetflixAlerts(data) { ensureDataDir(); fs.writeFileSync(NETFLIX_ALERTS_FILE, JSON.stringify(data,null,2)); }
const WAITLIST_FILE  = DATA_DIR + '/waitlist.json';
function loadWaitlist() { try { return JSON.parse(fs.readFileSync(WAITLIST_FILE,'utf8')); } catch(e) { return []; } }
function saveWaitlist(data) { ensureDataDir(); fs.writeFileSync(WAITLIST_FILE, JSON.stringify(data,null,2)); }

// Normalize customer days to match account plan types (30/90/170)
function normalizeDays(d) {
  const n = parseInt(d) || 30;
  if (n <= 30) return 30;
  if (n <= 90) return 90;
  return 170;
}

function normalizeProfile(p) {
  if (!p) return '';
  p = String(p).trim();
  if (p.length === 1) return 'Profile ' + p.toUpperCase();
  return p;
}

function getFreeSlots() {
  const accounts = loadAccounts();
  const links = loadLinks();
  let free = 0;
  for (const account of accounts.filter(a=>a.active)) {
    // Occupied = link exists and NOT released (regardless of expiry - manual release required)
    const occupyingLinks = Object.values(links).filter(l=>l.email===account.email&&l.active&&!l.released);
    const usedProfiles = occupyingLinks.map(l=>normalizeProfile(l.profile));
    const profileConfig = getSlotConfig(account);
    for (const prof of profileConfig) {
      const used = usedProfiles.filter(p=>p===prof.profile).length;
      free += Math.max(0, prof.slots - used);
    }
  }
  return free;
}

const LOW_STOCK_THRESHOLD = 10;
let lastLowStockAlert = 0;
function checkLowStock() {
  const free = getFreeSlots();
  const now = Date.now();
  if (free <= LOW_STOCK_THRESHOLD && now - lastLowStockAlert > 3600000) {
    lastLowStockAlert = now;
    sendTelegram(`⚠️ <b>Low Stock Alert!</b>\n\nOnly <b>${free} slots</b> remaining!\nAdd more Netflix accounts soon.`);
  }
  return free;
}
function loadAccounts() { try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE,'utf8')); } catch(e) { return []; } }

// Renewal = customer's link was never released, so their slot is still theirs (even if expired late).
// Just extend it directly - no new slot needed since they never lost their spot.
function renewCustomerLink(allLinks, token, days) {
  const link = allLinks[token];
  link.expiresAt += days * 24 * 60 * 60 * 1000;
  link.warningSent = false;
  link.expiredSmsSent = false;
  link.renewalSmsSent = false;
  link.renewalCount = (link.renewalCount || 0) + 1;
}

function saveAccounts(data) { ensureDataDir(); fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data,null,2)); }
function loadSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8')); } catch(e) { return { autoLink: false }; } }
function saveSettings(data) { ensureDataDir(); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data,null,2)); }
function loadGeo() { try { return JSON.parse(fs.readFileSync(GEO_FILE, 'utf8')); } catch(e) { return {}; } }
function saveGeo(data) { ensureDataDir(); fs.writeFileSync(GEO_FILE, JSON.stringify(data, null, 2)); }

function trackAnalytics(token) {
  const data = loadAnalytics();
  if (!data[token]) data[token] = { total: 0, daily: {} };
  data[token].total += 1;
  const today = new Date().toISOString().split('T')[0];
  data[token].daily[today] = (data[token].daily[today] || 0) + 1;
  saveAnalytics(data);
}

// Tracks IP synchronously (fast), returns count + whether this IP is new.
// Geo lookup for new IPs should be triggered separately in the background.
function trackIPSync(token, ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1') return { count: 0, isNew: false };
  const data = loadIPs();
  if (!data[token]) data[token] = [];
  const isNew = !data[token].includes(ip);
  if (isNew) {
    data[token].push(ip);
    saveIPs(data);
  }
  return { count: data[token].length, isNew };
}

// Geo lookup + outside-BD alert - runs in background, never blocks customer response
async function checkGeoAndAlert(token, ip) {
  try {
    const geoRes = await fetch(`https://ipwho.is/${ip}`);
    const raw = await geoRes.json();
    if (raw.success === false) return; // lookup failed (private IP, invalid, rate limited, etc.)
    const geo = { country: raw.country, countryCode: raw.country_code };

    // Detect datacenter/hosting IPs. Railway's own edge/proxy sometimes forwards a
    // datacenter IP (its Singapore region) instead of the real customer IP - those are
    // the false positives that previously locked out real BD customers. ipwho.is marks
    // these under connection.type / isp. We NEVER auto-block a datacenter IP.
    const connType = (raw.connection?.type || '').toLowerCase();
    const isp = (raw.connection?.isp || raw.connection?.org || '').toLowerCase();
    const datacenterHints = ['hosting','datacenter','data center','cloud','server','railway','amazon','aws','google','microsoft','azure','digitalocean','ovh','linode','vultr','hetzner'];
    const looksDatacenter = connType.includes('hosting') || datacenterHints.some(h => isp.includes(h));

    if (geo.countryCode && geo.countryCode !== 'BD') {
      const geoData = loadGeo();
      if (!geoData[token]) geoData[token] = [];
      const already = geoData[token].find(g => g.ip === ip);
      if (!already) {
        geoData[token].push({ ip, country: geo.country, code: geo.countryCode, datacenter: looksDatacenter, ts: Date.now() });
        saveGeo(geoData);
      }
      const links = loadLinks();
      const link = links[token];

      // Block on the FIRST confirmed residential (non-datacenter) foreign IP.
      // Datacenter/hosting IPs are still skipped entirely - those are Railway's own
      // routing false-reads, never a real customer. A real customer on a residential
      // foreign IP gets blocked immediately (no second chance).
      const shouldAutoBlock = !looksDatacenter && link && link.active && !link.released;

      if (shouldAutoBlock) {
        // Auto-block: release the slot so it can't keep being used from abroad.
        link.active = false;
        link.released = true;
        link.autoBlockedAt = Date.now();
        link.autoBlockedReason = 'outside_bd';
        links[token] = link;
        saveLinks(links);
        sendTelegram(`🚫 <b>AUTO-BLOCKED — Outside BD!</b>\n\n🔗 /c/${token}\n📧 ${link?.email||'unknown'}\n👤 ${link?.profile||'unknown'}\n📱 ${link?.phone||'unknown'}\n📍 ${geo.country} (${geo.countryCode})\n🌐 IP: ${ip}\n\n✅ Slot released automatically (residential foreign login). Restore from Recycle Bin if this was a mistake.`);
      } else {
        // Datacenter/proxy IP - alert only, never block (avoids Railway false-reads).
        sendTelegram(`🌍 <b>Outside BD Login Detected (not blocked)</b>\n\n🔗 /c/${token}\n📧 ${link?.email||'unknown'}\n👤 ${link?.profile||'unknown'}\n📱 ${link?.phone||'unknown'}\n📍 ${geo.country} (${geo.countryCode})\n🌐 IP: ${ip}\n⚠️ IP looks like a datacenter/proxy (possibly Railway's own routing) — NOT auto-blocked. Review manually if needed.`);
      }

      try {
        const alerts = loadNetflixAlerts();
        alerts.unshift({
          source: 'dashboard',
          email: link?.email || 'unknown',
          location: `${geo.country} (${geo.countryCode})`,
          device: ip,
          token: token,
          profile: link?.profile || '',
          phone: link?.phone || '',
          customerName: link?.customerName || '',
          autoBlocked: shouldAutoBlock,
          datacenter: looksDatacenter,
          ts: Date.now(),
        });
        saveNetflixAlerts(alerts.slice(0, 100));
      } catch(e) { console.error('Save dashboard alert error:', e.message); }
    }
  } catch(e) { console.error('Geo lookup error:', e.message); }
}

function getNextAvailableSlot(customerDays, deviceType) {
  const accounts = loadAccounts();
  const links = loadLinks();
  const days = normalizeDays(customerDays);
  const wantType = deviceType === 'tv' ? 'tv' : 'mobile';

  function tryAccounts(accountList) {
    for (const account of accountList) {
      const email = account.email;
      // Skip accounts with no valid email - assigning one would create a broken
      // link that shows "invalid" to the customer.
      if (!email || !String(email).trim() || !String(email).includes('@')) continue;
      // Untagged accounts default to mobile for backward compatibility
      const accountType = account.deviceType === 'tv' ? 'tv' : 'mobile';
      if (accountType !== wantType) continue;
      // Occupied = link exists and NOT released (regardless of expiry)
      const occupyingLinks = Object.values(links).filter(l => l.email===email && l.active && !l.released);
      const usedProfiles = occupyingLinks.map(l => normalizeProfile(l.profile));
      const profileConfig = getSlotConfig(account);
      for (const prof of profileConfig) {
        const used = usedProfiles.filter(p => p === prof.profile).length;
        if (used < prof.slots) {
          return { email, profile: prof.profile, pin: prof.pin };
        }
      }
    }
    return null;
  }

  // Sort helper: accounts with a recent slot release get priority (fill freed slots first),
  // then fall back to serial order (oldest addedAt first)
  function prioritySort(list) {
    return [...list].sort((a,b) => {
      const aReleased = a.lastReleasedAt || 0;
      const bReleased = b.lastReleasedAt || 0;
      if (aReleased !== bReleased) return bReleased - aReleased; // most recently released first
      return (a.addedAt||0) - (b.addedAt||0); // then serial order
    });
  }

  // First try: accounts matching customer plan
  const matched = prioritySort([...accounts].filter(a => a.active && a.planDays && parseInt(a.planDays) === days));
  const result = tryAccounts(matched);
  if (result) return result;

  // Second try: accounts with no plan set
  const anyPlan = prioritySort([...accounts].filter(a => a.active && !a.planDays));
  return tryAccounts(anyPlan);
}


function generateToken() { return crypto.randomBytes(4).toString('hex'); }

let totalToday = 0, lastReset = new Date().toDateString();
const visitors = new Map();
function resetDailyIfNeeded() { const t = new Date().toDateString(); if (t !== lastReset) { totalToday = 0; lastReset = t; } }
function trackVisitor(ip) { visitors.set(ip, Date.now()); const c = Date.now()-5*60*1000; for(const[k,v] of visitors) if(v<c) visitors.delete(k); }
let lastCustomerActivity = 0;
function markActivity() { lastCustomerActivity = Date.now(); }
function hasRecentActivity() { return Date.now() - lastCustomerActivity < 2*60*1000; } // active in last 2 min
function getLiveVisitors() { const c = Date.now()-5*60*1000; return [...visitors.values()].filter(v=>v>c).length; }

const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const e = rateLimitMap.get(ip) || { count:0, start:now };
  if (now - e.start > 5*60*1000) { rateLimitMap.set(ip,{count:1,start:now}); return false; }
  if (e.count >= 10) return true;
  e.count++; rateLimitMap.set(ip,e); return false;
}

const cache = new Map();
function getCached(key) { const e=cache.get(key); if(e&&Date.now()-e.time<30000) return e.data; return null; }
function setCache(key, data) { cache.set(key, {data, time:Date.now()}); }


async function sendTelegram(msg, chatId=TG_CHAT) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id:chatId, text:msg, parse_mode:'HTML', disable_web_page_preview:true })
    });
  } catch(e) { console.error('TG error:', e.message); }
}

function scheduleMorningReport() {
  const now = new Date();
  const bd = new Date(now.getTime() + 6*60*60*1000);
  const next11am = new Date(bd);
  next11am.setUTCHours(5,0,0,0);
  if (bd.getUTCHours() >= 5) next11am.setUTCDate(next11am.getUTCDate()+1);
  const msUntil = next11am.getTime() - now.getTime();
  setTimeout(() => { sendMorningReport(); setInterval(sendMorningReport, 24*60*60*1000); }, msUntil);
}

async function sendMorningReport() {
  const links = loadLinks();
  const now = Date.now();
  const threeDays = 3*24*60*60*1000;
  const sevenDays = 7*24*60*60*1000;
  const active = Object.values(links).filter(l => l.active && l.expiresAt>now);
  const expired = Object.values(links).filter(l => l.expiresAt<=now);
  let msg = `<b>FanFlix Morning Report</b>\n📅 ${new Date().toLocaleDateString('en-BD',{timeZone:'Asia/Dhaka',weekday:'long',year:'numeric',month:'long',day:'numeric'})}\n\n`;
  msg += `Active: ${active.length} | Expired: ${expired.length}`;
  sendTelegram(msg);
}

function checkExpiringLinks() {
  // Per-link "expiring soon" Telegram notifications removed by request.
  // Renewal reminders now go to customers via WhatsApp (sendUniversalRenewalReminders),
  // and a single daily summary is sent instead of one Telegram per expiring link.
}
setInterval(checkExpiringLinks, 60*60*1000);


// Universal renewal reminder via WhatsApp - once daily at 9:30 PM BD time,
// 2 days before expiry, for ALL active customers regardless of product type.
// Replaces the old BulkSMS-based reminder system entirely.
async function sendUniversalRenewalReminders() {
  const now = Date.now();
  // The reminder job runs once a day (9:30 PM BD). If we only caught links with
  // exactly <=2 days left at that moment, links whose expiry falls in the gap between
  // two daily runs could be skipped entirely (expiry passes before the next run).
  // We widen the window to 3 days AND include already-expired-but-recently links that
  // were never reminded, so far fewer customers get missed. The renewalSmsSent flag
  // still prevents duplicate reminders, and it's reset on every renewal.
  const windowMs = 3 * 24 * 60 * 60 * 1000;
  const graceMs = 1 * 24 * 60 * 60 * 1000; // also remind up to 1 day AFTER expiry (grace)
  const dueLinks = [];

  const isDue = (link) => {
    if (!link.active || link.released) return false;
    if (link.renewalSmsSent) return false;
    const remaining = link.expiresAt - now;
    // Due if it expires within the next 3 days, OR expired within the last 1 day (grace).
    return remaining <= windowMs && remaining >= -graceMs;
  };

  // Netflix links
  const links = loadLinks();
  let changed = false;
  for (const link of Object.values(links)) {
    if (isDue(link)) {
      dueLinks.push({ link, productName: link.plan || 'Netflix' });
      link.renewalSmsSent = true;
      changed = true;
    }
  }
  if (changed) saveLinks(links);

  // Streaming product links (Prime/HBO/Disney+/ChatGPT)
  for (const type of Object.keys(STREAMING_PRODUCTS)) {
    const sLinks = loadStreamingLinks(type);
    let sChanged = false;
    for (const link of Object.values(sLinks)) {
      if (isDue(link)) {
        dueLinks.push({ link, productName: STREAMING_PRODUCTS[type].name });
        link.renewalSmsSent = true;
        sChanged = true;
      }
    }
    if (sChanged) saveStreamingLinks(type, sLinks);
  }

  // Send with a 15s gap between each customer - avoids firing many simultaneous
  // requests at Respond.io, which was causing more "queued" (449) responses.
  // Instead of one Telegram per customer, we tally results and send a single summary.
  let sentCount = 0;
  const failedList = [];
  for (const { link, productName } of dueLinks) {
    if (link.phone) {
      const remaining = link.expiresAt - now;
      const daysLeft = Math.max(1, Math.ceil(remaining/(24*60*60*1000)));
      const ok = await sendUniversalRenewalNotice(link.phone, link.customerName, productName, daysLeft);
      if (ok) sentCount++;
      else failedList.push(`${link.customerName||'Customer'} (${link.phone})`);
      await new Promise(r => setTimeout(r, 15000));
    }
  }

  // One summary Telegram (only if there was anything to send)
  if (dueLinks.length > 0) {
    let summary = `🔔 <b>Renewal Reminders Sent</b>\n\n✅ Successfully sent to <b>${sentCount}</b> customer(s) today.`;
    if (failedList.length > 0) {
      summary += `\n\n⚠️ <b>Failed (${failedList.length}):</b>\n` + failedList.map(f => `• ${f}`).join('\n') + `\n\nConsider contacting these customers another way.`;
    }
    sendTelegram(summary);
  }
}
function scheduleUniversalRenewalReminders() {
  const now = new Date();
  const bd = new Date(now.getTime() + 6*60*60*1000);
  const next930pm = new Date(bd);
  next930pm.setUTCHours(15, 30, 0, 0); // 21:30 BD = 15:30 UTC
  if (bd.getUTCHours() > 15 || (bd.getUTCHours() === 15 && bd.getUTCMinutes() >= 30)) {
    next930pm.setUTCDate(next930pm.getUTCDate() + 1);
  }
  const msUntil = next930pm.getTime() - now.getTime();
  setTimeout(() => {
    sendUniversalRenewalReminders();
    setInterval(sendUniversalRenewalReminders, 24*60*60*1000);
  }, msUntil);
}
try { scheduleUniversalRenewalReminders(); } catch(e) { console.error('Universal renewal reminder schedule error:', e.message); }
// Netflix account expiry alert
function checkAccountExpiry() {
  try {
    const accounts = loadAccounts();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    let changed = false;
    for (const account of accounts) {
      if (!account.active || !account.expiresAt) continue;
      if (account.expiresAt === tomorrowStr && !account.expirySent) {
        sendTelegram(`⚠️ <b>Netflix Account Expiring Tomorrow!</b>\n\n📧 ${account.email}\n📅 Expires: ${account.expiresAt}\n\nUpdate the account subscription!`);
        account.expirySent = true;
        changed = true;
      }
      if (account.expirySent && account.expiresAt > tomorrowStr) {
        account.expirySent = false;
        changed = true;
      }
    }
    if (changed) saveAccounts(accounts);
  } catch(e) { console.error('Account expiry check error:', e.message); }
}
setInterval(checkAccountExpiry, 6*60*60*1000);
try { checkAccountExpiry(); } catch(e) {}
try { scheduleMorningReport(); } catch(e) { console.error('Schedule error:', e.message); }

async function scrapeOTP(link) {
  try {
    const res = await fetch(link, {
      headers: { 'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15', 'Accept':'text/html' },
      redirect: 'follow'
    });
    const html = await res.text();
    const patterns = [/>\s*(\d{4})\s*</g, /"code"\s*:\s*"(\d{4})"/, />\s*(\d{4,6})\s*<\/(?:p|h\d|div|span)/];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) { const code=(match[1]||match[0]).replace(/\D/g,''); if(code&&code.length>=4&&!BLOCKED_CODES.includes(code)) return code; }
    }
    const allMatches = [...html.matchAll(/(?<![0-9])(\d{4})(?![0-9])/g)];
    const filtered = allMatches.filter(m=>!BLOCKED_CODES.includes(m[1])&&!['1080','1920','1440'].includes(m[1]));
    if (filtered.length > 0) return filtered[0][1];
    return null;
  } catch(e) { return null; }
}

function fetchNetflixEmails(filterEmail, includeSignin=false) {
  // Check background cache first
  const cached = getCodesFromCache(filterEmail);
  if (cached !== null) return Promise.resolve(cached);
  return fetchNetflixEmailsFresh(filterEmail, includeSignin);
}

function fetchNetflixEmailsFresh(filterEmail, includeSignin=false, attempt=1) {
  return new Promise((resolve, reject) => {
    // Tighter timeouts than the library default (was 5000/4000, up to ~9s) - this
    // function is raced in parallel against nfpro/FFU (each capped at 3s), so a
    // slow IMAP connection was the one piece not actually bounded near the 3s
    // speed target. A faster failure here just means the other parallel sources
    // still deliver a result on time; IMAP isn't the only path anymore.
    const imap = new Imap({
      user: GMAIL_USER, password: GMAIL_PASS,
      host: 'imap.gmail.com', port: 993, tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 2500, authTimeout: 2000
    });
    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) { imap.end(); return reject(err); }
        const since = new Date(Date.now() - 15*60*1000);
        imap.search([['SINCE', since], ['OR', ['FROM', 'netflix'], ['SUBJECT', 'netflix']]], (err, uids) => {
          if (err || !uids || uids.length === 0) { imap.end(); return resolve([]); }
          // Fetch only last 5 UIDs (most recent emails) to reduce load
          const recentUids = uids.slice(-5);
          const fetch = imap.fetch(recentUids, { bodies: '' });
          const promises = [];
          fetch.on('message', (msg) => {
            const p = new Promise((res) => {
              msg.on('body', (stream) => {
                simpleParser(stream, async (err, mail) => {
                  if (err) return res(null);
                  const toValues = (mail.to?.value || []).map(a => (a.address||'').toLowerCase());
                  const toText = mail.to?.text || '';
                  const subject = (mail.subject || '').toLowerCase();
                  const bodyHtml = mail.html || '';
                  const bodyText = mail.text || '';
                  const bodyPlain = (bodyHtml || bodyText).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
                  const ts = mail.date ? new Date(mail.date).getTime() : Date.now();
                  const toEmail = toValues[0] || toText.toLowerCase().trim();
                  if (filterEmail) {
                    const filterLower = filterEmail.toLowerCase().trim();
                    const fromValues = (mail.from?.value || []).map(a => (a.address||'').toLowerCase());
                    const fromText = mail.from?.text || '';
                    // Check TO, FROM (iCloud forwards with FROM=iCloud), and body (Outlook forwards)
                    const matched = toValues.some(a => a === filterLower)
                      || toText.toLowerCase().includes(filterLower)
                      || fromValues.some(a => a === filterLower)
                      || fromText.toLowerCase().includes(filterLower)
                      || (mail.text||'').toLowerCase().includes(filterLower);
                    if (!matched) return res(null);
                  }
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
            resolve(items.sort((a,b) => b.ts - a.ts));
          });
          fetch.once('error', (e) => { imap.end(); reject(e); });
        });
      });
    });
    imap.once('error', (err) => {
      if (attempt < 2) {
        console.log('IMAP retry attempt', attempt+1);
        setTimeout(() => fetchNetflixEmailsFresh(filterEmail, includeSignin, attempt+1).then(resolve).catch(reject), 1000);
      } else {
        reject(err);
      }
    });
    imap.connect();
  });
}

function extractLink(body) {
  const b = body.replace(/&amp;/g,'&');
  const m1 = b.match(/https:\/\/www\.netflix\.com\/account\/travel\/verify\?nftoken=[^\s"'<>\\]+/i);
  if (m1) return { link:m1[0], type:'household', label:'Temporary Access Code' };
  const m2 = b.match(/https:\/\/www\.netflix\.com\/account\/update-primary-location\?nftoken=[^\s"'<>\\]+/i);
  if (m2) return { link:m2[0], type:'update', label:'Update Household (TV)' };
  const m3 = b.match(/href=["'](https:\/\/[^"']*netflix\.com\/account[^"']*nftoken[^"']*)/i);
  if (m3) { const link=m3[1].replace(/&amp;/g,'&'); const isUpdate=link.includes('update-primary'); return { link, type:isUpdate?'update':'household', label:isUpdate?'Update Household (TV)':'Temporary Access Code' }; }
  return null;
}

async function classifyEmail({ subject, bodyHtml, bodyText, bodyPlain, toEmail, ts, includeSignin }) {
  const sl = subject.toLowerCase();
  if (sl.includes('verification code') || sl.includes('your verification code')) {
    const isAccountChange = bodyPlain.toLowerCase().includes('account change') ||
                            bodyPlain.toLowerCase().includes('account info') ||
                            bodyPlain.toLowerCase().includes('change to your account');
    if (isAccountChange) return null;
  }
  if (includeSignin && (sl.includes('verification code') || sl.includes('verify with') || sl.includes('verify this'))) {
    const spacedMatch = bodyPlain.match(/(?<![0-9\d])(\d)\s(\d)\s(\d)\s(\d)\s(\d)\s(\d)(?![0-9\d])/);
    if (spacedMatch) {
      const code = spacedMatch[1]+spacedMatch[2]+spacedMatch[3]+spacedMatch[4]+spacedMatch[5]+spacedMatch[6];
      if (!BLOCKED_CODES.includes(code)) return { type:'verify', label:'Verification Code', code, to:toEmail, ts, expiresAt:ts+15*60*1000 };
    }
    const afterCode = bodyPlain.match(/(?:verify with this code|this code)[^0-9]{0,30}([0-9]{6})(?![0-9])/i);
    if (afterCode && !BLOCKED_CODES.includes(afterCode[1])) {
      return { type:'verify', label:'Verification Code', code:afterCode[1], to:toEmail, ts, expiresAt:ts+15*60*1000 };
    }
    const allNums6 = [...bodyHtml.matchAll(/(?<![0-9])(\d{6})(?![0-9])/g)].map(m => m[1]);
    const filtered6 = allNums6.filter(n => !BLOCKED_CODES.includes(n));
    if (filtered6.length > 0) {
      const unique6 = [...new Set(filtered6)];
      const onlyOnce = unique6.filter(n => allNums6.filter(x => x === n).length === 1);
      const verifyCode = onlyOnce[onlyOnce.length - 1] || unique6[unique6.length - 1];
      if (verifyCode) return { type:'verify', label:'Verification Code', code:verifyCode, to:toEmail, ts, expiresAt:ts+15*60*1000 };
    }
  }
  if (includeSignin && (sl.includes('sign-in code') || sl.includes('sign in code'))) {
    // Strategy 1: Spaced digits "6 7 2 7" in plain text — most reliable
    const spacedMatch4 = bodyPlain.match(/(?<!\d)(\d)\s(\d)\s(\d)\s(\d)(?:[\s\-–—]*(?!\d))/);
    if (spacedMatch4) {
      const code = spacedMatch4[1]+spacedMatch4[2]+spacedMatch4[3]+spacedMatch4[4];
      if (!BLOCKED_CODES.includes(code)) return { type:'signin', label:'Sign-in Code', code, to:toEmail, ts, expiresAt:ts+15*60*1000 };
    }
    // Strategy 2: Appears exactly once in HTML
    const TEMPLATE_NUMS = [...BLOCKED_CODES, '8199'];
    const allNums = [...bodyHtml.matchAll(/(?<![0-9])(\d{4})(?![0-9])/g)].map(m => m[1]);
    const filtered = allNums.filter(n => !TEMPLATE_NUMS.includes(n));
    if (filtered.length > 0) {
      const unique = [...new Set(filtered)];
      const exactlyOnce = unique.filter(n => allNums.filter(x => x === n).length === 1);
      if (exactlyOnce.length > 0) {
        const signinCode = exactlyOnce[exactlyOnce.length - 1];
        if (signinCode) return { type:'signin', label:'Sign-in Code', code:signinCode, to:toEmail, ts, expiresAt:ts+15*60*1000 };
      }
      const singleOccurrence = unique.filter(n => allNums.filter(x => x === n).length <= 5);
      const signinCode = singleOccurrence[singleOccurrence.length - 1] || unique[unique.length - 1];
      if (signinCode) return { type:'signin', label:'Sign-in Code', code:signinCode, to:toEmail, ts, expiresAt:ts+15*60*1000 };
    }
  }
  // Outside BD login detection
  const isNewSignin = sl.includes('new sign') || sl.includes('new device') || sl.includes('someone signed') || sl.includes('signed in to your');
  if (isNewSignin) {
    const alertKey = toEmail + '_' + ts;
    if (!alertedSignins.has(alertKey)) {
      alertedSignins.add(alertKey);
      const location = (bodyPlain.match(/Location[^a-z]*([A-Za-z ,]+)/i)||[])[1]?.trim() || 'Unknown';
      const device = (bodyPlain.match(/Windows|Mac|iPhone|iPad|Android|Samsung|Chrome|Firefox|Safari|Smart TV|TV/i)||[])[0] || 'Unknown device';
      const isBD = bodyPlain.toLowerCase().includes('bangladesh') || bodyPlain.toLowerCase().includes('dhaka') || bodyPlain.toLowerCase().includes('chittagong') || bodyPlain.toLowerCase().includes('sylhet');
      if (!isBD) {
        sendTelegram(
          `🚨 <b>Outside BD Login!</b>\n\n📧 Account: ${toEmail}\n📍 Location: ${location}\n📱 Device: ${device}\n🕐 ${new Date(ts).toLocaleString('en-BD', {timeZone:'Asia/Dhaka'})}\n\n⚠️ Check admin → Outside BD Alerts to remove the link!`
        );
        // Store alert for admin panel
        try {
          const alerts = loadNetflixAlerts();
          alerts.unshift({ source: 'netflix', email: toEmail, location, device, ts, seen: false });
          saveNetflixAlerts(alerts.slice(0, 100)); // keep last 100
        } catch(e) { console.error('Save alert error:', e.message); }
      }
      if (alertedSignins.size > 500) {
        const arr = [...alertedSignins];
        alertedSignins.clear();
        arr.slice(-200).forEach(k => alertedSignins.add(k));
      }
    }
    return null;
  }
  // Netflix account banned/cancelled detection - "Welcome back! It's easy to
  // rejoin Netflix" is what Netflix sends when an account has been cancelled
  // (voluntarily or by Netflix). Flag the account so admin sees it and
  // customers on that account see a clear status message instead of a
  // blank/endless-loading dashboard.
  const isBannedNotice = sl.includes('rejoin netflix') || (sl.includes('welcome back') && bodyPlain.toLowerCase().includes('restart your membership'));
  if (isBannedNotice) {
    // Don't alert for accounts that have been deleted from the system.
    if (deletedAccountEmails.has((toEmail||'').trim().toLowerCase())) return null;
    const bannedKey = toEmail + '_' + ts;
    if (!alertedBanned.has(bannedKey)) {
      alertedBanned.add(bannedKey);
      try {
        const accounts = loadAccounts();
        const idx = accounts.findIndex(a => a.email === toEmail);
        if (idx !== -1) {
          accounts[idx].bannedDetected = true;
          accounts[idx].bannedAt = ts;
          saveAccounts(accounts);
        }
        sendTelegram(`🚫 <b>Netflix Account Issue Detected!</b>\n\n📧 ${toEmail}\n\nNetflix sent a "rejoin" email - this usually means the account was cancelled or banned. Customers on this account will now see a status message on their dashboard.\n\n👉 Check Account Performance in admin for details.`);
      } catch(e) { console.error('Banned account flag error:', e.message); }
      if (alertedBanned.size > 500) {
        const arr = [...alertedBanned];
        alertedBanned.clear();
        arr.slice(-200).forEach(k => alertedBanned.add(k));
      }
    }
    return null;
  }
    // PIN change detection
  const isPinChange = sl.includes('pin for profile') || sl.includes('new pin for') || sl.includes('pin has changed');
  if (isPinChange) {
    if (deletedAccountEmails.has((toEmail||'').trim().toLowerCase())) return null;
    const pinAlertKey = toEmail + '_' + ts;
    if (!alertedPinChanges.has(pinAlertKey)) {
      alertedPinChanges.add(pinAlertKey);
      // Extract profile letter e.g. 'The PIN for profile C has changed'
      const profileMatch = sl.match(/profile\s+([a-e])/i) || bodyPlain.match(/Profile\s+([A-E])\b/i);
      const profileLetter = profileMatch ? profileMatch[1].toUpperCase() : null;
      // Extract new PIN - shown as spaced digits '5 6 5 3'
      const pinMatch = bodyPlain.match(/Profile Lock PIN[^0-9]*(\d)\s+(\d)\s+(\d)\s+(\d)/i)
        || bodyPlain.match(/new PIN[^0-9]*(\d)\s+(\d)\s+(\d)\s+(\d)/i)
        || bodyPlain.match(/PIN\s*[:\s]*(\d)\s+(\d)\s+(\d)\s+(\d)(?!\s*\d)/i);
      const newPin = pinMatch ? pinMatch[1]+pinMatch[2]+pinMatch[3]+pinMatch[4] : null;
      if (profileLetter && newPin) {
        // Auto-update PIN in all links for this profile on this account
        const profileName = 'Profile ' + profileLetter;
        const links = loadLinks();
        let updated = 0;
        let affectedCustomer = null;
        for (const token of Object.keys(links)) {
          if (links[token].email === toEmail && links[token].profile === profileName) {
            links[token].pin = newPin;
            updated++;
            if (!affectedCustomer) affectedCustomer = links[token];
          }
        }
        if (updated > 0) saveLinks(links);
        sendTelegram(
          `🔑 <b>PIN Changed!</b>\n\n`+
          `📧 ${toEmail}\n`+
          `👤 ${profileName}\n`+
          `🔑 New PIN: <code>${newPin}</code>\n`+
          `📝 ${updated} link(s) auto-updated`
        );
        // Persist for risk scoring
        try {
          const alerts = loadNetflixAlerts();
          alerts.unshift({
            source: 'pin_change',
            email: toEmail,
            profile: profileName,
            phone: affectedCustomer?.phone || '',
            customerName: affectedCustomer?.customerName || '',
            location: '', device: '',
            ts: Date.now(),
          });
          saveNetflixAlerts(alerts.slice(0, 200));
        } catch(e) { console.error('Save pin-change alert error:', e.message); }
      } else {
        sendTelegram(`🔑 <b>PIN Changed!</b>\n\n📧 ${toEmail}\nCould not auto-detect profile/PIN. Check manually.\n\n<b>Subject:</b> ${subject}\n<b>Body snippet:</b> <code>${bodyPlain.slice(0,200)}</code>`);
      }
      if (alertedPinChanges.size > 500) {
        const arr = [...alertedPinChanges];
        alertedPinChanges.clear();
        arr.slice(-200).forEach(k => alertedPinChanges.add(k));
      }
    }
    return null;
  }

  const isRelevant = sl.includes('temporary')||sl.includes('access code')||sl.includes('travel')||sl.includes('household')||sl.includes('update')||sl.includes('verify');
  if (!isRelevant) return null;
  const result = extractLink(bodyHtml) || extractLink(bodyText);
  if (!result) return null;
  if (result.type === 'household') {
    const otp = await scrapeOTP(result.link);
    if (otp && !BLOCKED_CODES.includes(otp)) return { type:'household', label:'Temporary Access Code', code:otp, to:toEmail, ts, expiresAt:ts+15*60*1000 };
    return { ...result, to:toEmail, ts, expiresAt:ts+15*60*1000 };
  }
  return { ...result, to:toEmail, ts };
}

function epsHash(data) {
  const key = Buffer.from(EPS_HASH_KEY, 'utf8');
  return crypto.createHmac('sha512', key).update(data).digest('base64');
}

async function epsGetToken() {
  const xhash = epsHash(EPS_USERNAME);
  const res = await fetch(EPS_API + '/v1/Auth/GetToken', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-hash': xhash },
    body: JSON.stringify({ userName: EPS_USERNAME, password: EPS_PASSWORD })
  });
  const d = await res.json();
  if (!d.token) throw new Error('EPS auth failed: ' + (d.errorMessage || JSON.stringify(d)));
  return d.token;
}

async function epsInitPayment({ token, amount, productName, customerName, customerPhone, customerEmail, txnId, orderId, successUrl, failUrl, cancelUrl }) {
  const bearerToken = await epsGetToken();
  const xhash = epsHash(txnId);
  const body = {
    merchantId: EPS_MERCHANT_ID, storeId: EPS_STORE_ID,
    CustomerOrderId: orderId, merchantTransactionId: txnId,
    transactionTypeId: 1, financialEntityId: 0, transitionStatusId: 0,
    totalAmount: amount, ipAddress: '127.0.0.1', version: '1',
    successUrl, failUrl, cancelUrl,
    customerName: customerName || 'Customer',
    customerEmail: customerEmail || 'customer@fanflixbd.com',
    CustomerAddress: 'Dhaka, Bangladesh', CustomerAddress2: '',
    CustomerCity: 'Dhaka', CustomerState: 'Dhaka',
    CustomerPostcode: '1000', CustomerCountry: 'BD',
    CustomerPhone: customerPhone || '01700000000',
    ShippingMethod: 'NO', NoOfItem: '1',
    ProductName: productName, ProductProfile: 'digital-goods',
    ProductCategory: 'Subscription', ValueA: token,
  };
  const res = await fetch(EPS_API + '/v1/EPSEngine/InitializeEPS', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-hash': xhash, 'Authorization': 'Bearer ' + bearerToken },
    body: JSON.stringify(body)
  });
  const d = await res.json();
  if (!d.RedirectURL) throw new Error('EPS init failed: ' + (d.ErrorMessage || 'Unknown'));
  return d;
}

async function epsVerifyPayment(txnId) {
  const bearerToken = await epsGetToken();
  const xhash = epsHash(txnId);
  const res = await fetch(EPS_API + '/v1/EPSEngine/CheckMerchantTransactionStatus?merchantTransactionId=' + txnId, {
    headers: { 'x-hash': xhash, 'Authorization': 'Bearer ' + bearerToken }
  });
  return await res.json();
}

function adminAuth(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_PASS) return res.status(401).json({ error:'Unauthorized' });
  next();
}

app.post('/tg-webhook', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg?.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;

  if (text.startsWith('/create')) {
    const parts = text.replace('/create','').trim().split('|').map(s=>s.trim());
    const emailRaw = parts[0];
    if (!emailRaw||!emailRaw.includes('@')) return sendTelegram('❌ Format: /create email@gmail.com\nOptional: /create email@gmail.com | 90', chatId);
    const email = emailRaw.toLowerCase();
    const days = parts[1] ? parseInt(parts[1]) : 30;
    const links = loadLinks();
    const now = Date.now();
    const accountsForCreate = loadAccounts();
    const matchedAccount = accountsForCreate.find(a => a.email === email);
    const profileConfig = getSlotConfig(matchedAccount);
    const maxSlotsHere = getMaxSlotsForAccount(matchedAccount);
    const existing = Object.values(links).filter(l => l.email===email && l.active && !l.released);
    if (existing.length >= maxSlotsHere) return sendTelegram(`❌ Account Full! ${email} has ${maxSlotsHere}/${maxSlotsHere} active links.\nUse /list ${email}`, chatId);
    const created = [];
    for (const prof of profileConfig) {
      for (let i=0; i<prof.slots; i++) {
        const token = generateToken();
        links[token] = { token, email, profile:prof.profile, pin:prof.pin, days, createdAt:now, expiresAt:now+days*24*60*60*1000, uses:0, lastUsed:null, active:true, warningSent:false };
        created.push({ token, profile:prof.profile, pin:prof.pin, link:`${SITE_URL}/c/${token}` });
      }
    }
    saveLinks(links);
    let msg2 = `✅ <b>${maxSlotsHere} Links Created!</b>\n📧 ${email}\n⏳ ${days} days\n\n`;
    let lastProf = '';
    for (const l of created) {
      if (l.profile !== lastProf) { msg2 += `\n👤 <b>${l.profile}</b> | PIN: <code>${l.pin}</code>\n`; lastProf = l.profile; }
      msg2 += `🔗 <code>${l.link}</code>\n`;
    }
    msg2 += `\n━━━━━━━━━━━━━━━━━━\n📋 <b>Template:</b>\n\n` + buildCustomerMessage(email,'[PROFILE]','[PIN]','[LINK]',days);
    return sendTelegram(msg2, chatId);
  }

  if (text.startsWith('/list')) {
    const emailFilter = text.replace('/list','').trim().toLowerCase();
    const links = loadLinks();
    const now = Date.now();
    const filtered = Object.values(links).filter(l => !emailFilter || l.email.includes(emailFilter));
    if (!filtered.length) return sendTelegram(`No links found`, chatId);
    let msg2 = `📋 <b>Links</b>\n\n`;
    for (const l of filtered.sort((a,b)=>b.createdAt-a.createdAt)) {
      const daysLeft = Math.ceil((l.expiresAt-now)/(24*60*60*1000));
      const status = !l.active?'🚫':daysLeft<=0?'⏰':daysLeft<=3?'⚠️':'✅';
      msg2 += `${status} ${l.profile} | PIN: ${l.pin}\n🔗 /c/${l.token}\n⏳ ${daysLeft}d | Uses: ${l.uses}\n\n`;
    }
    return sendTelegram(msg2, chatId);
  }

  if (text.startsWith('/renew')) {
    const parts = text.replace('/renew','').trim().split(' ');
    const token = parts[0]; const days = parseInt(parts[1])||30;
    const links = loadLinks();
    if (!links[token]) return sendTelegram('❌ Link not found', chatId);
    links[token].expiresAt = Date.now()+days*24*60*60*1000;
    links[token].warningSent = false; links[token].expiredSmsSent = false; links[token].renewalSmsSent = false; links[token].active = true;
    saveLinks(links);
    return sendTelegram(`✅ Renewed /c/${token} for ${days} days`, chatId);
  }

  if (text.startsWith('/extend')) {
    const parts = text.replace('/extend','').trim().split(' ');
    if (parts.length < 2) return sendTelegram('❌ Format: /extend TOKEN days', chatId);
    const [token, daysStr] = parts; const days = parseInt(daysStr)||30;
    const links = loadLinks();
    if (!links[token]) return sendTelegram('❌ Link not found', chatId);
    links[token].expiresAt += days*24*60*60*1000;
    links[token].warningSent = false; links[token].expiredSmsSent = false; links[token].renewalSmsSent = false;
    saveLinks(links);
    return sendTelegram(`✅ Extended /c/${token} by ${days} days`, chatId);
  }

  if (text.startsWith('/revoke')) {
    const token = text.replace('/revoke','').trim();
    const links = loadLinks();
    if (!links[token]) return sendTelegram('❌ Link not found', chatId);
    links[token].active = false; saveLinks(links);
    return sendTelegram(`✅ Revoked /c/${token}`, chatId);
  }

  if (text.startsWith('/ip')) {
    const token = text.replace('/ip','').trim();
    const ips = loadIPs();
    if (!ips[token]) return sendTelegram(`No IPs recorded for /c/${token}`, chatId);
    return sendTelegram(`<b>IPs for /c/${token}</b>\n\n${ips[token].map((ip,i)=>`${i+1}. ${ip}`).join('\n')}\n\nTotal: ${ips[token].length} unique IPs`, chatId);
  }

  if (text.startsWith('/expiry')) {
    const links = loadLinks();
    const now = Date.now();
    const sevenDays = 7*24*60*60*1000;
    const expiring = Object.values(links).filter(l => l.active && l.expiresAt>now && (l.expiresAt-now)<=sevenDays).sort((a,b)=>a.expiresAt-b.expiresAt);
    if (!expiring.length) return sendTelegram('No links expiring this week!', chatId);
    let msg2 = `📅 <b>Expiring This Week</b>\n\n`;
    for (const l of expiring) {
      const days = Math.ceil((l.expiresAt-now)/(24*60*60*1000));
      msg2 += `${days}d | ${l.profile} | ${l.email}\n/renew ${l.token} 30\n\n`;
    }
    return sendTelegram(msg2, chatId);
  }

  if (text === '/slots') {
    const links = loadLinks(); const now = Date.now();
    const accountsForSlots = loadAccounts();
    const byEmail = {};
    for (const l of Object.values(links)) {
      if (!byEmail[l.email]) byEmail[l.email] = { active:0, total:0 };
      byEmail[l.email].total++;
      if (l.active && l.expiresAt>now) byEmail[l.email].active++;
    }
    let msg2 = '📊 <b>Slot Usage</b>\n\n';
    for (const [email, info] of Object.entries(byEmail)) {
      const acctForEmail = accountsForSlots.find(a => a.email === email);
      const maxForEmail = getMaxSlotsForAccount(acctForEmail);
      const bar = '█'.repeat(info.active)+'░'.repeat(Math.max(0,maxForEmail-info.active));
      msg2 += `📧 ${email} ${acctForEmail?.deviceType==='tv'?'📺':'📱'}\n${bar} ${info.active}/${maxForEmail}\n\n`;
    }
    return sendTelegram(msg2||'No active links.', chatId);
  }

  if (text === '/stats') {
    const links = loadLinks(); const now = Date.now();
    const active = Object.values(links).filter(l=>l.active&&l.expiresAt>now).length;
    const expired = Object.values(links).filter(l=>l.expiresAt<=now).length;
    const totalUses = Object.values(links).reduce((s,l)=>s+l.uses,0);
    return sendTelegram(`📊 <b>FanFlix Stats</b>\n\nActive: ${active}\nExpired: ${expired}\n👁 Total uses: ${totalUses}\n👥 Live: ${getLiveVisitors()}\n📈 Today: ${totalToday}`, chatId);
  }

  if (text === '/help' || text === '/start') {
    return sendTelegram(
      `🎬 <b>FanFlix Bot Commands</b>\n\n` +
      `<b>Create:</b>\n/create email | days\n\n` +
      `<b>Manage:</b>\n/list email\n/renew TOKEN days\n/extend TOKEN days\n/revoke TOKEN\n\n` +
      `<b>Info:</b>\n/slots\n/stats\n/expiry\n/ip TOKEN\n/help`, chatId
    );
  }
});

function buildCustomerMessage(email, profile, pin, link, days) {
  return `🎬 <b>FanFlix BD</b>\n\n📧 Email: <code>${email}</code>\n👤 Profile: ${profile}\n🔑 PIN: ${pin}\n\n🔗 Your Code Link:\n${link}\n\n📺 Login Tutorial:\n${LOGIN_VIDEO}\n\n🏠 Household Fix:\n${HOUSEHOLD_VIDEO}\n\n⚠️ Important:\n• No account changes allowed\n• 1 device at a time\n• BD use only\n• Sign in anytime if logged out\n\n✅ Valid for ${days} days`;
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASS) res.json({ success:true, token:ADMIN_PASS });
  else res.status(401).json({ success:false, error:'Wrong password' });
});

app.get('/api/admin/links', adminAuth, (req, res) => {
  const links = loadLinks();
  const analytics = loadAnalytics();
  const ips = loadIPs();
  for (const token of Object.keys(links)) {
    links[token].analytics = analytics[token] || { total:0, daily:{} };
    links[token].ipCount = (ips[token] || []).length;
    links[token].ips = ips[token] || [];
  }
  res.json({ success:true, links });
});

app.post('/api/admin/create', adminAuth, (req, res) => {
  const { email, profile, pin, days, phone } = req.body;
  if (!email||!profile||!pin||!days) return res.status(400).json({ error:'Missing fields' });
  const links = loadLinks();
  const now = Date.now();
  // Normalize profile name
  const normalizedProfile = normalizeProfile(profile);
  const normalizedPin = pin;
  // Check if active link already exists for this email+profile
  const existing = Object.values(links).find(l => l.email===email.toLowerCase()&&normalizeProfile(l.profile)===normalizedProfile&&l.active&&!l.released);
  if (existing) return res.json({ success:true, token:existing.token, link:`/c/${existing.token}`, existing:true });
  const activeCount = Object.values(links).filter(l => l.email===email.toLowerCase()&&l.active&&!l.released).length;
  const acctForCreate = loadAccounts().find(a => a.email === email.toLowerCase());
  const maxForCreate = getMaxSlotsForAccount(acctForCreate);
  if (activeCount >= maxForCreate) return res.status(400).json({ error:`Account full (${maxForCreate}/${maxForCreate})` });
  const token = generateToken();
  const d = parseInt(days);
  links[token] = { token, email:email.toLowerCase(), profile:normalizedProfile, pin:normalizedPin, phone:phone||'', days:d, createdAt:now, expiresAt:now+d*24*60*60*1000, uses:0, lastUsed:null, active:true, warningSent:false };
  saveLinks(links);
  res.json({ success:true, token, link:`/c/${token}` });
});

app.post('/api/admin/revoke/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  const { reason, reasonText } = req.body || {};
  links[req.params.token].active = false;
  links[req.params.token].revokedReason = reason || 'other';
  links[req.params.token].revokedReasonText = reasonText || '';
  links[req.params.token].revokedAt = Date.now();
  saveLinks(links); res.json({ success:true });
});

app.post('/api/admin/activate/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  links[req.params.token].active = true;
  delete links[req.params.token].revokedReason;
  delete links[req.params.token].revokedReasonText;
  delete links[req.params.token].revokedCountry;
  delete links[req.params.token].revokedIp;
  delete links[req.params.token].revokedAt;
  saveLinks(links); res.json({ success:true });
});

app.post('/api/admin/extend/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  const { days } = req.body;
  links[req.params.token].expiresAt += parseInt(days)*24*60*60*1000;
  links[req.params.token].warningSent = false;
  links[req.params.token].expiredSmsSent = false;
  links[req.params.token].renewalSmsSent = false;
  saveLinks(links); res.json({ success:true });
});

app.post('/api/admin/renew/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  const { days } = req.body; const d = parseInt(days)||30;
  links[req.params.token].expiresAt = Date.now()+d*24*60*60*1000;
  links[req.params.token].warningSent = false;
  links[req.params.token].expiredSmsSent = false;
  links[req.params.token].renewalSmsSent = false;
  links[req.params.token].active = true;
  saveLinks(links); res.json({ success:true });
});

// Update profile for a link
app.post('/api/admin/update-profile/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  const { profile } = req.body;
  if (!profile) return res.status(400).json({ error:'Missing profile' });
  links[req.params.token].profile = profile;
  saveLinks(links);
  res.json({ success:true });
});

// Update PIN for a link
app.post('/api/admin/update-pin/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  links[req.params.token].pin = req.body.pin || '';
  saveLinks(links);
  res.json({ success:true });
});

// Update customer name for a link
app.post('/api/admin/update-name/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  links[req.params.token].customerName = req.body.customerName || '';
  saveLinks(links);
  res.json({ success:true });
});

app.post('/api/admin/update-phone/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  const { phone } = req.body;
  links[req.params.token].phone = phone || '';
  saveLinks(links);
  res.json({ success:true });
});

app.delete('/api/admin/delete/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  // Soft-delete: move to Recycle Bin instead of permanent removal.
  // Admin can restore or permanently delete later from the Recycle Bin section.
  links[req.params.token].recycled = true;
  links[req.params.token].recycledAt = Date.now();
  links[req.params.token].active = false;
  saveLinks(links);
  res.json({ success:true, recycled:true });
});

app.get('/api/admin/recycle-bin', adminAuth, (req, res) => {
  try {
    const links = loadLinks();
    const items = Object.entries(links)
      .filter(([token, l]) => l.recycled)
      .map(([token, l]) => ({
        token, email: l.email, profile: l.profile, pin: l.pin,
        phone: l.phone||'', customerName: l.customerName||'',
        recycledAt: l.recycledAt||0, revokedReason: l.revokedReason||null,
      }))
      .sort((a,b) => (b.recycledAt||0) - (a.recycledAt||0));
    res.json({ success:true, items, count: items.length });
  } catch(e) { res.json({ success:true, items:[], count:0 }); }
});

app.post('/api/admin/recycle-bin/:token/restore', adminAuth, (req, res) => {
  const links = loadLinks();
  const link = links[req.params.token];
  if (!link) return res.status(404).json({ success:false, error:'Not found' });
  link.recycled = false;
  delete link.recycledAt;
  // Restored links come back inactive by default - admin can manually reactivate/extend if needed
  saveLinks(links);
  res.json({ success:true });
});

app.delete('/api/admin/recycle-bin/:token/permanent', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  if (!links[req.params.token].recycled) return res.status(400).json({ success:false, error:'Link must be in recycle bin first' });
  delete links[req.params.token];
  saveLinks(links);
  res.json({ success:true });
});

app.post('/api/admin/recycle-bin/empty', adminAuth, (req, res) => {
  const links = loadLinks();
  let count = 0;
  for (const token of Object.keys(links)) {
    if (links[token].recycled) { delete links[token]; count++; }
  }
  saveLinks(links);
  res.json({ success:true, deleted:count });
});

app.get('/api/admin/slots', adminAuth, (req, res) => {
  const links = loadLinks(); const now = Date.now();
  const byEmail = {};
  for (const l of Object.values(links)) {
    if (!byEmail[l.email]) byEmail[l.email] = { active:0, total:0 };
    byEmail[l.email].total++;
    if (l.active && l.expiresAt>now) byEmail[l.email].active++;
  }
  const freeSlots = getFreeSlots();
  res.json({ success:true, slots:byEmail, maxSlots:MAX_SLOTS, freeSlots });
});

const REVOKE_REASON_TEXT = {
  outside_bd: 'Netflix login detected from outside Bangladesh',
  pin_change: 'Unauthorized PIN or profile change',
  multi_device: 'Account shared across multiple devices, violating single-device policy',
  security: 'Unusual activity detected on this Netflix account',
  payment: 'Payment dispute or issue on this order',
  other: null, // uses custom text stored on link.revokedReasonText
};
function getRevokeReasonText(link) {
  if (!link.revokedReason) return 'Access revoked. Contact FanFlix BD.';
  if (link.revokedReason === 'other' && link.revokedReasonText) return link.revokedReasonText;
  return REVOKE_REASON_TEXT[link.revokedReason] || 'Access revoked. Contact FanFlix BD.';
}

app.get('/api/link/:token/info', (req, res) => {
  const links = loadLinks();
  const link = links[req.params.token];
  if (!link) return res.status(404).json({ success:false, error:'invalid', message:'Invalid link.' });
  if (!link.active) return res.status(403).json({ success:false, error:'revoked', message:getRevokeReasonText(link), reason:link.revokedReason||null, country:link.revokedCountry||null, ip:link.revokedIp||null });
  const now = Date.now();
  const daysLeft = Math.ceil((link.expiresAt-now)/(24*60*60*1000));
  const totalDays = link.days || 30;
  if (now > link.expiresAt) return res.status(403).json({ success:false, error:'expired', message:'Subscription expired!', daysLeft:0, expiresAt:link.expiresAt, profile:link.profile, token:req.params.token });
  res.json({ success:true, profile:link.profile, pin:link.pin, email:link.email, daysLeft, totalDays });
});

app.get('/api/link/:token', async (req, res) => {

  const links = loadLinks();
  const link = links[req.params.token];
  if (!link) return res.status(404).json({ success:false, error:'invalid', message:'Invalid link.' });
  if (!link.active) return res.status(403).json({ success:false, error:'revoked', message:getRevokeReasonText(link), reason:link.revokedReason||null, country:link.revokedCountry||null, ip:link.revokedIp||null });
  // Check if the Netflix account itself has a detected issue (banned/cancelled by Netflix)
  try {
    const accounts = loadAccounts();
    const acct = accounts.find(a => a.email === link.email);
    if (acct && acct.bannedDetected) {
      return res.status(503).json({ success:false, error:'account_issue', message:'We are aware of an issue with this account and are working to resolve it. Please check back shortly, or contact support.', profile:link.profile, token:req.params.token });
    }
  } catch(e) {}
  const now = Date.now();
  const daysLeft = Math.ceil((link.expiresAt-now)/(24*60*60*1000));
  const totalDays = link.days || 30;
  if (now > link.expiresAt) return res.status(403).json({ success:false, error:'expired', message:'Subscription expired!', daysLeft:0, expiresAt:link.expiresAt, profile:link.profile, token:req.params.token });
  link.uses += 1; link.lastUsed = now; saveLinks(links);
  trackAnalytics(req.params.token);
  markActivity();
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  trackVisitor(ip);
  const { count: ipCount, isNew: isNewIP } = trackIPSync(req.params.token, ip);
  if (isNewIP) checkGeoAndAlert(req.params.token, ip).catch(()=>{});
  try {
    // SECURITY: customers may only ever see household code / TV update link -
    // never sign-in/verify/2FA/reset (those could let someone take over the
    // whole account, not just their profile). The shared poller cache mixes all
    // types together, so it must be filtered before it reaches a customer.
    const cached = publicSafeCodes(getCodesFromCache(link.email));
    if (cached !== null && cached.length > 0) {
      totalToday += 1;
      return res.json({ success:true, codes:cached, count:cached.length, profile:link.profile, pin:link.pin, email:link.email, daysLeft, totalDays, ipCount, uses:link.uses });
    }
    // Cache empty - actively race every source now (IMAP + nfpro + FFU, in parallel)
    // instead of passively waiting on the background poller's next 15s-2min cycle.
    // This is what makes first-load speed match the public tool page.
    const fresh = await fetchAllSourcesForCustomer(link.email);
    if (fresh.length > 0) {
      totalToday += 1;
      return res.json({ success:true, codes:fresh, count:fresh.length, profile:link.profile, pin:link.pin, email:link.email, daysLeft, totalDays, ipCount, uses:link.uses });
    }
    res.json({ success:true, codes:[], count:0, profile:link.profile, pin:link.pin, email:link.email, daysLeft, totalDays, ipCount, uses:link.uses, fetching:true });
  } catch(err) {
    res.json({ success:true, codes:[], count:0, profile:link.profile, pin:link.pin, email:link.email, daysLeft, totalDays, ipCount, uses:link.uses });
  }
});

// Lightweight, passive check - used by the recurring auto-refresh timer. Reads
// ONLY the cache (which the background poller keeps fresh by scanning the inbox
// continuously) - it NEVER calls nfpro or FFU. Those can actively trigger Netflix
// to issue a brand-new code every time they're queried, so calling them on every
// 3-second auto-poll tick would mean requesting a fresh code from Netflix nonstop
// just from a customer leaving the dashboard open. nfpro/FFU are only queried on
// genuine page load (/api/link/:token) or an explicit Refresh click (.../refresh).
app.get('/api/link/:token/peek', (req, res) => {
  const links = loadLinks();
  const link = links[req.params.token];
  if (!link) return res.status(404).json({ success:false });
  if (!link.active || link.expiresAt <= Date.now()) return res.status(403).json({ success:false });
  markActivity(); // keeps the background IMAP poller in its fast (15s) cycle
  const codes = publicSafeCodes(getCodesFromCache(link.email));
  res.json({ success:true, codes, count:codes.length });
});

app.get('/api/debug-email', async (req, res) => {
  const filterEmail = (req.query.email || '').trim().toLowerCase();
  try {
    const results = await new Promise((resolve, reject) => {
      const imap = new Imap({ user:GMAIL_USER, password:GMAIL_PASS, host:'imap.gmail.com', port:993, tls:true, tlsOptions:{rejectUnauthorized:false}, connTimeout:8000, authTimeout:6000 });
      imap.once('ready', () => {
        imap.openBox('INBOX', true, (err) => {
          if (err) { imap.end(); return reject(err); }
          const since = new Date(Date.now() - 10*60*1000);
          // Don't filter by TO - forwarded emails won't match
          // ONLY fetch emails for this specific account
          const searchCriteria = filterEmail
            ? [['SINCE', since], ['TO', filterEmail], ['OR', ['FROM', 'netflix'], ['SUBJECT', 'netflix']]]
            : [['SINCE', since], ['OR', ['FROM', 'netflix'], ['SUBJECT', 'netflix']]];
          imap.search(searchCriteria, async (err, uids) => {
            if (err || !uids || uids.length === 0) { imap.end(); return resolve([]); }
            const fetch = imap.fetch(uids, { bodies: '' });
            const promises = [];
            fetch.on('message', (msg) => {
              const p = new Promise((res2) => {
                msg.on('body', (stream) => {
                  simpleParser(stream, (err, mail) => {
                    if (err) return res2(null);
                    const toValues = (mail.to?.value || []).map(a => a.address?.toLowerCase());
                    res2({ subject:mail.subject, to:mail.to?.text, to_parsed:toValues, matches_filter: filterEmail ? toValues.some(a=>a===filterEmail) : true });
                  });
                });
              });
              promises.push(p);
            });
            fetch.once('end', async () => { const items=(await Promise.all(promises)).filter(Boolean); imap.end(); resolve(items); });
            fetch.once('error', (e) => { imap.end(); reject(e); });
          });
        });
      });
      imap.once('error', reject);
      imap.connect();
    });
    res.json({ success:true, filter:filterEmail, count:results.length, emails:results });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/stats', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  trackVisitor(ip); resetDailyIfNeeded();
  res.json({ live:getLiveVisitors(), today:totalToday });
});

app.get('/api/admin/revenue', adminAuth, (req, res) => {
  try {
    const links = loadLinks();
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const monthStr = todayStr.slice(0, 7); // YYYY-MM

    let todayTotal = 0, todayCount = 0;
    let monthTotal = 0, monthCount = 0;
    let allTimeTotal = 0, allTimeCount = 0;
    const byProduct = {};

    // Helper - tally one link's amount into all the buckets
    const tally = (link, fallbackName) => {
      const amount = parseFloat(link.amount) || 0;
      if (!amount || !link.createdAt) return;
      const createdStr = new Date(link.createdAt).toISOString().split('T')[0];
      allTimeTotal += amount; allTimeCount++;
      if (createdStr === todayStr) { todayTotal += amount; todayCount++; }
      if (createdStr.slice(0,7) === monthStr) { monthTotal += amount; monthCount++; }
      const prod = link.plan || fallbackName || 'Unknown';
      if (!byProduct[prod]) byProduct[prod] = { total: 0, count: 0 };
      byProduct[prod].total += amount;
      byProduct[prod].count++;
    };

    // Netflix (own) links
    for (const link of Object.values(links)) tally(link, 'Netflix');

    // Streaming product links (Prime/HBO/Disney+/ChatGPT/3rd-party Netflix)
    for (const type of Object.keys(STREAMING_PRODUCTS)) {
      const sLinks = loadStreamingLinks(type);
      for (const link of Object.values(sLinks)) tally(link, STREAMING_PRODUCTS[type].name);
    }

    res.json({
      success: true,
      today: { total: todayTotal, count: todayCount },
      month: { total: monthTotal, count: monthCount },
      allTime: { total: allTimeTotal, count: allTimeCount },
      byProduct,
    });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

// Export full customer list as CSV
app.get('/api/admin/export-customers', adminAuth, (req, res) => {
  try {
    const links = loadLinks();
    const now = Date.now();
    const byPhone = {};
    for (const l of Object.values(links)) {
      if (!l.phone) continue;
      const p = l.phone;
      if (!byPhone[p]) byPhone[p] = { phone: p, name: l.customerName||'', totalRevenue:0, renewalCount:0, plans:new Set(), status:'expired', daysLeft:0, expiresAt:0 };
      const c = byPhone[p];
      c.totalRevenue += parseFloat(l.amount) || 0;
      c.renewalCount = Math.max(c.renewalCount, l.renewalCount||0);
      if (l.plan) c.plans.add(l.plan);
      if (!c.name && l.customerName) c.name = l.customerName;
      const active = l.active && !l.released && l.expiresAt > now;
      if (active && l.expiresAt > c.expiresAt) {
        c.expiresAt = l.expiresAt;
        c.daysLeft = Math.ceil((l.expiresAt-now)/(24*60*60*1000));
        c.status = 'active';
      }
    }

    const rows = Object.values(byPhone);
    const esc = (v) => `"${String(v??'').replace(/"/g,'""')}"`;
    const header = ['Phone','Name','Status','Days Left','Plans','Renewal Count','Total Revenue (BDT)'];
    const lines = [header.join(',')];
    for (const c of rows) {
      lines.push([
        esc(c.phone), esc(c.name), esc(c.status),
        c.status==='active' ? c.daysLeft : '',
        esc([...c.plans].join('; ')), c.renewalCount, c.totalRevenue
      ].join(','));
    }
    const csv = lines.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="fanflix-customers-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get('/api/admin/geo', (req, res) => {
  try {
    if (req.headers['x-admin-token'] !== ADMIN_PASS) return res.status(401).json({ error:'Unauthorized' });
    const geoData = loadGeo();
    res.json({ success: true, geo: geoData });
  } catch(e) { res.json({ success: true, geo: {} }); }
});

// Outside BD login alerts (both Netflix login emails + dashboard link access)
app.get('/api/admin/netflix-alerts', adminAuth, (req, res) => {
  try {
    const alerts = loadNetflixAlerts();
    const links = loadLinks();
    const now = Date.now();
    const withLinks = alerts.map(a => {
      if (a.source === 'dashboard' && a.token) {
        // Dashboard alert already knows the exact customer/link.
        // Show it regardless of active status — auto-block sets active:false
        // immediately, but we still need to show WHO was blocked and let
        // admin revoke/reactivate. Only hide if the link was fully released.
        const link = links[a.token];
        const stillExists = link && !link.released;
        return {
          ...a,
          relatedLinks: stillExists ? [{
            token: a.token,
            profile: a.profile,
            phone: a.phone,
            customerName: a.customerName,
            blocked: !link.active,
          }] : []
        };
      }
      // Netflix login alert - show all links sharing that account email
      // (active OR currently blocked, but not released)
      const relatedLinks = Object.entries(links)
        .filter(([token, l]) => l.email === a.email && !l.released && l.expiresAt > now)
        .map(([token, l]) => ({ token, profile: l.profile, phone: l.phone||'', customerName: l.customerName||'', blocked: !l.active }));
      return { ...a, relatedLinks };
    });
    res.json({ success:true, alerts: withLinks });
  } catch(e) { res.json({ success:true, alerts: [] }); }
});

// Risk score - incident counts per phone number (outside-BD, PIN changes, revokes)
app.get('/api/admin/customer-incidents', adminAuth, (req, res) => {
  try {
    const alerts = loadNetflixAlerts();
    const links = loadLinks();
    const byPhone = {};

    const bump = (phone, type) => {
      if (!phone) return;
      const p = String(phone).replace(/\D/g,'');
      if (!p) return;
      if (!byPhone[p]) byPhone[p] = { total:0, outsideBd:0, pinChange:0, revoked:0 };
      byPhone[p].total++;
      if (type==='outside_bd') byPhone[p].outsideBd++;
      if (type==='pin_change') byPhone[p].pinChange++;
      if (type==='revoked') byPhone[p].revoked++;
    };

    for (const a of alerts) {
      if (a.source === 'dashboard') bump(a.phone, 'outside_bd');
      else if (a.source === 'pin_change') bump(a.phone, 'pin_change');
      else if (a.source === 'netflix') {
        // Netflix-login alert - attribute to all customers on that account
        Object.values(links).filter(l => l.email === a.email && l.phone)
          .forEach(l => bump(l.phone, 'outside_bd'));
      }
    }
    // Manually revoked links (reason set, not outside_bd/pin_change which are already counted above)
    for (const l of Object.values(links)) {
      if (l.revokedReason && !['outside_bd'].includes(l.revokedReason) && l.phone) {
        bump(l.phone, 'revoked');
      }
    }

    res.json({ success:true, incidents: byPhone });
  } catch(e) { res.json({ success:true, incidents: {} }); }
});

// Full 8-slot breakdown for a Netflix account - who occupies each slot
app.get('/api/admin/account-links/:email', adminAuth, (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase().trim();
    const links = loadLinks();
    const now = Date.now();
    const accounts = loadAccounts();
    const accountObj = accounts.find(a => a.email === email);
    const accountLinks = Object.entries(links)
      .filter(([token, l]) => l.email === email)
      .map(([token, l]) => {
        let status = 'expired-released';
        if (l.active && !l.released && l.expiresAt > now) status = 'active';
        else if (l.active && !l.released && l.expiresAt <= now) status = 'pending-release';
        else if (!l.active && !l.released) status = 'revoked';
        return {
          token,
          profile: l.profile,
          pin: l.pin,
          phone: l.phone || '',
          customerName: l.customerName || '',
          expiresAt: l.expiresAt,
          status,
          renewalCount: l.renewalCount || 0,
        };
      })
      .sort((a,b) => (b.expiresAt||0) - (a.expiresAt||0));

    // Build slot occupancy view (one row per physical slot instance) - respects account's mobile/tv type
    const usedTokens = new Set();
    const slots = [];
    const profileConfig = getSlotConfig(accountObj);
    for (const prof of profileConfig) {
      for (let i = 0; i < prof.slots; i++) {
        const occupant = accountLinks.find(l =>
          l.profile === prof.profile &&
          (l.status === 'active' || l.status === 'pending-release') &&
          !usedTokens.has(l.token)
        );
        if (occupant) usedTokens.add(occupant.token);
        slots.push({ profile: prof.profile, pin: prof.pin, occupant: occupant || null });
      }
    }

    res.json({ success:true, email, deviceType: accountObj?.deviceType||'mobile', slots, allLinks: accountLinks });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.delete('/api/admin/netflix-alerts/:index', adminAuth, (req, res) => {
  try {
    const alerts = loadNetflixAlerts();
    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < alerts.length) alerts.splice(idx, 1);
    saveNetflixAlerts(alerts);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false }); }
});

app.post('/api/admin/netflix-alerts/clear', adminAuth, (req, res) => {
  saveNetflixAlerts([]);
  res.json({ success:true });
});

// Waitlist API
// Approve single waitlist customer — create link immediately
app.post('/api/admin/waitlist/approve/:phone', adminAuth, async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const waitlist = loadWaitlist();
    const idx = waitlist.findIndex(w => w.phone === phone);
    if (idx === -1) return res.status(404).json({ success:false, error:'Not in waitlist' });
    const w = waitlist[idx];
    const d = normalizeDays(w.days);

    // If this waitlist entry is for a streaming product (Prime/HBO/Disney+/ChatGPT),
    // assign from that product's pool instead of Netflix.
    if (w.productType && STREAMING_PRODUCTS[w.productType]) {
      const type = w.productType;
      const now2 = Date.now();
      const phoneNorm2 = phone.replace(/\D/g,'');
      const sLinks = loadStreamingLinks(type);

      // Renewal check within this product's pool
      const sExisting = Object.values(sLinks).filter(l => l.phone && l.phone.replace(/\D/g,'') === phoneNorm2 && l.active && !l.released);
      if (sExisting.length > 0) {
        for (const el of sExisting) {
          sLinks[el.token].expiresAt += d * 24 * 60 * 60 * 1000;
          sLinks[el.token].renewalSmsSent = false;
          sLinks[el.token].renewalCount = (sLinks[el.token].renewalCount||0) + 1;
        }
        saveStreamingLinks(type, sLinks);
        waitlist.splice(idx, 1); saveWaitlist(waitlist);
        const sf = sExisting[0];
        sendUniversalAccountDelivery(phone, w.customerName, STREAMING_PRODUCTS[type].name, sf.email, sf.password, sf.profile, sf.pin);
        return res.json({ success:true, renewed:true });
      }

      const sSlot = getNextAvailableStreamingSlot(type, d);
      if (!sSlot) return res.status(503).json({ success:false, error:'No '+STREAMING_PRODUCTS[type].name+' slots available. Add more accounts first.' });

      const sToken = generateStreamingToken(type);
      sLinks[sToken] = {
        token: sToken, accountId: sSlot.accountId, email: sSlot.email, password: sSlot.password,
        profile: sSlot.profile, pin: sSlot.pin, phone, customerName: w.customerName||'',
        plan: w.product || STREAMING_PRODUCTS[type].name, amount: w.amount||0, orderName: w.orderName||'',
        days: d, createdAt: now2, expiresAt: now2 + d*24*60*60*1000,
        uses: 0, lastUsed: null, active: true, released: false, renewalSmsSent: false, renewalCount: 0,
      };
      saveStreamingLinks(type, sLinks);
      waitlist.splice(idx, 1); saveWaitlist(waitlist);
      res.json({ success:true, thirdParty:false, streaming:type, profile:sSlot.profile, pin:sSlot.pin });
      const sent = await sendUniversalAccountDelivery(phone, w.customerName, STREAMING_PRODUCTS[type].name, sSlot.email, sSlot.password, sSlot.profile, sSlot.pin);
      if (sent) {
        sendTelegram(`✅ <b>Approved (${STREAMING_PRODUCTS[type].name})!</b>\n👤 ${w.customerName||'Customer'} | 📱 ${phone}\n📧 ${sSlot.email}\n👤 ${sSlot.profile||'Shared'} | PIN: ${sSlot.pin||'—'}\n⏳ ${d} days\n\n📲 Delivered via WhatsApp`);
      } else {
        const undo = loadStreamingLinks(type);
        delete undo[sToken];
        saveStreamingLinks(type, undo);
        const wl2 = loadWaitlist();
        if (!wl2.find(x => x.phone === phone && x.productType === type)) { wl2.push(w); saveWaitlist(wl2); }
        sendTelegram(`⚠️ <b>${STREAMING_PRODUCTS[type].name} Approve Failed — Back in Waitlist!</b>\n👤 ${w.customerName||'Customer'} | 📱 ${phone}\n\nWhatsApp failed, slot released.`);
      }
      return;
    }

    // Renewal check
    const allLinks = loadLinks();
    const now = Date.now();
    const phoneNorm = phone.replace(/\D/g,'');
    const existingActive = Object.values(allLinks).filter(l =>
      l.phone && l.phone.replace(/\D/g,'') === phoneNorm && l.active && !l.released
    );
    if (existingActive.length > 0) {
      for (const el of existingActive) {
        renewCustomerLink(allLinks, el.token, d);
      }
      saveLinks(allLinks);
      waitlist.splice(idx, 1);
      saveWaitlist(waitlist);
      const first = existingActive[0];
      sendTelegram(`🔄 <b>Renewal Approved!</b>\n👤 ${w.customerName||'Customer'} | 📱 ${phone}\n🔗 Extended ${existingActive.length} link(s) +${d} days`);
      return res.json({ success:true, renewed:true, token:first.token, link:SITE_URL+'/c/'+first.token });
    }

    // New customer — get slot (own account first)
    const slot = getNextAvailableSlot(d, detectDeviceType(w.product));
    if (!slot) {
      // Own stock full - try third-party Netflix pool before giving up
      const tpSlot = getNextAvailableStreamingSlot('netflix3p', d);
      if (tpSlot) {
        const tpLinks = loadStreamingLinks('netflix3p');
        const tpToken = generateStreamingToken('netflix3p');
        tpLinks[tpToken] = {
          token: tpToken, accountId: tpSlot.accountId, email: tpSlot.email, password: tpSlot.password,
          profile: tpSlot.profile, pin: tpSlot.pin, phone, customerName: w.customerName||'',
          plan: 'Netflix Account', amount: w.amount||0, orderName: w.orderName||'',
          days: d, createdAt: now, expiresAt: now + d*24*60*60*1000,
          uses: 0, lastUsed: null, active: true, released: false, renewalSmsSent: false, renewalCount: 0,
        };
        saveStreamingLinks('netflix3p', tpLinks);
        waitlist.splice(idx, 1);
        saveWaitlist(waitlist);
        res.json({ success:true, thirdParty:true, profile:tpSlot.profile, pin:tpSlot.pin });
        const sent = await sendUniversalAccountDelivery(phone, w.customerName, 'Netflix Account', tpSlot.email, tpSlot.password, tpSlot.profile, tpSlot.pin);
        if (sent) {
          sendTelegram(`✅ <b>Approved (Netflix 3rd-Party)!</b>\n👤 ${w.customerName||'Customer'} | 📱 ${phone}\n📧 ${tpSlot.email}\n👤 ${tpSlot.profile} | PIN: ${tpSlot.pin}\n⏳ ${d} days\n\n📲 Delivered from third-party pool`);
        } else {
          const undoLinks = loadStreamingLinks('netflix3p');
          delete undoLinks[tpToken];
          saveStreamingLinks('netflix3p', undoLinks);
          const wl = loadWaitlist();
          if (!wl.find(x => x.phone === phone)) { wl.push(w); saveWaitlist(wl); }
          sendTelegram(`⚠️ <b>3rd-Party Approve Failed — Back in Waitlist!</b>\n👤 ${w.customerName||'Customer'} | 📱 ${phone}\n\nWhatsApp failed. Slot released, customer back in waitlist.`);
        }
        return;
      }
      return res.status(503).json({ success:false, error:'No slots available (own + 3rd-party both full) for ' + d + ' day plan' });
    }

    const token = generateToken();
    allLinks[token] = { token, email:slot.email, profile:slot.profile, pin:slot.pin, phone, customerName:w.customerName||'', plan:w.product||'', amount:w.amount||0, orderName:w.orderName||'', renewalCount:0, days:d, createdAt:now, expiresAt:now+d*24*60*60*1000, uses:0, lastUsed:null, active:true, warningSent:false };
    saveLinks(allLinks);
    waitlist.splice(idx, 1);
    saveWaitlist(waitlist);
    checkLowStock();
    const dashLink = SITE_URL+'/c/'+token;
    res.json({ success:true, token, link:dashLink, profile:slot.profile, pin:slot.pin, pendingWhatsApp:true });
    sendWhatsAppDelivery(phone, slot.email, slot.profile, dashLink, w.customerName).then(sent => {
      if (sent) {
        sendTelegram(`✅ <b>Approved + WhatsApp Sent!</b>\n👤 ${w.customerName||'Customer'} | 📱 ${phone}\n👤 ${slot.profile} | PIN: ${slot.pin}\n🔗 ${dashLink}\n⏳ ${d} days`);
      } else {
        // WhatsApp failed even after retries - undo the slot assignment and put back in waitlist
        const currentLinks = loadLinks();
        delete currentLinks[token];
        saveLinks(currentLinks);
        const currentWaitlist = loadWaitlist();
        if (!currentWaitlist.find(x => x.phone === phone)) {
          currentWaitlist.push({ phone, customerName: w.customerName||'', days: d, product: w.product||'', orderName: w.orderName||'', amount: w.amount||0, addedAt: Date.now() });
          saveWaitlist(currentWaitlist);
        }
        sendTelegram(`⚠️ <b>WhatsApp Failed — Back in Waitlist!</b>\n👤 ${w.customerName||'Customer'} | 📱 ${phone}\n\nSlot released, customer moved back to Waitlist. Approve manually when ready.`);
      }
    });
  } catch(e) {
    console.error('Approve error:', e.message);
    res.status(500).json({ success:false, error:e.message });
  }
});

app.get('/api/admin/waitlist', adminAuth, (req, res) => {
  const waitlist = loadWaitlist();
  const links = loadLinks();
  const now = Date.now();
  // Flag entries whose phone already has an active (or pending-release) link -
  // these are likely renewals or accidental duplicates, not fresh new customers.
  const flagged = waitlist.map(w => {
    const phoneNorm = String(w.phone||'').replace(/\D/g,'');
    const existing = Object.values(links).filter(l =>
      l.phone && l.phone.replace(/\D/g,'') === phoneNorm && l.active && !l.released
    );
    return {
      ...w,
      hasExistingLink: existing.length > 0,
      existingExpired: existing.length > 0 && existing.every(l => l.expiresAt <= now),
    };
  });
  res.json({ success:true, waitlist: flagged, count: flagged.length });
});

// Pending Release — expired links waiting for manual slot release
app.get('/api/admin/pending-release', adminAuth, (req, res) => {
  try {
    const links = loadLinks();
    const accounts = loadAccounts();
    const now = Date.now();
    const pending = Object.entries(links)
      .filter(([token, l]) => l.active && !l.released && l.expiresAt <= now)
      .map(([token, l]) => ({
        token,
        email: l.email,
        profile: l.profile,
        pin: l.pin,
        phone: l.phone || '',
        customerName: l.customerName || '',
        expiresAt: l.expiresAt,
        daysOverdue: Math.floor((now - l.expiresAt) / (24*60*60*1000)),
      }))
      .sort((a,b) => a.expiresAt - b.expiresAt); // oldest expired first

    // Account-level summary with FULL visibility:
    // - activeCustomers: currently paying, not expired - shown with days-left + renewal count
    // - pendingRelease: expired but not yet released by admin (still occupying a slot)
    // - freeSlots: genuinely empty slots available for new customers right now
    const summaryMap = {};
    for (const account of accounts.filter(a => a.active)) {
      const occupyingLinks = Object.values(links).filter(l => l.email===account.email && l.active && !l.released);
      const activeCustomers = occupyingLinks
        .filter(l => l.expiresAt > now)
        .map(l => ({
          profile: l.profile,
          customerName: l.customerName || '',
          phone: l.phone || '',
          daysLeft: Math.ceil((l.expiresAt - now) / (24*60*60*1000)),
          renewalCount: l.renewalCount || 0,
        }))
        .sort((a,b) => a.daysLeft - b.daysLeft);
      const pendingForAccount = pending.filter(p => p.email === account.email);
      const totalSlots = getMaxSlotsForAccount(account);
      const occupied = occupyingLinks.length;
      summaryMap[account.email] = {
        email: account.email,
        totalSlots,
        activeCount: activeCustomers.length,
        activeCustomers,
        pendingReleaseCount: pendingForAccount.length,
        freeSlots: Math.max(0, totalSlots - occupied),
      };
    }
    const accountSummary = Object.values(summaryMap)
      .filter(s => s.pendingReleaseCount > 0)
      .sort((a,b) => b.pendingReleaseCount - a.pendingReleaseCount);

    res.json({ success:true, pending, count: pending.length, accountSummary });
  } catch(e) { res.json({ success:true, pending: [], count: 0, accountSummary: [] }); }
});

app.post('/api/admin/pending-release/:token/release', adminAuth, (req, res) => {
  try {
    const links = loadLinks();
    const link = links[req.params.token];
    if (!link) return res.status(404).json({ success:false, error:'Not found' });
    link.released = true;
    link.active = false;
    saveLinks(links);
    // Mark account for priority assignment - freed slot fills first
    const accounts = loadAccounts();
    const acctIdx = accounts.findIndex(a => a.email === link.email);
    if (acctIdx >= 0) {
      accounts[acctIdx].lastReleasedAt = Date.now();
      saveAccounts(accounts);
    }
    checkLowStock();
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/admin/pending-release/:token/extend', adminAuth, (req, res) => {
  try {
    const links = loadLinks();
    const link = links[req.params.token];
    if (!link) return res.status(404).json({ success:false, error:'Not found' });
    const days = normalizeDays(req.body.days || 30);
    link.expiresAt = Date.now() + days*24*60*60*1000;
    link.warningSent = false;
    link.expiredSmsSent = false;
    link.renewalSmsSent = false;
    link.renewalCount = (link.renewalCount || 0) + 1;
    saveLinks(links);
    sendTelegram(`✅ <b>Extended from Pending Release!</b>\n\n📧 ${link.email}\n👤 ${link.profile}\n⏳ +${days} days`);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/admin/waitlist/process', adminAuth, async (req, res) => {
  const waitlist = loadWaitlist();
  if (!waitlist.length) return res.json({ success:true, processed:0, message:'Waitlist empty' });
  let processed = 0;
  const remaining = [];
  for (const w of waitlist) {
    const slot = getNextAvailableSlot(w.days || 30, detectDeviceType(w.product));
    if (!slot) { remaining.push(w); continue; }
    const links = loadLinks();
    const now = Date.now();
    const token = generateToken();
    const d = normalizeDays(w.days);
    links[token] = { token, email:slot.email, profile:slot.profile, pin:slot.pin, phone:w.phone, customerName:w.customerName||'', plan:w.product||'', amount:w.amount||0, orderName:w.orderName||'', renewalCount:0, days:d, createdAt:now, expiresAt:now+d*24*60*60*1000, uses:0, lastUsed:null, active:true, warningSent:false };
    saveLinks(links);
    sendTelegram(`✅ <b>Waitlist Link Created!</b>\n\n👤 ${w.customerName||'Customer'} | 📱 ${w.phone}\n👤 ${slot.profile} | PIN: ${slot.pin}\n🔗 ${SITE_URL}/c/${token}\n⏳ ${d} days`);
    processed++;
  }
  saveWaitlist(remaining);
  checkLowStock();
  res.json({ success:true, processed, remaining: remaining.length });
});

app.delete('/api/admin/waitlist/:phone', adminAuth, (req, res) => {
  const waitlist = loadWaitlist();
  const filtered = waitlist.filter(w=>w.phone!==decodeURIComponent(req.params.phone));
  saveWaitlist(filtered);
  res.json({ success:true });
});


// ── UDDOKTAPAY WEBHOOK ────────────────────────────────────────────────────────
// Self-renewal - customer taps "Renew Now" on their dashboard, this creates
// a UddoktaPay checkout session pre-filled with their exact renewal amount.
// The customer picks whatever payment method they like on Uddoktapay's page
// (bKash/Nagad/EPS - all configured there already). Webhook below auto-extends.
app.post('/api/renew/create-payment', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success:false, error:'Missing token' });
    const links = loadLinks();
    const link = links[token];
    if (!link) return res.status(404).json({ success:false, error:'Link not found' });

    // Figure out the correct renewal amount from their current plan.
    // Match by stored plan name first, fall back to matching by their current day-length.
    let matchedPlan = PLANS.find(p => p.product === link.plan || p.name === link.plan);
    if (!matchedPlan) {
      const days = normalizeDays(link.days || 30);
      matchedPlan = PLANS.find(p => p.days === days) || PLANS[0];
    }

    const amount = matchedPlan.price;
    const days = matchedPlan.days;

    const chargeRes = await fetch(`${UDDOKTAPAY_BASE_URL}/checkout-v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'RT-UDDOKTAPAY-API-KEY': UDDOKTAPAY_API_KEY,
      },
      body: JSON.stringify({
        full_name: link.customerName || 'FanFlix Customer',
        email: 'customer@fanflixbd.com',
        amount: String(amount),
        metadata: { token, phone: link.phone || '', plan: matchedPlan.id, days: String(days) },
        // checkout-v2 appends its own invoice_id param to this URL on completion -
        // that's how we verify the payment (see /api/renew/verify-payment below).
        // Per UddoktaPay's own docs, checkout-v2 is "Success Page notification only" -
        // webhook_url is NOT reliably honored for this API type, so we don't depend on it.
        redirect_url: `${SITE_URL}/c/${token}?renew_plan=${encodeURIComponent(matchedPlan.name)}&renew_days=${days}`,
        return_type: 'GET',
        cancel_url: `${SITE_URL}/c/${token}?renew_cancelled=1`,
      }),
    });

    const chargeData = await chargeRes.json();
    const paymentUrl = chargeData.payment_url || chargeData.checkout_url || chargeData.url;

    if (!paymentUrl) {
      console.error('UddoktaPay charge creation failed:', chargeData);
      sendTelegram(`⚠️ <b>Self-Renew Payment Failed!</b>\n\n📱 ${link.phone || 'unknown'}\n👤 ${link.profile}\n🔗 /c/${token}\n\nUddoktaPay response: <code>${JSON.stringify(chargeData).slice(0,300)}</code>\n\nCustomer saw an error trying to renew. Check UddoktaPay integration.`);
      return res.status(502).json({ success:false, error:'Could not create payment session' });
    }

    res.json({ success:true, paymentUrl, plan: matchedPlan.name, amount, days });
  } catch(e) {
    console.error('create-payment error:', e.message);
    sendTelegram(`⚠️ <b>Self-Renew Payment Error!</b>\n\n📱 ${req.body?.token || 'unknown token'}\n\nError: ${e.message}\n\nCustomer could not start renewal payment.`);
    res.status(500).json({ success:false, error:e.message });
  }
});

// Verifies a self-renew payment directly with UddoktaPay's Verify Payment API,
// triggered by the customer's browser right after they're redirected back from
// checkout. This is the officially correct method for checkout-v2 (per UddoktaPay's
// own docs, checkout-v2 is "Success Page notification only" - it does not reliably
// fire the webhook_url override), so we don't wait on a webhook at all here.
const _verifiedInvoices = new Set(); // dedup - prevents double-extending on page refresh
app.post('/api/renew/verify-payment', async (req, res) => {
  try {
    const { token, invoice_id } = req.body;
    if (!token || !invoice_id) return res.status(400).json({ success:false, error:'Missing token or invoice_id' });

    if (_verifiedInvoices.has(invoice_id)) {
      return res.json({ success:true, alreadyProcessed:true });
    }

    const links = loadLinks();
    const link = links[token];
    if (!link) return res.status(404).json({ success:false, error:'Link not found' });

    const verifyRes = await fetch(`${UDDOKTAPAY_BASE_URL}/verify-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'RT-UDDOKTAPAY-API-KEY': UDDOKTAPAY_API_KEY,
      },
      body: JSON.stringify({ invoice_id }),
    });
    const verifyData = await verifyRes.json();

    if (verifyData.status !== 'COMPLETED') {
      return res.json({ success:false, error:'Payment not completed', status: verifyData.status||'unknown' });
    }

    _verifiedInvoices.add(invoice_id);
    if (_verifiedInvoices.size > 500) {
      const arr = [..._verifiedInvoices];
      _verifiedInvoices.clear();
      arr.slice(-200).forEach(i => _verifiedInvoices.add(i));
    }

    const meta = verifyData.metadata || {};
    const renewDays = parseInt(meta.days) || normalizeDays(link.days || 30);
    renewCustomerLink(links, token, renewDays);
    saveLinks(links);

    sendTelegram(
      `🔄 <b>Auto-Renewed by Customer!</b>\n\n` +
      `👤 ${link.customerName || 'Customer'} | 📱 ${link.phone || 'unknown'}\n` +
      `👤 ${link.profile}\n` +
      `💰 ৳${verifyData.amount||'?'} via ${verifyData.payment_method || 'UddoktaPay'}\n` +
      `🔗 Extended +${renewDays} days\n\n` +
      `✅ Self-service — no manual work needed`
    );

    res.json({ success:true, days: renewDays });
  } catch(e) {
    console.error('verify-payment error:', e.message);
    sendTelegram(`⚠️ <b>Self-Renew Verification Error!</b>\n\nToken: ${req.body?.token||'unknown'}\nError: ${e.message}\n\nCustomer paid but verification failed - check manually.`);
    res.status(500).json({ success:false, error:e.message });
  }
});

app.post('/uddoktapay-ipn', async (req, res) => {
  try {
    // Verify API key
    const apiKey = req.headers['rt-uddoktapay-api-key'];
    if (!apiKey || apiKey !== process.env.UDDOKTAPAY_API_KEY) {
      console.error('UddoktaPay: Invalid API key');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    res.status(200).json({ success: true }); // Respond immediately

    const data = req.body;
    const { full_name, sender_number, amount, payment_method, invoice_id } = data;
    let metadata = data.metadata;
    if (typeof metadata === 'string') {
      try { metadata = JSON.parse(metadata); } catch(e) { metadata = null; }
    }

    if (!sender_number || !amount) return;

    const phone = sender_number.replace(/\D/g, '');
    const customerName = full_name || '';
    const amountNum = parseFloat(amount) || 0;

    // Detect plan from amount
    let days = 30;
    let product = 'Netflix';
    if (amountNum >= 1200) { days = 90; product = 'Netflix 3 Month'; }
    else if (amountNum >= 390) { days = 30; product = 'Netflix 1 Month'; }

    // Check metadata for order info
    const orderName = metadata?.order_id || metadata?.order_name || invoice_id || '';

    // Send Telegram notification
    sendTelegram(
      `✅ <b>New Payment — UddoktaPay</b>
` +
      `━━━━━━━━━━━━━━━━━━
` +
      `👤 ${customerName} | 📱 ${sender_number}
` +
      `💰 ৳${amount} | 💳 ${payment_method}
` +
      `🔖 ${invoice_id}
` +
      `━━━━━━━━━━━━━━━━━━`
    );

    const settings = loadSettings();

    // Self-renewal via "Renew Now" button - metadata.token identifies the exact
    // link to extend. This always works regardless of autoLink setting, since
    // it's a renewal of an existing customer, not creation of a new one.
    if (metadata && metadata.token) {
      const allLinksForToken = loadLinks();
      const targetLink = allLinksForToken[metadata.token];
      if (targetLink) {
        const renewDays = parseInt(metadata.days) || normalizeDays(days);
        renewCustomerLink(allLinksForToken, metadata.token, renewDays);
        saveLinks(allLinksForToken);
        sendTelegram(
          `🔄 <b>Auto-Renewed by Customer!</b>\n\n` +
          `👤 ${customerName || targetLink.customerName || 'Customer'} | 📱 ${sender_number}\n` +
          `👤 ${targetLink.profile}\n` +
          `💰 ৳${amount} via ${payment_method || 'UddoktaPay'}\n` +
          `🔗 Extended +${renewDays} days\n\n` +
          `✅ Self-service — no manual work needed`
        );
        return;
      }
      // Token given but link missing (deleted?) - fall through to phone-based matching below
    }

    if (!settings.autoLink) return;

    // Auto-create link (reuse same logic as /api/auto-create)
    const phoneNorm = phone;
    const allLinks = loadLinks();
    const now = Date.now();

    // Renewal check
    const existingActive = Object.values(allLinks).filter(l =>
      l.phone && l.phone.replace(/\D/g,'') === phoneNorm && l.active && !l.released
    );
    if (existingActive.length > 0) {
      for (const el of existingActive) {
        renewCustomerLink(allLinks, el.token, days);
      }
      saveLinks(allLinks);
      sendTelegram(`🔄 <b>Renewal via UddoktaPay!</b>
👤 ${customerName} | 📱 ${sender_number}
🔗 Extended ${existingActive.length} link(s) +${days} days`);
      return;
    }

    // Send order confirmation immediately, then wait 20s before attempting delivery
    sendOrderConfirmation(phone, customerName, product, amountNum, orderName || invoice_id).then(sent => {
      if (!sent) console.error('order_confirmation send failed for', phone);
    });
    await new Promise(r => setTimeout(r, 20000));

    // New customer
    const slot = getNextAvailableSlot(days, detectDeviceType(product));
    if (!slot) {
      const waitlist = loadWaitlist();
      if (!waitlist.find(w => w.phone === phone)) {
        waitlist.push({ phone, customerName, days, product, orderName, amount: amountNum, addedAt: now });
        saveWaitlist(waitlist);
      }
      sendTelegram(`🚨 <b>STOCK OUT — UddoktaPay!</b>
👤 ${customerName} | 📱 ${sender_number}
📦 ${product} | ৳${amount}
Added to waitlist.`);
      return;
    }

    const token = generateToken();
    allLinks[token] = { token, email:slot.email, profile:slot.profile, pin:slot.pin, phone, customerName, plan:product, amount:amountNum, orderName, renewalCount:0, days, createdAt:now, expiresAt:now+days*24*60*60*1000, uses:0, lastUsed:null, active:true, warningSent:false };
    saveLinks(allLinks);
    checkLowStock();

    const dashLink = `${SITE_URL}/c/${token}`;
    sendWhatsAppDelivery(phone, slot.email, slot.profile, dashLink, customerName).then(sent => {
      if (sent) {
        sendTelegram(
          `✅ <b>Auto-Delivered via WhatsApp!</b>
` +
          `🤜 ${customerName} | 📱 ${sender_number}
` +
          `🤜 ${slot.profile} | PIN: ${slot.pin}
` +
          `🔗 ${dashLink}
` +
          `⏳ ${days} days

` +
          `📲 Sent automatically — no action needed`
        );
      } else {
        // WhatsApp failed even after retries - undo the slot assignment and put in waitlist
        const currentLinks = loadLinks();
        delete currentLinks[token];
        saveLinks(currentLinks);
        const currentWaitlist = loadWaitlist();
        if (!currentWaitlist.find(x => x.phone === phone)) {
          currentWaitlist.push({ phone, customerName, days, product, orderName, amount: amountNum, addedAt: Date.now() });
          saveWaitlist(currentWaitlist);
        }
        sendTelegram(
          `⚠️ <b>WhatsApp Failed — Back in Waitlist!</b>
` +
          `🤜 ${customerName} | 📱 ${sender_number}

` +
          `Slot released, customer moved back to Waitlist. Approve manually when ready.`
        );
      }
    });

  } catch(e) {
    console.error('UddoktaPay IPN error:', e.message);
  }
});

// Force refresh codes for a token (clears cache)
app.get('/api/link/:token/refresh', async (req, res) => {
  const links = loadLinks();
  const link = links[req.params.token];
  if (!link) return res.status(404).json({ success:false });
  if (!link.active || link.expiresAt <= Date.now()) return res.status(403).json({ success:false });
  // Clear cache so this is a genuinely fresh look, not a stale hit.
  clearEmailCache(link.email);
  try {
    // Race every source at once (IMAP + all nfpro choices + FFU) - no source is
    // skipped, whichever answers with a code first wins. Safety filter (household/
    // update only) is applied inside the helper, unconditionally, before this ever
    // reaches the customer.
    const codes = await fetchAllSourcesForCustomer(link.email);
    res.json({ success:true, codes, count:codes.length, refreshed:true });
  } catch(err) {
    res.json({ success:true, codes:[], count:0, refreshed:true });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok:true, user:GMAIL_USER?GMAIL_USER.replace(/(.{3}).*(@.*)/,'$1***$2'):'NOT SET' });
});

// Debug endpoint - test if Railway can reach geo-IP APIs
app.get('/api/admin/test-geo', adminAuth, async (req, res) => {
  const testIp = req.query.ip || '8.8.8.8'; // Google DNS as default test IP
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const result = { testIp, clientIp, timestamp: new Date().toISOString() };

  // Test ipwho.is (the one we now use - HTTPS native)
  try {
    const r = await fetch(`https://ipwho.is/${testIp}`);
    const d = await r.json();
    result.ipwhois = { success: true, httpStatus: r.status, response: d };
  } catch(e) {
    result.ipwhois = { success: false, error: e.message };
  }

  // Test ip-api.com HTTPS (known broken - free tier has no SSL)
  try {
    const r = await fetch(`https://ip-api.com/json/${testIp}?fields=country,countryCode,status,message`);
    const d = await r.json();
    result.ipApiHttps = { success: true, httpStatus: r.status, response: d };
  } catch(e) {
    result.ipApiHttps = { success: false, error: e.message };
  }

  res.json(result);
});

// One-time cleanup — removes malformed account entries (spaces, typos in email)
app.post('/api/admin/accounts/cleanup', adminAuth, (req, res) => {
  const accounts = loadAccounts();
  const before = accounts.length;
  const cleaned = accounts
    .map(a => ({ ...a, email: a.email.trim().toLowerCase() }))
    .filter(a => a.email.includes('@'));
  // Remove duplicates
  const seen = new Set();
  const unique = cleaned.filter(a => { if(seen.has(a.email)) return false; seen.add(a.email); return true; });
  saveAccounts(unique);
  res.json({ success:true, before, after:unique.length, removed: before - unique.length });
});

// Fetch a code/link from the nfpro.store API for one email + one choice type.
// Returns an array of code objects (same shape as our own parser) or [] on any
// failure - so the caller can safely fall back or continue.
async function fetchFromNfpro(email, choice = 'household') {
  try {
    // 3s timeout (not 10s) - since IMAP+nfpro+FFU race in parallel via
    // Promise.allSettled, which waits for ALL of them, a slow provider would
    // otherwise stretch the whole customer-facing fetch past the 3s speed target.
    const r = await fetch(NFPRO_API_URL, {
      method: 'POST',
      headers: { 'X-Api-Key': NFPRO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, choice }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    const now = Date.now();
    // Map nfpro's choice to our display type/label so cards render consistently.
    const CHOICE_META = {
      'household':    { type:'household', codeLabel:'Temporary Access Code', linkLabel:'Update Household (TV)' },
      '4-digit':      { type:'signin',    codeLabel:'Sign-in Code' },
      'verification': { type:'verify',    codeLabel:'Verification Code' },
      '2FA':          { type:'2fa',       codeLabel:'2FA Code' },
      'RESET':        { type:'reset',     codeLabel:'Password Reset Link' },
    };
    const meta = CHOICE_META[choice] || { type:'household', codeLabel:'Code' };
    if (d.code) {
      return [{ type:meta.type, label:meta.codeLabel, code:String(d.code), to:email, ts:now, expiresAt:now+15*60*1000, source:'nfpro' }];
    }
    if (d.link) {
      const isUpdate = String(d.link).includes('update-primary') || String(d.link).includes('update-household');
      const label = isUpdate ? 'Update Household (TV)' : (meta.linkLabel || meta.codeLabel);
      const type = isUpdate ? 'update' : (choice === 'RESET' ? 'reset' : meta.type);
      return [{ type, label, link:String(d.link), to:email, ts:now, expiresAt:now+15*60*1000, source:'nfpro' }];
    }
    return [];
  } catch(e) {
    console.error('nfpro fetch error:', e.message);
    return [];
  }
}

// Full-access mode ("all access"): query nfpro.store for EVERY choice type it
// supports (household, 4-digit, verification, 2FA, RESET) in parallel, merging
// whatever comes back. Individual choice failures don't affect the others.
async function fetchAllFromNfpro(email) {
  const choices = ['household', '4-digit', 'verification', '2FA', 'RESET'];
  const results = await Promise.allSettled(choices.map(c => fetchFromNfpro(email, c)));
  const merged = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.length > 0) merged.push(...r.value);
  }
  return merged;
}

// Second fallback provider (FFU). Response shape isn't fully confirmed yet, so this
// checks several common field names defensively. If none match, it logs the raw
// response so we can see exactly what came back and adjust the parsing.
// Each FFU choice maps to its own distinct type/label - 'household' reuses our
// existing safe household type, everything else gets its own type and stays
// admin-only (/vionex) until explicitly confirmed safe for customers.
const FFU_CHOICE_META = {
  'household':                       { type:'household', label:'Household Code (FFU)' },
  'reset':                           { type:'reset', label:'Password Reset Link (FFU)' },
  'login_code':                      { type:'login_code', label:'Login Code (FFU)' },
  'verification_code_after_login':   { type:'verify_after_login', label:'Verification Code (Post-Login)' },
  'verify_email':                    { type:'verify_email', label:'Verify Email Code' },
  'tv_login':                        { type:'tv_login', label:'TV Login Code' },
};
async function fetchFromFFU(email, choice = 'login_code') {
  try {
    const r = await fetch(FFU_API_URL, {
      method: 'POST',
      headers: { 'X-Api-Key': FFU_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, choice }),
      signal: AbortSignal.timeout(3000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`FFU fetch failed (${choice}):`, r.status, JSON.stringify(d).slice(0,300));
      return [];
    }
    const now = Date.now();
    const meta = FFU_CHOICE_META[choice] || { type:'login_code', label:'Code (FFU)' };
    const code = d.code || d.otp || d.pin || d.result?.code;
    const link = d.link || d.url || d.result?.link;
    if (code) {
      return [{ type:meta.type, label:meta.label, code:String(code), to:email, ts:now, expiresAt:now+15*60*1000, source:'ffu' }];
    }
    if (link) {
      return [{ type:meta.type, label:meta.label, link:String(link), to:email, ts:now, expiresAt:now+15*60*1000, source:'ffu' }];
    }
    // Nothing matched our known field names - log the raw shape so we can extend
    // the parsing above once we see a real response.
    console.log(`FFU response (${choice}) had no recognized code/link field:`, JSON.stringify(d).slice(0,300));
    return [];
  } catch(e) {
    console.error('FFU fetch error:', e.message);
    return [];
  }
}

async function fetchAllFromFFU(email) {
  const results = await Promise.allSettled(FFU_CHOICES.map(c => fetchFromFFU(email, c)));
  const merged = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.length > 0) merged.push(...r.value);
  }
  return merged;
}

// Public customers may only ever see household code / TV update link - never
// sign-in or verification codes (those could let someone take over the account).
// The shared background-poller cache mixes all types together (it always polls
// with includeSignin:true so the /vionex full-access tool has everything ready),
// so the PUBLIC endpoint must filter it down before returning anything from it.
const CUSTOMER_SAFE_TYPES = new Set([
  'household', 'update',            // our own IMAP-classified types
  'login_code',                     // FFU - approved earlier
  'verify_after_login',             // FFU 'verification_code_after_login' - approved
  'verify_email',                   // FFU 'verify_email' - approved
  'tv_login',                       // FFU 'tv_login' - approved
  // Deliberately excluded: nfpro's signin/verify/2FA/reset, and FFU's 'reset' -
  // these grant full account-level access (password change, billing, etc.),
  // not just "this device belongs to the household."
]);
function publicSafeCodes(codes) {
  return (codes || []).filter(c => CUSTOMER_SAFE_TYPES.has(c.type));
}

// Fast, comprehensive code lookup for customer-facing endpoints. Races EVERY source
// (our own cache, a fresh IMAP search, all of nfpro's choices, and FFU) in parallel -
// no source is skipped, so whichever one actually has the code answers fastest. The
// safety filter (household/update only) is always applied LAST, after merging, so no
// matter which source responds, sign-in/verify/2FA/reset/login_code can never reach
// a customer - the speed and the safety are two independent, unconditional steps.
// Races every source (cache, fresh IMAP, all nfpro choices, FFU) in parallel and
// merges them - no source skipped. Old codes stay visible until their OWN natural
// expiry (15 min from receipt); a new code arriving does NOT remove an older
// still-valid one, so nothing vanishes from view just because something newer
// showed up. Returns the raw, UNFILTERED merged list (all types included) -
// callers apply their own safety filtering as needed.
async function fetchAllSourcesRaw(email) {
  const bgCached = getCodesFromCache(email) || [];
  // Hard 3s cap on the WHOLE fetch, not just each individual source. Previously,
  // even with nfpro/FFU capped at 3s each, Promise.allSettled still waited for
  // the SLOWEST of all three before returning anything - so a slow IMAP
  // connection could still push the customer's wait well past 3s. Now: whichever
  // sources have answered within 3s are used immediately; any still-running ones
  // keep going in the background and just update the cache for the NEXT request
  // (auto-poll or refresh) instead of making this one wait for them.
  const TIMEOUT = Symbol('timeout');
  const timeoutAt = (ms) => new Promise(resolve => setTimeout(() => resolve(TIMEOUT), ms));

  const imapPromise = (bgCached.length > 0 ? Promise.resolve([]) : fetchNetflixEmailsFresh(email, true)).catch(() => []);
  const nfproPromise = fetchAllFromNfpro(email).catch(() => []);
  const ffuPromise = fetchAllFromFFU(email).catch(() => []);

  const [imapResult, nfproResult, ffuResult] = await Promise.all([
    Promise.race([imapPromise, timeoutAt(3000)]),
    Promise.race([nfproPromise, timeoutAt(3000)]),
    Promise.race([ffuPromise, timeoutAt(3000)]),
  ]);
  const imapCodes = imapResult === TIMEOUT ? [] : imapResult;
  const nfproCodes = nfproResult === TIMEOUT ? [] : nfproResult;
  const ffuCodes = ffuResult === TIMEOUT ? [] : ffuResult;

  // Whatever's still running after the cap gets to finish quietly in the
  // background - if it turns up something, it lands in the cache for next time.
  Promise.all([imapPromise, nfproPromise, ffuPromise]).then(([i, n, f]) => {
    const bgNow = Date.now();
    const seenBg = new Set();
    const bgMerged = [...(getCodesFromCache(email) || []), ...i, ...n, ...f].filter(c => {
      if (c.expiresAt && c.expiresAt < bgNow) return false;
      const k = c.code || c.link;
      if (!k || seenBg.has(k)) return false;
      seenBg.add(k);
      return true;
    }).sort((a,b) => b.ts - a.ts);
    if (bgMerged.length > 0) setCodesInCache(email, bgMerged);
  }).catch(() => {});

  const merged = [...bgCached, ...imapCodes, ...nfproCodes, ...ffuCodes];
  const now = Date.now();
  const seen = new Set();
  const allCodes = merged.filter(c => {
    if (c.expiresAt && c.expiresAt < now) return false; // naturally expired - drop
    const k = c.code || c.link;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a,b) => b.ts - a.ts);

  if (allCodes.length > 0) setCodesInCache(email, allCodes);
  return { allCodes, imapCodes, nfproCodes, ffuCodes, bgCached };
}

// Customer-facing wrapper - same fetch/merge as above, but always applies the
// household/update/login_code safety filter before returning.
async function fetchAllSourcesForCustomer(email) {
  const { allCodes } = await fetchAllSourcesRaw(email);
  return publicSafeCodes(allCodes);
}

app.get('/api/codes', async (req, res) => {
  const email = (req.query.email||'').trim();
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  trackVisitor(ip); resetDailyIfNeeded();
  if (isRateLimited(ip)) return res.status(429).json({ success:false, error:'Too many requests. Wait 5 minutes.' });
  const cached = getCached(email);
  if (cached) return res.json({ success:true, codes:publicSafeCodes(cached), count:publicSafeCodes(cached).length, cached:true, fetchTime:0 });
  const start = Date.now();
  try {
    const bgCached = getCodesFromCache(email);
    const bgSafe = bgCached !== null ? publicSafeCodes(bgCached) : null;
    if (bgSafe !== null && bgSafe.length > 0) {
      const fetchTime = '0.0';
      return res.json({ success:true, codes:bgSafe, count:bgSafe.length, fetchTime, cached:true });
    }
    // 1) Try our own IMAP first (free, already running)
    let codes = await fetchNetflixEmailsFresh(email, false);
    let via = 'imap';
    // 2) Fall back to nfpro.store API if our own inbox had nothing for this email
    if (!codes || codes.length === 0) {
      const nfpro = await fetchFromNfpro(email);
      if (nfpro.length > 0) { codes = nfpro; via = 'nfpro'; }
    }
    codes = publicSafeCodes(codes);
    const fetchTime = ((Date.now()-start)/1000).toFixed(1);
    setCodesInCache(email, codes);
    setCache(email, codes);
    if (codes.length > 0) totalToday += 1;
    res.json({ success:true, codes, count:codes.length, fetchTime, via });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

// Full-access variant of /api/codes - requires the secret key (only ever embedded
// in the page when served from ADMIN_TOOL_PATH, never in the public index.html file
// on disk). Returns household + update-link + sign-in (4-digit) + verification
// (6-digit) codes. Never used by the public tool.
app.get('/api/codes-full', async (req, res) => {
  const email = (req.query.email||'').trim();
  const key = (req.query.key||'').trim();
  console.log(`[codes-full] request received for ${email} - key match: ${key === ADMIN_TOOL_KEY}`);
  if (key !== ADMIN_TOOL_KEY) return res.status(403).json({ success:false, error:'Invalid key' });
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  trackVisitor(ip); resetDailyIfNeeded();
  const start = Date.now();
  try {
    // "All access": pull from every source we have at once, in parallel, and merge -
    // same shared logic as the customer-facing endpoints, just unfiltered here since
    // /vionex is admin-only (all types shown: household/update/signin/verify/2FA/
    // reset/login_code). Old codes stay visible until their own natural expiry.
    const { allCodes: codes, imapCodes, nfproCodes, ffuCodes, bgCached } = await fetchAllSourcesRaw(email);
    const fetchTime = ((Date.now()-start)/1000).toFixed(1);
    const sources = [];
    if (bgCached.length > 0) sources.push('cache');
    if (imapCodes.length > 0) sources.push('imap');
    if (nfproCodes.length > 0) sources.push('nfpro');
    if (ffuCodes.length > 0) sources.push('ffu');
    const via = sources.length > 0 ? sources.join('+') : 'none';
    console.log(`[codes-full] ${email} -> sources:[${via}] imap:${imapCodes.length} nfpro:${nfproCodes.length} ffu:${ffuCodes.length} total:${codes.length}`);
    res.json({ success:true, codes, count:codes.length, fetchTime, via });
  } catch(err) {
    console.error('[codes-full] CRASHED:', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ success:false, error:err.message });
  }
});

// Public tool landing page - branded per domain (see BRANDS config above).
app.get('/', (req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const brand = getBrand(req.hostname);
    res.send(applyBrand(html, brand));
  } catch(e) { res.status(500).send('Error loading page'); }
});

// Secret full-access tool page - same UI as the public tool (/), served dynamically
// with a flag + secret key injected so the frontend knows to call /api/codes-full.
// The public index.html file on disk never contains this key. Also branded per
// domain, same as the public page.
app.get(ADMIN_TOOL_PATH, (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const brand = getBrand(req.hostname);
    html = applyBrand(html, brand);
    const inject = `<script>window.__FULL_ACCESS__=true;window.__FULL_KEY__=${JSON.stringify(ADMIN_TOOL_KEY)};</script>`;
    html = html.replace('</head>', inject + '</head>');
    res.send(html);
  } catch(e) { res.status(500).send('Error loading page'); }
});

app.get('/admin-manifest.json', (req, res) => res.sendFile(path.join(__dirname,'public','admin-manifest.json')));
app.get('/admin-sw.js', (req, res) => res.sendFile(path.join(__dirname,'public','admin-sw.js')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname,'public','admin.html')));

// ── STREAMING PRODUCT ADMIN ENDPOINTS ────────────────────────────────────────
// GET  /api/admin/streaming/:type/accounts  - list all accounts for a product
// POST /api/admin/streaming/:type/accounts  - add a new account
// DELETE /api/admin/streaming/:type/accounts/:id - remove an account
// GET  /api/admin/streaming/:type/links     - list all customer links for a product

app.get('/api/admin/streaming/:type/accounts', adminAuth, (req, res) => {
  const { type } = req.params;
  if (!STREAMING_PRODUCTS[type]) return res.status(400).json({ error:'Unknown type' });
  const accounts = loadStreamingAccounts(type);
  const links = loadStreamingLinks(type);
  const profiles = STREAMING_PROFILES[type];
  const maxSlots = getMaxSlotsForStreamingAccount(type);
  const withStats = accounts.map(a => {
    const accountLinks = Object.values(links).filter(l => l.accountId === a.id && l.active && !l.released);
    return { ...a, slotsUsed: accountLinks.length, slotsTotal: maxSlots };
  });
  res.json({ success:true, accounts: withStats, maxSlots, hasProfiles: !!profiles });
});

app.post('/api/admin/streaming/:type/accounts', adminAuth, (req, res) => {
  const { type } = req.params;
  if (!STREAMING_PRODUCTS[type]) return res.status(400).json({ error:'Unknown type' });
  const { email, password, notes } = req.body;
  if (!email || !password) return res.status(400).json({ error:'Email and password required' });
  const accounts = loadStreamingAccounts(type);
  const id = crypto.randomBytes(6).toString('hex');
  // pins is an object mapping profile name to PIN - admin fills these in when adding the account
  const pins = req.body.pins || {};
  accounts.push({ id, email: email.toLowerCase().trim(), password, pins, notes: notes||'', active:true, addedAt:Date.now() });
  saveStreamingAccounts(type, accounts);
  res.json({ success:true, id });
});

app.delete('/api/admin/streaming/:type/accounts/:id', adminAuth, (req, res) => {
  const { type, id } = req.params;
  if (!STREAMING_PRODUCTS[type]) return res.status(400).json({ error:'Unknown type' });
  const accounts = loadStreamingAccounts(type);
  const filtered = accounts.filter(a => a.id !== id);
  saveStreamingAccounts(type, filtered);
  res.json({ success:true });
});

app.get('/api/admin/streaming/:type/links', adminAuth, (req, res) => {
  const { type } = req.params;
  if (!STREAMING_PRODUCTS[type]) return res.status(400).json({ error:'Unknown type' });
  const links = loadStreamingLinks(type);
  const now = Date.now();
  const result = Object.values(links).map(l => ({
    ...l,
    daysLeft: Math.max(0, Math.ceil((l.expiresAt - now) / 86400000)),
    expired: l.expiresAt < now,
  })).sort((a,b) => b.createdAt - a.createdAt);
  res.json({ success:true, links: result, total: result.length });
});

// Revoke a specific streaming customer - frees their slot immediately
app.post('/api/admin/streaming/:type/revoke/:token', adminAuth, (req, res) => {
  const { type, token } = req.params;
  if (!STREAMING_PRODUCTS[type]) return res.status(400).json({ error:'Unknown type' });
  const links = loadStreamingLinks(type);
  if (!links[token]) return res.status(404).json({ success:false, error:'Link not found' });
  links[token].active = false;
  links[token].released = true;
  links[token].revokedAt = Date.now();
  saveStreamingLinks(type, links);
  res.json({ success:true });
});

app.get('/api/admin/accounts', adminAuth, (req, res) => {
  const accounts = loadAccounts();
  const links = loadLinks();
  const now = Date.now();
  const result = accounts.map(a => {
    // Occupied = link exists and not released (regardless of expiry) - matches slot assignment logic
    const occupying = Object.values(links).filter(l => l.email===a.email && l.active && !l.released);
    const pendingRelease = occupying.filter(l => l.expiresAt <= now).length;
    // Days-left for each currently active (paying, not expired) customer - for compact display
    const activeDaysLeft = occupying
      .filter(l => l.expiresAt > now)
      .map(l => Math.ceil((l.expiresAt - now) / (24*60*60*1000)))
      .sort((x,y) => x - y);
    return { ...a, deviceType: a.deviceType||'mobile', slotsUsed: occupying.length, slotsTotal: getMaxSlotsForAccount(a), pendingRelease, activeDaysLeft, planDays: a.planDays||null, expiresAt: a.expiresAt||null };
  });
  res.json({ success:true, accounts: result });
});

// Netflix account performance - ranks accounts by incidents & non-renewal rate to spot problem accounts
app.get('/api/admin/account-performance', adminAuth, (req, res) => {
  try {
    const accounts = loadAccounts();
    const links = loadLinks();
    const alerts = loadNetflixAlerts();
    const now = Date.now();

    const result = accounts.map(a => {
      const accountLinks = Object.values(links).filter(l => l.email === a.email);
      const everCount = accountLinks.length;
      const renewedCount = accountLinks.filter(l => (l.renewalCount||0) > 0).length;
      const neverRenewedExpired = accountLinks.filter(l => !l.active && !l.released && l.expiresAt <= now && !(l.renewalCount>0)).length;
      const outsideBdCount = alerts.filter(al => al.email === a.email && al.source !== 'pin_change').length;
      const pinChangeCount = alerts.filter(al => al.email === a.email && al.source === 'pin_change').length;
      const nonRenewalRate = everCount > 0 ? Math.round((1 - renewedCount/everCount) * 100) : 0;
      const riskScore = outsideBdCount*3 + pinChangeCount*2 + neverRenewedExpired;
      const activeCount = accountLinks.filter(l => l.active && !l.released && l.expiresAt > now).length;

      return {
        email: a.email,
        active: a.active !== false,
        everCount,
        activeCount,
        outsideBdCount,
        pinChangeCount,
        nonRenewalRate,
        riskScore,
        bannedDetected: a.bannedDetected || false,
        bannedAt: a.bannedAt || null,
      };
    }).sort((a,b) => (b.bannedDetected?1:0) - (a.bannedDetected?1:0) || b.riskScore - a.riskScore);

    res.json({ success:true, accounts: result });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

// Universal search - finds a customer across Customer Links, Waitlist, Pending Release, Outside BD alerts
app.get('/api/admin/universal-search', adminAuth, (req, res) => {
  try {
    const q = String(req.query.q||'').toLowerCase().trim();
    const qDigits = q.replace(/\D/g,'');
    if (!q) return res.json({ success:true, results: [] });

    const links = loadLinks();
    const waitlist = loadWaitlist();
    const alerts = loadNetflixAlerts();
    const now = Date.now();
    const results = [];

    const matches = (str) => String(str||'').toLowerCase().includes(q) || (qDigits && String(str||'').replace(/\D/g,'').includes(qDigits));

    for (const [token, l] of Object.entries(links)) {
      if (matches(l.phone) || matches(l.customerName) || matches(l.email) || token===q) {
        const status = l.released ? 'released' : !l.active ? 'blocked' : l.expiresAt<=now ? 'pending-release' : 'active';
        results.push({ section:'Customer Links', token, phone:l.phone||'', name:l.customerName||'', detail:`${l.email} · ${l.profile} · ${status}` });
      }
    }
    for (const w of waitlist) {
      if (matches(w.phone) || matches(w.customerName)) {
        results.push({ section:'Waitlist', phone:w.phone||'', name:w.customerName||'', detail:`${w.product||'Netflix'} · ৳${w.amount||0} · waiting approval` });
      }
    }
    for (const a of alerts) {
      if (matches(a.phone) || matches(a.customerName) || matches(a.email)) {
        const label = a.source==='pin_change' ? 'PIN Change' : a.source==='dashboard' ? 'Outside BD (Dashboard)' : 'Outside BD (Netflix Login)';
        results.push({ section:'Alerts', phone:a.phone||'', name:a.customerName||'', detail:`${label} · ${a.email} · ${new Date(a.ts).toLocaleDateString()}` });
      }
    }

    res.json({ success:true, results: results.slice(0, 50) });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/admin/accounts', adminAuth, (req, res) => {
  const { email, notes, priority } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ success:false, error:'Invalid email' });
  const accounts = loadAccounts();
  if (accounts.find(a => a.email === email.toLowerCase().trim())) {
    return res.status(400).json({ success:false, error:'Account already exists' });
  }
  const planDays = req.body.planDays ? parseInt(req.body.planDays) : null;
  const expiresAt = req.body.expiresAt || null;
  const deviceType = req.body.deviceType === 'tv' ? 'tv' : 'mobile';
  accounts.push({ email:email.toLowerCase().trim(), deviceType, notes:notes||'', priority:priority||accounts.length+1, active:true, addedAt:Date.now(), planDays, expiresAt });
  saveAccounts(accounts);
  res.json({ success:true });
});

app.post('/api/admin/accounts/:email/devicetype', adminAuth, (req, res) => {
  const accounts = loadAccounts();
  const target = decodeURIComponent(req.params.email).trim().toLowerCase();
  const idx = accounts.findIndex(a => a.email === target);
  if (idx === -1) return res.status(404).json({ success:false, error:'Not found' });
  accounts[idx].deviceType = req.body.deviceType === 'tv' ? 'tv' : 'mobile';
  saveAccounts(accounts);
  res.json({ success:true, deviceType: accounts[idx].deviceType });
});

app.post('/api/admin/accounts/:email/clear-banned', adminAuth, (req, res) => {
  const accounts = loadAccounts();
  const target = decodeURIComponent(req.params.email).trim().toLowerCase();
  const idx = accounts.findIndex(a => a.email === target);
  if (idx === -1) return res.status(404).json({ success:false, error:'Not found' });
  delete accounts[idx].bannedDetected;
  delete accounts[idx].bannedAt;
  saveAccounts(accounts);
  res.json({ success:true });
});

// Cleanup ALL banned/cancelled accounts in one action - removes each flagged account
// from accounts.json, recycles its customer links, and suppresses future alerts.
app.post('/api/admin/accounts/cleanup-banned', adminAuth, (req, res) => {
  const accounts = loadAccounts();
  const banned = accounts.filter(a => a.bannedDetected);
  if (banned.length === 0) return res.json({ success:true, removed:0, linksAffected:0, message:'No banned accounts found.' });

  const bannedEmails = new Set(banned.map(a => a.email.trim().toLowerCase()));
  const now = Date.now();

  // Remove banned accounts from the pool
  const remaining = accounts.filter(a => !a.bannedDetected);
  saveAccounts(remaining);

  // Recycle all their customer links
  const links = loadLinks();
  let linksAffected = 0;
  for (const token of Object.keys(links)) {
    const em = (links[token].email || '').trim().toLowerCase();
    if (bannedEmails.has(em)) {
      links[token].active = false;
      links[token].released = true;
      links[token].recycled = true;
      links[token].recycledAt = now;
      links[token].recycledReason = 'account_banned_cleanup';
      linksAffected++;
    }
  }
  if (linksAffected > 0) saveLinks(links);
  try { cache.clear(); } catch(e) {}

  // Suppress future alerts for all of them
  bannedEmails.forEach(em => deletedAccountEmails.add(em));
  persistDeletedEmails();

  sendTelegram(`🧹 <b>Banned Accounts Cleaned Up</b>\n\n🗑 Removed <b>${banned.length}</b> banned account(s)\n🔗 ${linksAffected} customer link(s) recycled\n\nFuture alerts for these accounts are now suppressed.`);
  res.json({ success:true, removed: banned.length, linksAffected });
});

app.delete('/api/admin/accounts/:email', adminAuth, (req, res) => {
  const accounts = loadAccounts();
  const target = decodeURIComponent(req.params.email).trim().toLowerCase();
  const links = loadLinks();
  const now = Date.now();
  const activeCount = Object.values(links).filter(l => l.email === target && l.active && l.expiresAt > now).length;

  const filtered = accounts.filter(a => a.email.trim().toLowerCase() !== target);
  if (filtered.length === accounts.length) return res.status(404).json({ success:false, error:'Account not found' });
  saveAccounts(filtered);

  // Also deactivate every customer link tied to this account so /c/token stops working
  // (previously links stayed live after the account was deleted). We move them to the
  // Recycle Bin (recycled) rather than hard-deleting, so it can be undone if needed.
  let linksAffected = 0;
  for (const token of Object.keys(links)) {
    if (links[token].email && links[token].email.trim().toLowerCase() === target) {
      links[token].active = false;
      links[token].released = true;
      links[token].recycled = true;
      links[token].recycledAt = now;
      links[token].recycledReason = 'account_deleted';
      linksAffected++;
    }
  }
  if (linksAffected > 0) saveLinks(links);
  try { cache.clear(); } catch(e) {}

  // Stop any further "account banned/issue" Telegram alerts for this email. The
  // detector dedups on email+timestamp, so pre-seed a permanent suppress marker.
  deletedAccountEmails.add(target);
  persistDeletedEmails();

  res.json({ success:true, removed: accounts.length - filtered.length, activeCustomersAffected: activeCount, linksAffected });
});

app.post('/api/admin/accounts/:email/plan', adminAuth, (req, res) => {
  const accounts = loadAccounts();
  const idx = accounts.findIndex(a => a.email === decodeURIComponent(req.params.email));
  if (idx === -1) return res.status(404).json({ success:false, error:'Not found' });
  if (req.body.planDays !== undefined) accounts[idx].planDays = req.body.planDays ? parseInt(req.body.planDays) : null;
  if (req.body.expiresAt !== undefined) accounts[idx].expiresAt = req.body.expiresAt || null;
  saveAccounts(accounts);
  res.json({ success:true, planDays: accounts[idx].planDays, expiresAt: accounts[idx].expiresAt });
});

app.post('/api/admin/accounts/:email/toggle', adminAuth, (req, res) => {
  const accounts = loadAccounts();
  const idx = accounts.findIndex(a => a.email === decodeURIComponent(req.params.email));
  if (idx === -1) return res.status(404).json({ success:false, error:'Not found' });
  accounts[idx].active = !accounts[idx].active;
  saveAccounts(accounts);
  res.json({ success:true, active: accounts[idx].active });
});

app.get('/api/admin/settings', adminAuth, (req, res) => {
  res.json({ success:true, settings: loadSettings() });
});

app.post('/api/admin/settings', adminAuth, (req, res) => {
  const current = loadSettings();
  const updated = { ...current, ...req.body };
  saveSettings(updated);
  res.json({ success:true, settings: updated });
});

// ── AUTO CREATE LINK — accepts secret in header OR body ──────────────
// Streaming product auto-delivery - called by EPS bot when a Prime/HBO/Disney+/ChatGPT order matches payment
app.post('/api/streaming/auto-create', async (req, res) => {
  try {
    const authToken = req.headers['x-admin-token'] || req.body.secret;
    if (authToken !== ADMIN_PASS) return res.status(401).json({ error:'Unauthorized' });
    const { type, phone, customerName, days, product, amount, orderName } = req.body;
    if (!STREAMING_PRODUCTS[type]) return res.status(400).json({ success:false, error:'Unknown product type' });
    if (!phone) return res.status(400).json({ success:false, error:'Phone required' });

    const d = normalizeDays(days);
    const now = Date.now();
    const links = loadStreamingLinks(type);
    const phoneNorm = phone.replace(/\D/g,'');

    // Renewal check - if existing active link found, extend it
    const existingActive = Object.values(links).filter(l =>
      l.phone && l.phone.replace(/\D/g,'') === phoneNorm && l.active && !l.released
    );
    if (existingActive.length > 0) {
      for (const el of existingActive) {
        links[el.token].expiresAt += d * 24 * 60 * 60 * 1000;
        links[el.token].renewalSmsSent = false;
        links[el.token].renewalCount = (links[el.token].renewalCount||0) + 1;
      }
      saveStreamingLinks(type, links);
      const first = existingActive[0];
      sendUniversalAccountDelivery(phone, customerName, STREAMING_PRODUCTS[type].name, first.email, first.password, first.profile, first.pin).then(sent => {
        sendTelegram(sent
          ? `🔄 <b>Renewed + Re-Delivered (${type.toUpperCase()})!</b>\n👤 ${customerName||'Customer'} | 📱 ${phone}\n⏳ Extended +${d} days`
          : `🔄 <b>Renewed (${type.toUpperCase()}) — WhatsApp Failed!</b>\n👤 ${customerName||'Customer'} | 📱 ${phone}\n❗ Please message manually.`);
      });
      return res.json({ success:true, renewed:true });
    }

    // New customer - try to assign a slot
    const slot = getNextAvailableStreamingSlot(type, d);
    if (!slot) {
      // Stock full - add to waitlist (tagged with productType so approve assigns from the right pool)
      const waitlist = loadWaitlist();
      const phoneNorm2 = phone.replace(/\D/g,'');
      if (!waitlist.find(w => w.phone && w.phone.replace(/\D/g,'') === phoneNorm2 && w.productType === type)) {
        waitlist.push({ phone, customerName: customerName||'', days: d, product: product||STREAMING_PRODUCTS[type].name, orderName: orderName||'', amount: amount||0, productType: type, addedAt: Date.now() });
        saveWaitlist(waitlist);
      }
      sendTelegram(`🔔 <b>New ${STREAMING_PRODUCTS[type].name} Order — Waitlisted</b>\n\n👤 ${customerName||'Customer'} | 📱 ${phone}\n📦 ${product} | ${d} days\n💰 ৳${amount}\n\n<b>Stock full — added to Waitlist. Add more ${STREAMING_PRODUCTS[type].name} accounts, then approve.</b>`);
      return res.json({ success:true, waitlisted:true, reason:'no_slot' });
    }

    const token = generateStreamingToken(type);
    links[token] = {
      token, accountId: slot.accountId, email: slot.email, password: slot.password,
      profile: slot.profile, pin: slot.pin, phone, customerName: customerName||'',
      plan: product||STREAMING_PRODUCTS[type].name, amount: amount||0, orderName: orderName||'',
      days: d, createdAt: now, expiresAt: now + d*24*60*60*1000,
      uses: 0, lastUsed: null, active: true, released: false, renewalSmsSent: false, renewalCount: 0,
    };
    saveStreamingLinks(type, links);

    // Send WhatsApp delivery, fallback to Telegram alert if it fails
    const sent = await sendUniversalAccountDelivery(phone, customerName, STREAMING_PRODUCTS[type].name, slot.email, slot.password, slot.profile, slot.pin);
    if (!sent) {
      // WhatsApp failed - undo slot assignment, alert admin.
      // (On success we stay silent here - EPS bot already sends the success Telegram message.)
      delete links[token];
      saveStreamingLinks(type, links);
      sendTelegram(`⚠️ <b>${type.toUpperCase()} Delivery Failed — Slot Released!</b>\n👤 ${customerName||'Customer'} | 📱 ${phone}\n📧 ${slot.email}\n👤 ${slot.profile||'N/A'}\n\n❗ WhatsApp delivery failed. Please deliver manually and re-assign from admin.`);
      return res.json({ success:false, error:'WhatsApp delivery failed, slot released' });
    }

    res.json({ success:true, token, delivered:true });
  } catch(e) {
    console.error('streaming auto-create error:', e.message);
    res.status(500).json({ success:false, error: e.message });
  }
});

app.post('/api/auto-create', async (req, res) => {
  try {
    const settings = loadSettings();
    if (!settings.autoLink) return res.status(403).json({ success:false, error:'Auto link is disabled' });
    const authToken = req.headers['x-admin-token'] || req.body.secret;
    if (authToken !== ADMIN_PASS) return res.status(401).json({ error:'Unauthorized' });
    const { phone, days, customerName } = req.body;
    if (!phone) return res.status(400).json({ error:'Phone required' });
    const d = normalizeDays(days);
    const product = req.body.product || 'Netflix';
    const amount = req.body.amount || 0;
    const orderName = req.body.orderName || '';
    const phoneNorm = phone.replace(/\D/g,'');
    const now = Date.now();

    // Renewal check - if they already have an unreleased link, just extend it
    const allLinks = loadLinks();
    const existingActive = Object.values(allLinks).filter(l =>
      l.phone && l.phone.replace(/\D/g,'') === phoneNorm && l.active && !l.released
    );
    if (existingActive.length > 0) {
      for (const el of existingActive) renewCustomerLink(allLinks, el.token, d);
      saveLinks(allLinks);
      const first = existingActive[0];
      const dashLink = `${SITE_URL}/c/${first.token}`;
      sendWhatsAppDelivery(phone, first.email, first.profile, dashLink, customerName).then(sent => {
        sendTelegram(sent
          ? `🔄 <b>Auto-Renewed + WhatsApp Sent!</b>\n👤 ${customerName||'Customer'} | 📱 ${phone}\n🔗 Extended +${d} days`
          : `🔄 <b>Auto-Renewed (WhatsApp Failed)!</b>\n👤 ${customerName||'Customer'} | 📱 ${phone}\n🔗 Extended +${d} days\n\n❗ Please message manually.`);
      });
      return res.json({ success:true, renewed:true, token:first.token });
    }

    // Third-party Netflix renewal check - if this customer is on a third-party account,
    // extend that instead of assigning them a new slot.
    const tpLinksAll = loadStreamingLinks('netflix3p');
    const tpExisting = Object.values(tpLinksAll).filter(l =>
      l.phone && l.phone.replace(/\D/g,'') === phoneNorm && l.active && !l.released
    );
    if (tpExisting.length > 0) {
      for (const el of tpExisting) {
        tpLinksAll[el.token].expiresAt += d * 24 * 60 * 60 * 1000;
        tpLinksAll[el.token].renewalSmsSent = false;
        tpLinksAll[el.token].renewalCount = (tpLinksAll[el.token].renewalCount||0) + 1;
      }
      saveStreamingLinks('netflix3p', tpLinksAll);
      const tf = tpExisting[0];
      sendUniversalAccountDelivery(phone, customerName, 'Netflix Account', tf.email, tf.password, tf.profile, tf.pin).then(sent => {
        sendTelegram(sent
          ? `🔄 <b>Auto-Renewed (Netflix 3rd-Party)!</b>\n👤 ${customerName||'Customer'} | 📱 ${phone}\n⏳ Extended +${d} days`
          : `🔄 <b>Renewed 3rd-Party (WhatsApp Failed)!</b>\n👤 ${customerName||'Customer'} | 📱 ${phone}\n⏳ +${d} days\n\n❗ Please message manually.`);
      });
      return res.json({ success:true, renewed:true, thirdParty:true });
    }

    // EPS bot already sent order_confirmation before calling this endpoint.
    // Wait 20s before attempting delivery, spacing the two WhatsApp messages out.
    await new Promise(r => setTimeout(r, 20000));

    // New customer - try to assign a real slot immediately instead of always waitlisting
    const slot = getNextAvailableSlot(d, detectDeviceType(product));
    if (!slot) {
      // Own Netflix stock is full - try third-party Netflix pool as a fallback before waitlisting.
      // Third-party accounts have no inbox access, so they're delivered as fixed credentials
      // via WhatsApp (no dashboard), same as Prime/HBO/etc.
      const tpSlot = getNextAvailableStreamingSlot('netflix3p', d);
      if (tpSlot) {
        const tpLinks = loadStreamingLinks('netflix3p');
        const tpToken = generateStreamingToken('netflix3p');
        tpLinks[tpToken] = {
          token: tpToken, accountId: tpSlot.accountId, email: tpSlot.email, password: tpSlot.password,
          profile: tpSlot.profile, pin: tpSlot.pin, phone, customerName: customerName||'',
          plan: 'Netflix Account', amount: amount||0, orderName: orderName||'',
          days: d, createdAt: now, expiresAt: now + d*24*60*60*1000,
          uses: 0, lastUsed: null, active: true, released: false, renewalSmsSent: false, renewalCount: 0,
        };
        saveStreamingLinks('netflix3p', tpLinks);
        res.json({ success:true, token: tpToken, delivered: 'pending', thirdParty: true });
        const sent = await sendUniversalAccountDelivery(phone, customerName, 'Netflix Account', tpSlot.email, tpSlot.password, tpSlot.profile, tpSlot.pin);
        if (sent) {
          sendTelegram(`✅ <b>Auto-Delivered (Netflix 3rd-Party)!</b>\n👤 ${customerName||'Customer'} | 📱 ${phone}\n📧 ${tpSlot.email}\n👤 ${tpSlot.profile} | PIN: ${tpSlot.pin}\n⏳ ${d} days\n\n📲 Own stock was full — delivered from third-party pool`);
        } else {
          // WhatsApp failed - undo the third-party slot, then waitlist
          const undoLinks = loadStreamingLinks('netflix3p');
          delete undoLinks[tpToken];
          saveStreamingLinks('netflix3p', undoLinks);
          const wl = loadWaitlist();
          if (!wl.find(w => w.phone && w.phone.replace(/\D/g,'') === phoneNorm)) {
            wl.push({ phone, customerName: customerName||'', days: d, product, orderName, amount, addedAt: Date.now() });
            saveWaitlist(wl);
          }
          sendTelegram(`⚠️ <b>Netflix 3rd-Party Delivery Failed — Waitlisted!</b>\n👤 ${customerName||'Customer'} | 📱 ${phone}\n\nWhatsApp failed. Slot released, customer waitlisted. Approve manually when ready.`);
        }
        return;
      }

      // Both own AND third-party stock full - waitlist
      const waitlist = loadWaitlist();
      const alreadyWaiting = waitlist.find(w => w.phone && w.phone.replace(/\D/g,'') === phoneNorm);
      if (!alreadyWaiting) {
        waitlist.push({ phone, customerName: customerName||'', days: d, product, orderName, amount, addedAt: now });
        saveWaitlist(waitlist);
      }
      sendTelegram(
        `🔔 <b>New Order — No Slot Available</b>\n\n` +
        `👤 ${customerName||'Customer'} | 📱 ${phone}\n` +
        `📦 ${product} | ${d} days\n` +
        `💰 ৳${amount}\n` +
        `🛒 ${orderName}\n\n` +
        `<b>Own + 3rd-party both full. Admin → Waitlist to approve when a slot frees up</b>`
      );
      return res.json({ success:true, waitlisted:true });
    }

    const token = generateToken();
    allLinks[token] = { token, email:slot.email, profile:slot.profile, pin:slot.pin, phone, customerName:customerName||'', plan:product, amount, orderName, renewalCount:0, days:d, createdAt:now, expiresAt:now+d*24*60*60*1000, uses:0, lastUsed:null, active:true, warningSent:false };
    saveLinks(allLinks);
    checkLowStock();

    const dashLink = `${SITE_URL}/c/${token}`;
    res.json({ success:true, token, delivered: 'pending' });
    sendWhatsAppDelivery(phone, slot.email, slot.profile, dashLink, customerName).then(sent => {
      if (sent) {
        sendTelegram(`✅ <b>Auto-Delivered via WhatsApp!</b>\n👤 ${customerName||'Customer'} | 📱 ${phone}\n👤 ${slot.profile} | PIN: ${slot.pin}\n🔗 ${dashLink}\n⏳ ${d} days\n\n📲 Sent automatically — no action needed`);
      } else {
        // WhatsApp failed even after retries - undo the slot assignment and put in waitlist
        const currentLinks = loadLinks();
        delete currentLinks[token];
        saveLinks(currentLinks);
        const currentWaitlist = loadWaitlist();
        if (!currentWaitlist.find(x => x.phone === phone)) {
          currentWaitlist.push({ phone, customerName: customerName||'', days: d, product, orderName, amount, addedAt: Date.now() });
          saveWaitlist(currentWaitlist);
        }
        sendTelegram(`⚠️ <b>WhatsApp Failed — Back in Waitlist!</b>\n👤 ${customerName||'Customer'} | 📱 ${phone}\n\nSlot released, customer moved back to Waitlist. Approve manually when ready.`);
      }
    });
  } catch(e) {
    console.error('Auto create error:', e.message);
    res.status(500).json({ success:false, error: e.message });
  }
});


// Phone lookup API for /track page
app.get('/api/track/:phone', (req, res) => {
  const phone = req.params.phone.replace(/\D/g,'');
  if (!phone || phone.length < 7) return res.status(400).json({ success:false, error:'Invalid phone' });
  const links = loadLinks();
  const now = Date.now();
  const found = Object.values(links).filter(l =>
    l.phone && l.phone.replace(/\D/g,'').includes(phone) && l.active && !l.released && l.expiresAt > now
  );
  if (found.length) {
    return res.json({ success:true, links: found.map(l => ({
      token: l.token,
      profile: l.profile,
      pin: l.pin,
      daysLeft: Math.ceil((l.expiresAt-now)/(24*60*60*1000)),
      link: SITE_URL+'/c/'+l.token
    }))});
  }
  // No active links — check if they have a BLOCKED link so we can explain why,
  // instead of a blank "no account found" that leaves the customer confused.
  const blocked = Object.values(links).filter(l =>
    l.phone && l.phone.replace(/\D/g,'').includes(phone) && !l.active && !l.released
  );
  if (blocked.length) {
    const b = blocked[0];
    return res.status(403).json({
      success:false,
      error:'blocked',
      message: getRevokeReasonText(b),
      reason: b.revokedReason || null,
      country: b.revokedCountry || null,
      ip: b.revokedIp || null,
      token: b.token,
    });
  }
  return res.status(404).json({ success:false, error:'not_found', message:'No account found for this number' });
});

app.get('/track', (req, res) => res.sendFile(path.join(__dirname,'public','track.html')));
app.get('/c/:token', (req, res) => res.sendFile(path.join(__dirname,'public','customer.html')));

app.get('*', (req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    res.send(applyBrand(html, getBrand(req.hostname)));
  } catch(e) { res.sendFile(path.join(__dirname,'public','index.html')); }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

ensureDataDir();
app.listen(PORT, () => {
  console.log(`FanFlix running on port ${PORT}`);
  try { sendTelegram('<b>FanFlix Started</b>\nType /help for commands'); } catch(e) { console.error('TG startup error:', e.message); }
  // Start persistent IMAP poller after 3 seconds
  setTimeout(() => startIMAPPoller(), 3000);
});
