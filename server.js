const express = require('express');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

// ── EMAIL CODE CACHE ─────────────────────────────────────────────────────────
const emailCodeCache = new Map(); // email → { codes: [], fetchedAt: timestamp }
const fetchingEmails = new Set(); // emails currently being IMAP fetched

function getCodesFromCache(email) {
  const entry = emailCodeCache.get(email.toLowerCase());
  if (!entry) return null;
  const age = Date.now() - entry.fetchedAt;
  // Short TTL for empty results (10s), long TTL for codes (2min)
  const ttl = entry.codes.length > 0 ? 120 * 1000 : 10 * 1000;
  if (age > ttl) { emailCodeCache.delete(email.toLowerCase()); return null; }
  return entry.codes;
}

function clearEmailCache(email) {
  emailCodeCache.delete(email.toLowerCase());
  fetchingEmails.delete(email.toLowerCase());
}

function setCodesInCache(email, codes) {
  emailCodeCache.set(email.toLowerCase(), { codes, fetchedAt: Date.now() });
}



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
  { id:'netflix-mobile-1m', name:'Netflix Mobile 1M', price:350, days:28, product:'Netflix Subscription' },
  { id:'netflix-tv-1m',     name:'Netflix TV 1M',     price:450, days:28, product:'Netflix TV Subscription' },
  { id:'netflix-tv-3m',     name:'Netflix TV 3M',     price:1350,days:85, product:'Netflix TV Subscription 3M' },
  { id:'combo-mobile-1m',   name:'Combo Mobile 1M',   price:389, days:28, product:'Netflix+Prime Mobile 1M' },
  { id:'combo-tv-1m',       name:'Combo TV 1M',       price:489, days:28, product:'Netflix+Prime TV 1M' },
  { id:'combo-tv-3m',       name:'Combo TV 3M',       price:1500,days:85, product:'Netflix+Prime TV 3M' },
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
const WAITLIST_FILE  = DATA_DIR + '/waitlist.json';
function loadWaitlist() { try { return JSON.parse(fs.readFileSync(WAITLIST_FILE,'utf8')); } catch(e) { return []; } }
function saveWaitlist(data) { ensureDataDir(); fs.writeFileSync(WAITLIST_FILE, JSON.stringify(data,null,2)); }

