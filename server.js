const express = require('express');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

// ── EMAIL CODE CACHE + PERSISTENT IMAP POLLER ───────────────────────────────
const emailCodeCache = new Map(); // email → { codes: [], fetchedAt: timestamp }
const alertedSignins = new Set(); // dedup outside-BD login alerts (ts+email)
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
app.use(express.static(path.join(__dirname, 'public')));

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
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
const LOGIN_VIDEO = process.env.LOGIN_VIDEO || 'https://youtu.be/PLACEHOLDER1';
const HOUSEHOLD_VIDEO = process.env.HOUSEHOLD_VIDEO || 'https://youtu.be/PLACEHOLDER2';
const SITE_URL = process.env.SITE_URL || 'https://household.fanflixbd.com';
const UDDOKTAPAY_API_KEY = process.env.UDDOKTAPAY_API_KEY || 'WCHHkn251WojpUh2zKc8UKSVe5UXCRR0sOLkS6tL';
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
const MAX_SLOTS = 8;
const BLOCKED_CODES = ['2023','2024','2025','2026','2027','2028','0000'];

const FIXED_PROFILES = [
  { profile: 'Profile A', pin: '5651', slots: 2 },
  { profile: 'Profile B', pin: '5652', slots: 2 },
  { profile: 'Profile C', pin: '5653', slots: 2 },
  { profile: 'Profile D', pin: '5654', slots: 1 },
  { profile: 'Profile E', pin: '5655', slots: 1 },
];

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
    for (const prof of FIXED_PROFILES) {
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
    if (geo.countryCode && geo.countryCode !== 'BD') {
      const geoData = loadGeo();
      if (!geoData[token]) geoData[token] = [];
      const already = geoData[token].find(g => g.ip === ip);
      if (!already) {
        geoData[token].push({ ip, country: geo.country, code: geo.countryCode });
        saveGeo(geoData);
      }
      const links = loadLinks();
      const link = links[token];

      // Instant auto-block - customer can be reactivated later from admin if it was a mistake
      if (link && link.active) {
        link.active = false;
        link.revokedReason = 'outside_bd';
        link.revokedCountry = geo.country;
        link.revokedIp = ip;
        link.revokedAt = Date.now();
        saveLinks(links);
      }

      sendTelegram(`🚨 <b>Outside BD Login — Auto-Blocked!</b>\n\n🔗 /c/${token}\n📧 ${link?.email||'unknown'}\n👤 ${link?.profile||'unknown'}\n📱 ${link?.phone||'unknown'}\n📍 ${geo.country} (${geo.countryCode})\n🌐 IP: ${ip}\n\n⛔ Dashboard access blocked instantly. Reactivate from admin if this is a mistake.`);
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
          ts: Date.now(),
        });
        saveNetflixAlerts(alerts.slice(0, 100));
      } catch(e) { console.error('Save dashboard alert error:', e.message); }
    }
  } catch(e) { console.error('Geo lookup error:', e.message); }
}