// Normalize customer days to match account plan types (28/85/170)
function normalizeDays(d) {
  const n = parseInt(d) || 28;
  if (n <= 30) return 28;
  if (n <= 90) return 85;
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
  const now = Date.now();
  let free = 0;
  for (const account of accounts.filter(a=>a.active)) {
    const activeLinks = Object.values(links).filter(l=>l.email===account.email&&l.active&&l.expiresAt>now);
    const usedProfiles = activeLinks.map(l=>normalizeProfile(l.profile));
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

async function trackIPGeo(token, ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1') return false;
  const data = loadIPs();
  if (!data[token]) data[token] = [];
  const isNew = !data[token].includes(ip);
  if (isNew) {
    data[token].push(ip);
    saveIPs(data);
    // Geo lookup
    try {
      const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=country,countryCode`);
      const geo = await geoRes.json();
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
        sendTelegram(`🌍 <b>Outside BD Access!</b>\n\n🔗 /c/${token}\n📧 ${link?.email||'unknown'}\n👤 ${link?.profile||'unknown'}\n📍 ${geo.country} (${geo.countryCode})\n🌐 IP: ${ip}`);
      }
    } catch(e) { console.error('Geo lookup error:', e.message); }
    if (data[token].length >= 4) {
      try {
        const links = loadLinks();
        const link = links[token];
        sendTelegram(`⚠️ <b>Suspicious Activity!</b>\n\n🔗 /c/${token}\n📧 ${link?.email||'unknown'}\n👤 ${link?.profile||'unknown'}\n<b>${data[token].length} different IPs detected!</b>\n\nIPs:\n${data[token].map(i=>`• ${i}`).join('\n')}`);
      } catch(e) { console.error('IP alert error:', e.message); }
    }
  }
  return data[token].length;
}

function trackIP(token, ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1') return false;
  const data = loadIPs();
  if (!data[token]) data[token] = [];
  const isNew = !data[token].includes(ip);
  if (isNew) {
    data[token].push(ip);
    saveIPs(data);
    if (data[token].length >= 4) {
      try {
      const links = loadLinks();
      const link = links[token];
      sendTelegram(
        `⚠️ <b>Suspicious Activity!</b>\n\n` +
        `🔗 /c/${token}\n📧 ${link?.email || 'unknown'}\n👤 ${link?.profile || 'unknown'}\n` +
        `<b>${data[token].length} different IPs detected!</b>\n\nIPs:\n${data[token].map(i => `• ${i}`).join('\n')}`
      );
      } catch(e) { console.error('IP alert error:', e.message); }
    }
  }
  return data[token].length;
}

function getNextAvailableSlot(customerDays) {
  const accounts = loadAccounts();
  const links = loadLinks();
  const now = Date.now();
  const days = normalizeDays(customerDays);

  function tryAccounts(accountList) {
    for (const account of accountList) {
      const email = account.email;
      const activeLinks = Object.values(links).filter(l => l.email===email && l.active && l.expiresAt>now);
      const usedProfiles = activeLinks.map(l => normalizeProfile(l.profile));
      for (const prof of FIXED_PROFILES) {
        const used = usedProfiles.filter(p => p === prof.profile).length;
        if (used < prof.slots) {
          return { email, profile: prof.profile, pin: prof.pin };
        }
      }
    }
    return null;
  }

  // First try: accounts matching customer plan
  const matched = [...accounts].filter(a => a.active && a.planDays && parseInt(a.planDays) === days)
    .sort((a,b) => (a.priority||99) - (b.priority||99));
  const result = tryAccounts(matched);
  if (result) return result;

  // Second try: accounts with no plan set (accept any)
  const anyPlan = [...accounts].filter(a => a.active && !a.planDays)
    .sort((a,b) => (a.priority||99) - (b.priority||99));
  return tryAccounts(anyPlan);
}


function generateToken() { return crypto.randomBytes(4).toString('hex'); }

let totalToday = 0, lastReset = new Date().toDateString();
const visitors = new Map();
function resetDailyIfNeeded() { const t = new Date().toDateString(); if (t !== lastReset) { totalToday = 0; lastReset = t; } }
function trackVisitor(ip) { visitors.set(ip, Date.now()); const c = Date.now()-5*60*1000; for(const[k,v] of visitors) if(v<c) visitors.delete(k); }
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
      msg += `• ${l.profile} | ${l.email}\n  ${days}d | /renew ${l.token} 28\n`;
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

function checkExpiringLinks() {
  const links = loadLinks();
  const now = Date.now(), threeDays = 3*24*60*60*1000;
  for (const link of Object.values(links)) {
    if (!link.active) continue;
    const remaining = link.expiresAt - now;
    if (remaining > 0 && remaining <= threeDays && !link.warningSent) {
      const days = Math.ceil(remaining/(24*60*60*1000));
      sendTelegram(`<b>Link Expiring Soon!</b>\n\n📧 ${link.email}\n👤 ${link.profile}\n⏳ <b>${days} day(s) left</b>\n🔗 ${SITE_URL}/c/${link.token}\n\n/renew ${link.token} 28`);
      links[link.token].warningSent = true;
      saveLinks(links);
    }
  }
}
setInterval(checkExpiringLinks, 60*60*1000);
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
      connTimeout: 8000, authTimeout: 6000
    });
    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) { imap.end(); return reject(err); }
        const since = new Date(Date.now() - 20*60*1000);
        imap.search([['SINCE', since], ['OR', ['FROM', 'netflix'], ['SUBJECT', 'netflix']]], (err, uids) => {
          if (err || !uids || uids.length === 0) { imap.end(); return resolve([]); }
          const fetch = imap.fetch(uids, { bodies: '' });
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
    if (!emailRaw||!emailRaw.includes('@')) return sendTelegram('❌ Format: /create email@gmail.com\nOptional: /create email@gmail.com | 85', chatId);
    const email = emailRaw.toLowerCase();
    const days = parts[1] ? parseInt(parts[1]) : 28;
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
    const token = parts[0]; const days = parseInt(parts[1])||28;
    const links = loadLinks();
    if (!links[token]) return sendTelegram('❌ Link not found', chatId);
    links[token].expiresAt = Date.now()+days*24*60*60*1000;
    links[token].warningSent = false; links[token].active = true;
    saveLinks(links);
    return sendTelegram(`✅ Renewed /c/${token} for ${days} days`, chatId);
  }

  if (text.startsWith('/extend')) {
    const parts = text.replace('/extend','').trim().split(' ');
    if (parts.length < 2) return sendTelegram('❌ Format: /extend TOKEN days', chatId);
    const [token, daysStr] = parts; const days = parseInt(daysStr)||28;
    const links = loadLinks();
    if (!links[token]) return sendTelegram('❌ Link not found', chatId);
    links[token].expiresAt += days*24*60*60*1000;
    links[token].warningSent = false;
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
      msg2 += `${days}d | ${l.profile} | ${l.email}\n/renew ${l.token} 28\n\n`;
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
  links[req.params.token].active = false; saveLinks(links); res.json({ success:true });
});

app.post('/api/admin/activate/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  links[req.params.token].active = true; saveLinks(links); res.json({ success:true });
});

app.post('/api/admin/extend/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  const { days } = req.body;
  links[req.params.token].expiresAt += parseInt(days)*24*60*60*1000;
  links[req.params.token].warningSent = false;
  saveLinks(links); res.json({ success:true });
});

app.post('/api/admin/renew/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  const { days } = req.body; const d = parseInt(days)||28;
  links[req.params.token].expiresAt = Date.now()+d*24*60*60*1000;
  links[req.params.token].warningSent = false;
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

app.get('/api/link/:token/info', (req, res) => {
  const links = loadLinks();
  const link = links[req.params.token];
  if (!link) return res.status(404).json({ success:false, error:'invalid', message:'Invalid link.' });
  if (!link.active) return res.status(403).json({ success:false, error:'revoked', message:'Access revoked. Contact FanFlix BD.' });
  const now = Date.now();
  const daysLeft = Math.ceil((link.expiresAt-now)/(24*60*60*1000));
  const totalDays = link.days || 28;
  if (now > link.expiresAt) return res.status(403).json({ success:false, error:'expired', message:'Subscription expired!', daysLeft:0, expiresAt:link.expiresAt, profile:link.profile, token:req.params.token });
  res.json({ success:true, profile:link.profile, pin:link.pin, email:link.email, daysLeft, totalDays });
});

app.get('/api/link/:token', async (req, res) => {

  const links = loadLinks();
  const link = links[req.params.token];
  if (!link) return res.status(404).json({ success:false, error:'invalid', message:'Invalid link.' });
  if (!link.active) return res.status(403).json({ success:false, error:'revoked', message:'Access revoked. Contact FanFlix BD.' });
  const now = Date.now();
  const daysLeft = Math.ceil((link.expiresAt-now)/(24*60*60*1000));
  const totalDays = link.days || 28;
  if (now > link.expiresAt) return res.status(403).json({ success:false, error:'expired', message:'Subscription expired!', daysLeft:0, expiresAt:link.expiresAt, profile:link.profile, token:req.params.token });
  link.uses += 1; link.lastUsed = now; saveLinks(links);
  trackAnalytics(req.params.token);
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  trackVisitor(ip);
  const ipCount = trackIP(req.params.token, ip);
  trackIPGeo(req.params.token, ip).catch(()=>{});
  try {
    // Check cache first — instant response if recently fetched
    const cached = getCodesFromCache(link.email);
    if (cached !== null) {
      if (cached.length > 0) totalToday += 1;
      return res.json({ success:true, codes:cached, count:cached.length, profile:link.profile, pin:link.pin, email:link.email, daysLeft, totalDays, ipCount, uses:link.uses });
    }
    // Already fetching in background — return fetching:true so customer keeps retrying
    if (fetchingEmails.has(link.email.toLowerCase())) {
      return res.json({ success:true, codes:[], count:0, profile:link.profile, pin:link.pin, email:link.email, daysLeft, totalDays, ipCount, uses:link.uses, fetching:true });
    }
    // Start background fetch — return instantly, customer retries every 10s
    fetchingEmails.add(link.email.toLowerCase());
    res.json({ success:true, codes:[], count:0, profile:link.profile, pin:link.pin, email:link.email, daysLeft, totalDays, ipCount, uses:link.uses, fetching:true });
    fetchNetflixEmailsFresh(link.email, true).then(codes => {
      setCodesInCache(link.email, codes);
      fetchingEmails.delete(link.email.toLowerCase());
      if (codes.length > 0) totalToday += 1;
    }).catch(() => {
      fetchingEmails.delete(link.email.toLowerCase());
    });
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

app.get('/api/admin/geo', (req, res) => {
  try {
    if (req.headers['x-admin-token'] !== ADMIN_PASS) return res.status(401).json({ error:'Unauthorized' });
    const geoData = loadGeo();
    res.json({ success: true, geo: geoData });
  } catch(e) { res.json({ success: true, geo: {} }); }
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
      l.phone && l.phone.replace(/\D/g,'') === phoneNorm && l.active && l.expiresAt > now
    );
    if (existingActive.length > 0) {
      for (const el of existingActive) {
        allLinks[el.token].expiresAt += d * 24 * 60 * 60 * 1000;
        allLinks[el.token].warningSent = false;
        allLinks[el.token].renewalCount = (allLinks[el.token].renewalCount || 0) + 1;
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
  res.json({ success:true, waitlist, count: waitlist.length });
});

app.post('/api/admin/waitlist/process', adminAuth, async (req, res) => {
  const waitlist = loadWaitlist();
  if (!waitlist.length) return res.json({ success:true, processed:0, message:'Waitlist empty' });
  let processed = 0;
  const remaining = [];
  for (const w of waitlist) {
    const slot = getNextAvailableSlot(w.days || 28);
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
    const { full_name, sender_number, amount, payment_method, invoice_id, metadata } = data;

    if (!sender_number || !amount) return;

    const phone = sender_number.replace(/\D/g, '');
    const customerName = full_name || '';
    const amountNum = parseFloat(amount) || 0;

    // Detect plan from amount
    let days = 28;
    let product = 'Netflix';
    if (amountNum >= 1200) { days = 85; product = 'Netflix 3 Month'; }
    else if (amountNum >= 390) { days = 28; product = 'Netflix 1 Month'; }

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
    if (!settings.autoLink) return;

    // Auto-create link (reuse same logic as /api/auto-create)
    const phoneNorm = phone;
    const allLinks = loadLinks();
    const now = Date.now();

    // Renewal check
    const existingActive = Object.values(allLinks).filter(l =>
      l.phone && l.phone.replace(/\D/g,'') === phoneNorm && l.active && l.expiresAt > now
    );
    if (existingActive.length > 0) {
      let renewed = 0;
      for (const el of existingActive) {
        allLinks[el.token].expiresAt += days * 24 * 60 * 60 * 1000;
        allLinks[el.token].warningSent = false;
        allLinks[el.token].renewalCount = (allLinks[el.token].renewalCount || 0) + 1;
        renewed++;
      }
      saveLinks(allLinks);
      const first = existingActive[0];
      sendTelegram(`🔄 <b>Renewal via UddoktaPay!</b>
👤 ${customerName} | 📱 ${sender_number}
🔗 Extended ${renewed} link(s) +${days} days`);
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
  // Clear cache and fetch fresh
  clearEmailCache(link.email);
  try {
    const codes = await fetchNetflixEmailsFresh(link.email, true);
    setCodesInCache(link.email, codes);
    res.json({ success:true, codes, count:codes.length, refreshed:true });
  } catch(err) {
    res.json({ success:true, codes:[], count:0, refreshed:true });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok:true, user:GMAIL_USER?GMAIL_USER.replace(/(.{3}).*(@.*)/,'$1***$2'):'NOT SET' });
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
    const active = Object.values(links).filter(l => l.email===a.email && l.active && l.expiresAt>now).length;
    return { ...a, slotsUsed: active, slotsTotal: 8, planDays: a.planDays||null, expiresAt: a.expiresAt||null };
  });
  res.json({ success:true, accounts: result });
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
    l.phone && l.phone.replace(/\D/g,'').includes(phone) && l.active && l.expiresAt > now
  );
  if (!found.length) return res.status(404).json({ success:false, error:'No active links found for this number' });
  res.json({ success:true, links: found.map(l => ({
    token: l.token,
    profile: l.profile,
    pin: l.pin,
    daysLeft: Math.ceil((l.expiresAt-now)/(24*60*60*1000)),
    link: SITE_URL+'/c/'+l.token
  }))});
});

app.get('/track', (req, res) => res.sendFile(path.join(__dirname,'public','track.html')));
app.get('/c/:token', (req, res) => {
  // Inject patch script to fix auto-refresh and loading behavior
  const fs2 = require('fs');
  const path2 = require('path');
  try {
    let html = fs2.readFileSync(path2.join(__dirname,'public','customer.html'), 'utf8');
    const patch = `
<script>
// FanFlix patch: 10s auto-refresh + always-on refresh button + instant page load
(function(){
  // Wait for original JS to load
  const _orig = window.onload;
  window.onload = function(){
    if(_orig) _orig();
  };

  // Override fetchCodes after page loads
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){
      // Patch 1: doRefresh never disables button
      window.doRefresh = function(){
        fetchCodes(window._tok, true);
      };

      // Patch 2: Override auto-refresh interval to 10s
      // The original sets 60s - we'll reset it after first call
      const _origFetch = window.fetchCodes;
      if(_origFetch) {
        window.fetchCodes = async function(token, isRefresh){
          await _origFetch(token, isRefresh);
          // Reset timer to 10s after every call
          if(window.refTimer) clearInterval(window.refTimer);
          window.refTimer = setInterval(function(){ 
            fetchCodes(window._tok, true); 
          }, 10000);
        };
      }
    }, 100);
  });
})();
</script>`;
    html = html.replace('</body>', patch + '\n</body>');
    res.send(html);
  } catch(e) {
    res.sendFile(path.join(__dirname,'public','customer.html'));
  }
});

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
});