function getNextAvailableSlot(customerDays) {
  const accounts = loadAccounts();
  const links = loadLinks();
  const days = normalizeDays(customerDays);

  function tryAccounts(accountList) {
    for (const account of accountList) {
      const email = account.email;
      // Occupied = link exists and NOT released (regardless of expiry)
      const occupyingLinks = Object.values(links).filter(l => l.email===email && l.active && !l.released);
      const usedProfiles = occupyingLinks.map(l => normalizeProfile(l.profile));
      for (const prof of FIXED_PROFILES) {
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
  const expiring3 = Object.values(links).filter(l => l.active && l.expiresAt>now && (l.expiresAt-now)<=threeDays);
  const expiring7 = Object.values(links).filter(l => l.active && l.expiresAt>now && (l.expiresAt-now)>threeDays && (l.expiresAt-now)<=sevenDays);
  const active = Object.values(links).filter(l => l.active && l.expiresAt>now);
  const expired = Object.values(links).filter(l => l.expiresAt<=now);
  let msg = `<b>FanFlix Morning Report</b>\n📅 ${new Date().toLocaleDateString('en-BD',{timeZone:'Asia/Dhaka',weekday:'long',year:'numeric',month:'long',day:'numeric'})}\n\n`;
  msg += `Active: ${active.length} | Expiring 3d: ${expiring3.length} | Expiring 7d: ${expiring7.length} | Expired: ${expired.length}\n\n`;
  if (expiring3.length > 0) {
    msg += `<b>Expiring in 3 days — Renew now:</b>\n`;
    for (const l of expiring3) {
      const days = Math.ceil((l.expiresAt-now)/(24*60*60*1000));
      msg += `• ${l.profile} | ${l.email}\n  ${days}d | /renew ${l.token} 30\n`;
    }
    msg += '\n';
  }
  if (expiring7.length > 0) {
    msg += `<b>Expiring in 7 days:</b>\n`;
    for (const l of expiring7) {
      const days = Math.ceil((l.expiresAt-now)/(24*60*60*1000));
      msg += `• ${l.profile} | ${l.email} | ${days}d\n`;
    }
  }
  if (expiring3.length === 0 && expiring7.length === 0) msg += `All links are healthy!`;
  sendTelegram(msg);
}

// BulkSMS - 1-click self-renew reminder
const BULKSMS_API_KEY = process.env.BULKSMS_API_KEY || 'vQVe9pjP7d34mdiGFWQj';
const BULKSMS_SENDER  = process.env.BULKSMS_SENDER  || '8809617621396';
async function sendBulkSMS(phone, message) {
  try {
    const num = String(phone).replace(/\D/g,'');
    if (!num || num.length < 7) return false;
    const url = `http://bulksmsbd.net/api/smsapi?api_key=${BULKSMS_API_KEY}&type=text&number=${num}&senderid=${BULKSMS_SENDER}&message=${encodeURIComponent(message)}`;
    const res = await fetch(url);
    const result = await res.text();
    console.log('SMS sent to', num, ':', result);
    return true;
  } catch(e) { console.error('SMS error:', e.message); return false; }
}

function checkExpiringLinks() {
  const links = loadLinks();
  const now = Date.now();
  const threeDays = 3*24*60*60*1000;
  let changed = false;
  for (const link of Object.values(links)) {
    if (!link.active) continue;
    const remaining = link.expiresAt - now;
    // Telegram 3 days before
    if (remaining > 0 && remaining <= threeDays && !link.warningSent) {
      const days = Math.ceil(remaining/(24*60*60*1000));
      sendTelegram(`<b>Link Expiring Soon!</b>\n\n📧 ${link.email}\n👤 ${link.profile}\n⏳ <b>${days} day(s) left</b>\n🔗 ${SITE_URL}/c/${link.token}\n\n/renew ${link.token} 30`);
      links[link.token].warningSent = true;
      changed = true;
    }
  }
  if (changed) saveLinks(links);
}
setInterval(checkExpiringLinks, 60*60*1000);

// SMS reminder - once daily at 9:30 PM BD time, for links expiring within the next 24h
async function sendRenewalSmsReminders() {
  const links = loadLinks();
  const now = Date.now();
  const oneDay = 24*60*60*1000;
  let changed = false;
  for (const link of Object.values(links)) {
    if (!link.active || link.released) continue;
    const remaining = link.expiresAt - now;
    if (remaining > 0 && remaining <= oneDay && !link.renewalSmsSent) {
      if (link.phone) {
        const msg = `প্রিয় গ্রাহক, আপনার Netflix সাবস্ক্রিপশনের মেয়াদ আগামীকাল শেষ হবে। মাত্র ১ ক্লিকে রিনিউ করুন, সাপোর্টে যোগাযোগের প্রয়োজন নেই: ${SITE_URL}/c/${link.token}`;
        await sendBulkSMS(link.phone, msg);
      }
      link.renewalSmsSent = true;
      changed = true;
    }
  }
  if (changed) saveLinks(links);
}
function scheduleRenewalSms() {
  const now = new Date();
  const bd = new Date(now.getTime() + 6*60*60*1000);
  const next930pm = new Date(bd);
  next930pm.setUTCHours(15, 30, 0, 0); // 21:30 BD = 15:30 UTC
  if (bd.getUTCHours() > 15 || (bd.getUTCHours() === 15 && bd.getUTCMinutes() >= 30)) {
    next930pm.setUTCDate(next930pm.getUTCDate() + 1);
  }
  const msUntil = next930pm.getTime() - now.getTime();
  setTimeout(() => {
    sendRenewalSmsReminders();
    setInterval(sendRenewalSmsReminders, 24*60*60*1000);
  }, msUntil);
}
try { scheduleRenewalSms(); } catch(e) { console.error('Renewal SMS schedule error:', e.message); }

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
    const imap = new Imap({
      user: GMAIL_USER, password: GMAIL_PASS,
      host: 'imap.gmail.com', port: 993, tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 5000, authTimeout: 4000
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
    // PIN change detection
  const isPinChange = sl.includes('pin for profile') || sl.includes('new pin for') || sl.includes('pin has changed');
  if (isPinChange) {
    const pinAlertKey = toEmail + '_' + ts;
    if (!alertedPinChanges.has(pinAlertKey)) {
      alertedPinChanges.add(pinAlertKey);
      // Extract profile letter e.g. 'The PIN for profile C has changed'
      const profileMatch = sl.match(/profile\s+([a-e])/i) || bodyPlain.match(/Profile\s*[:\n]+\s*([A-E])/i);
      const profileLetter = profileMatch ? profileMatch[1].toUpperCase() : null;
      // Extract new PIN - shown as spaced digits '5 6 5 3'
      const pinMatch = bodyPlain.match(/Profile Lock PIN[^0-9]*(\d)\s+(\d)\s+(\d)\s+(\d)/i)
        || bodyPlain.match(/new PIN[^0-9]*(\d)\s+(\d)\s+(\d)\s+(\d)/i);
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
        sendTelegram(`🔑 <b>PIN Changed!</b>\n\n📧 ${toEmail}\nCould not auto-detect profile/PIN. Check manually.`);
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
    const existing = Object.values(links).filter(l => l.email===email && l.active && l.expiresAt>now);
    if (existing.length >= MAX_SLOTS) return sendTelegram(`❌ Account Full! ${email} has ${MAX_SLOTS}/${MAX_SLOTS} active links.\nUse /list ${email}`, chatId);
    const created = [];
    for (const prof of FIXED_PROFILES) {
      for (let i=0; i<prof.slots; i++) {
        const token = generateToken();
        links[token] = { token, email, profile:prof.profile, pin:prof.pin, days, createdAt:now, expiresAt:now+days*24*60*60*1000, uses:0, lastUsed:null, active:true, warningSent:false };
        created.push({ token, profile:prof.profile, pin:prof.pin, link:`${SITE_URL}/c/${token}` });
      }
    }
    saveLinks(links);
    let msg2 = `✅ <b>8 Links Created!</b>\n📧 ${email}\n⏳ ${days} days\n\n`;
    let lastProf = '';
    for (const l of created) {
      if (l.profile !== lastProf) { msg2 += `\n👤 <b>${l.profile}</b> | PIN: <code>${l.pin}</code>\n`; lastProf = l.profile; }
      msg2 += `🔗 <code>${l.link}</code>\n`;
    }
    msg2 += `\n━━━━━━━━━━━━━━━━━━\n📋 <b>Template:</b>\n\n` + buildCustomerMessage(email,'[PROFILE]','[PIN]','[LINK]',days);
    return sendTelegram(msg2, chatId);
  }

  if (text.startsWith('/replaceall')) {
    const parts = text.replace('/replaceall','').trim().split(' ');
    if (parts.length < 2) return sendTelegram('❌ Format: /replaceall oldemail newemail', chatId);
    const [oldEmail, newEmail] = parts;
    const links = loadLinks();
    let count = 0;
    for (const token of Object.keys(links)) {
      if (links[token].email === oldEmail.toLowerCase()) { links[token].email = newEmail.toLowerCase(); count++; }
    }
    if (count === 0) return sendTelegram(`❌ No links found for ${oldEmail}`, chatId);
    saveLinks(links);
    cache.delete(oldEmail.toLowerCase());
    cache.delete(newEmail.toLowerCase());
    return sendTelegram(`✅ <b>Account Replaced!</b>\n\n📧 Old: ${oldEmail}\n📧 New: ${newEmail}\n🔗 ${count} links updated\n\nAll customer links now fetch from new account!`, chatId);
  }

  if (text.startsWith('/replace')) {
    const parts = text.replace('/replace','').trim().split(' ');
    if (parts.length < 2) return sendTelegram('❌ Format: /replace TOKEN newemail@gmail.com', chatId);
    const [token, newEmail] = parts;
    const links = loadLinks();
    if (!links[token]) return sendTelegram('❌ Link not found: '+token, chatId);
    const oldEmail = links[token].email;
    links[token].email = newEmail.toLowerCase();
    saveLinks(links);
    cache.delete(oldEmail); cache.delete(newEmail.toLowerCase());
    return sendTelegram(`✅ <b>Link Updated!</b>\n\n🔗 /c/${token}\n👤 ${links[token].profile}\n📧 Old: ${oldEmail}\n📧 New: ${newEmail}`, chatId);
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
    const byEmail = {};
    for (const l of Object.values(links)) {
      if (!byEmail[l.email]) byEmail[l.email] = { active:0, total:0 };
      byEmail[l.email].total++;
      if (l.active && l.expiresAt>now) byEmail[l.email].active++;
    }
    let msg2 = '📊 <b>Slot Usage</b>\n\n';
    for (const [email, info] of Object.entries(byEmail)) {
      const bar = '█'.repeat(info.active)+'░'.repeat(Math.max(0,MAX_SLOTS-info.active));
      msg2 += `📧 ${email}\n${bar} ${info.active}/${MAX_SLOTS}\n\n`;
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
      `<b>Replace Account:</b>\n/replace TOKEN newemail\n/replaceall oldemail newemail\n\n` +
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
  const existing = Object.values(links).find(l => l.email===email.toLowerCase()&&normalizeProfile(l.profile)===normalizedProfile&&l.active&&l.expiresAt>now);
  if (existing) return res.json({ success:true, token:existing.token, link:`/c/${existing.token}`, existing:true });
  const activeCount = Object.values(links).filter(l => l.email===email.toLowerCase()&&l.active&&l.expiresAt>now).length;
  if (activeCount >= MAX_SLOTS) return res.status(400).json({ error:`Account full (${MAX_SLOTS}/${MAX_SLOTS})` });
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

app.post('/api/admin/replace/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  const { newEmail } = req.body;
  if (!newEmail) return res.status(400).json({ error:'Missing newEmail' });
  const oldEmail = links[req.params.token].email;
  links[req.params.token].email = newEmail.toLowerCase().trim();
  saveLinks(links);
  cache.clear();
  res.json({ success:true, oldEmail, newEmail });
});

app.post('/api/admin/replaceall', adminAuth, (req, res) => {
  const { oldEmail, newEmail } = req.body;
  if (!oldEmail||!newEmail) return res.status(400).json({ error:'Missing fields' });
  const links = loadLinks();
  let count = 0;
  for (const token of Object.keys(links)) {
    if (links[token].email === oldEmail.toLowerCase()) { links[token].email = newEmail.toLowerCase(); count++; }
  }
  saveLinks(links);
  cache.clear();
  res.json({ success:true, count });
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
  delete links[req.params.token]; saveLinks(links); res.json({ success:true });
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
    // Check cache — poller keeps this fresh every 15s
    const cached = getCodesFromCache(link.email);
    if (cached !== null && cached.length > 0) {
      totalToday += 1;
      return res.json({ success:true, codes:cached, count:cached.length, profile:link.profile, pin:link.pin, email:link.email, daysLeft, totalDays, ipCount, uses:link.uses });
    }
    // Cache empty or miss — return fetching:true, poller will update within 15s
    // Also trigger immediate poll to get codes faster
    if (_imapReady && !_imapPolling) _pollAll().catch(()=>{});
    res.json({ success:true, codes:[], count:0, profile:link.profile, pin:link.pin, email:link.email, daysLeft, totalDays, ipCount, uses:link.uses, fetching:true });
  } catch(err) {
    res.json({ success:true, codes:[], count:0, profile:link.profile, pin:link.pin, email:link.email, daysLeft, totalDays, ipCount, uses:link.uses });
  }
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

    for (const link of Object.values(links)) {
      const amount = parseFloat(link.amount) || 0;
      if (!amount || !link.createdAt) continue;
      const createdStr = new Date(link.createdAt).toISOString().split('T')[0];
      allTimeTotal += amount; allTimeCount++;
      if (createdStr === todayStr) { todayTotal += amount; todayCount++; }
      if (createdStr.slice(0,7) === monthStr) { monthTotal += amount; monthCount++; }
      const prod = link.plan || 'Unknown';
      if (!byProduct[prod]) byProduct[prod] = { total: 0, count: 0 };
      byProduct[prod].total += amount;
      byProduct[prod].count++;
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

    // Build 8-slot occupancy view (one row per physical slot instance)
    const usedTokens = new Set();
    const slots = [];
    for (const prof of FIXED_PROFILES) {
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

    res.json({ success:true, email, slots, allLinks: accountLinks });
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

    // New customer — get slot
    const slot = getNextAvailableSlot(d);
    if (!slot) return res.status(503).json({ success:false, error:'No slots available for ' + d + ' day plan' });

    const token = generateToken();
    allLinks[token] = { token, email:slot.email, profile:slot.profile, pin:slot.pin, phone, customerName:w.customerName||'', plan:w.product||'', amount:w.amount||0, orderName:w.orderName||'', renewalCount:0, days:d, createdAt:now, expiresAt:now+d*24*60*60*1000, uses:0, lastUsed:null, active:true, warningSent:false };
    saveLinks(allLinks);
    waitlist.splice(idx, 1);
    saveWaitlist(waitlist);
    checkLowStock();
    sendTelegram(`✅ <b>Link Approved!</b>\n👤 ${w.customerName||'Customer'} | 📱 ${phone}\n👤 ${slot.profile} | PIN: ${slot.pin}\n🔗 ${SITE_URL}/c/${token}\n⏳ ${d} days`);
    res.json({ success:true, token, link:SITE_URL+'/c/'+token, profile:slot.profile, pin:slot.pin });
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
      const totalSlots = FIXED_PROFILES.reduce((sum,p) => sum+p.slots, 0);
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
    const slot = getNextAvailableSlot(w.days || 30);
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
        redirect_url: `${SITE_URL}/c/${token}?renewed=1&plan=${encodeURIComponent(matchedPlan.name)}&days=${days}`,
        return_type: 'GET',
        cancel_url: `${SITE_URL}/c/${token}?renew_cancelled=1`,
        webhook_url: `${SITE_URL}/uddoktapay-ipn`,
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

    // New customer
    const slot = getNextAvailableSlot(days);
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

    sendTelegram(
      `🔗 <b>Link Created — UddoktaPay!</b>
` +
      `👤 ${customerName} | 📱 ${sender_number}
` +
      `👤 ${slot.profile} | PIN: ${slot.pin}
` +
      `🔗 ${SITE_URL}/c/${token}
` +
      `⏳ ${days} days`
    );

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
  // Clear cache and trigger immediate poll
  clearEmailCache(link.email);
  try {
    if (_imapReady && !_imapPolling) await _pollAll();
    else await fetchNetflixEmailsFresh(link.email, true).then(codes => setCodesInCache(link.email, codes));
    const codes = getCodesFromCache(link.email) || [];
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

app.get('/api/codes', async (req, res) => {
  const email = (req.query.email||'').trim();
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  trackVisitor(ip); resetDailyIfNeeded();
  if (isRateLimited(ip)) return res.status(429).json({ success:false, error:'Too many requests. Wait 5 minutes.' });
  const cached = getCached(email);
  if (cached) return res.json({ success:true, codes:cached, count:cached.length, cached:true, fetchTime:0 });
  const start = Date.now();
  try {
    const bgCached = getCodesFromCache(email);
    if (bgCached !== null) {
      const fetchTime = '0.0';
      return res.json({ success:true, codes:bgCached, count:bgCached.length, fetchTime, cached:true });
    }
    const codes = await fetchNetflixEmailsFresh(email, false);
    const fetchTime = ((Date.now()-start)/1000).toFixed(1);
    setCodesInCache(email, codes);
    setCache(email, codes);
    if (codes.length > 0) totalToday += 1;
    res.json({ success:true, codes, count:codes.length, fetchTime });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/admin-manifest.json', (req, res) => res.sendFile(path.join(__dirname,'public','admin-manifest.json')));
app.get('/admin-sw.js', (req, res) => res.sendFile(path.join(__dirname,'public','admin-sw.js')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname,'public','admin.html')));

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
    return { ...a, slotsUsed: occupying.length, slotsTotal: 8, pendingRelease, activeDaysLeft, planDays: a.planDays||null, expiresAt: a.expiresAt||null };
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

      return {
        email: a.email,
        active: a.active !== false,
        everCount,
        outsideBdCount,
        pinChangeCount,
        nonRenewalRate,
        riskScore,
      };
    }).sort((a,b) => b.riskScore - a.riskScore);

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
  accounts.push({ email:email.toLowerCase().trim(), notes:notes||'', priority:priority||accounts.length+1, active:true, addedAt:Date.now(), planDays, expiresAt });
  saveAccounts(accounts);
  res.json({ success:true });
});

app.delete('/api/admin/accounts/:email', adminAuth, (req, res) => {
  const accounts = loadAccounts();
  const target = decodeURIComponent(req.params.email).trim().toLowerCase();
  // Block delete if account has active customers
  const links = loadLinks();
  const now = Date.now();
  const hasActive = Object.values(links).some(l => l.email === target && l.active && l.expiresAt > now);
  if (hasActive) return res.status(400).json({ success:false, error:'Cannot delete — account has active customers. Revoke their links first.' });
  const filtered = accounts.filter(a => a.email.trim().toLowerCase() !== target);
  saveAccounts(filtered);
  res.json({ success:true, removed: accounts.length - filtered.length });
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
app.post('/api/auto-create', (req, res) => {
  try {
    const settings = loadSettings();
    if (!settings.autoLink) return res.status(403).json({ success:false, error:'Auto link is disabled' });
    const authToken = req.headers['x-admin-token'] || req.body.secret;
    if (authToken !== ADMIN_PASS) return res.status(401).json({ error:'Unauthorized' });
    const { phone, days, customerName } = req.body;
    if (!phone) return res.status(400).json({ error:'Phone required' });
    const d = normalizeDays(days);

    // autoLink=ON → always go to waitlist for manual approval
    const waitlist = loadWaitlist();
    const alreadyWaiting = waitlist.find(w => w.phone && w.phone.replace(/\D/g,'') === phone.replace(/\D/g,''));
    if (!alreadyWaiting) {
      waitlist.push({ phone, customerName: customerName||'', days: d, product: req.body.product||'Netflix', orderName: req.body.orderName||'', amount: req.body.amount||0, addedAt: Date.now() });
      saveWaitlist(waitlist);
    }
    sendTelegram(
      `🔔 <b>New Order — Pending Approval</b>\n\n` +
      `👤 ${customerName||'Customer'} | 📱 ${phone}\n` +
      `📦 ${req.body.product||'Netflix'} | ${d} days\n` +
      `💰 ৳${req.body.amount||0}\n` +
      `🛒 ${req.body.orderName||''}\n\n` +
      `<b>Admin → Waitlist to approve</b>`
    );
    return res.json({ success:true, waitlisted:true });
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

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
