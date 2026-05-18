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
const DATA_DIR = '/app/data';
const LINKS_FILE = `${DATA_DIR}/links.json`;
const ANALYTICS_FILE = `${DATA_DIR}/analytics.json`;
const LOGIN_VIDEO = process.env.LOGIN_VIDEO || 'https://youtu.be/PLACEHOLDER1';
const HOUSEHOLD_VIDEO = process.env.HOUSEHOLD_VIDEO || 'https://youtu.be/PLACEHOLDER2';
const SITE_URL = process.env.SITE_URL || 'https://household.fanflixbd.com';
const WA_NUMBER = '8801928382918';
const MAX_SLOTS = 8;

// Fixed Netflix profiles
const FIXED_PROFILES = [
  { profile: 'Profile A', pin: '5651', slots: 2 },
  { profile: 'Profile B', pin: '5652', slots: 2 },
  { profile: 'Profile C', pin: '5653', slots: 2 },
  { profile: 'Profile D', pin: '5654', slots: 1 },
  { profile: 'Profile E', pin: '5655', slots: 1 },
];

const BLOCKED_CODES = ['2023','2024','2025','2026','2027','2028','0000'];

// ── DATA ────────────────────────────────────────────────────
function ensureDataDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {} }
function loadLinks() { try { return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); } catch(e) { return {}; } }
function saveLinks(links) { ensureDataDir(); fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2)); }
function loadAnalytics() { try { return JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8')); } catch(e) { return {}; } }
function saveAnalytics(data) { ensureDataDir(); fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(data, null, 2)); }
function trackAnalytics(token) {
  const data = loadAnalytics();
  if (!data[token]) data[token] = { total: 0, daily: {} };
  data[token].total += 1;
  const today = new Date().toISOString().split('T')[0];
  data[token].daily[today] = (data[token].daily[today] || 0) + 1;
  saveAnalytics(data);
}
function generateToken() { return crypto.randomBytes(4).toString('hex'); }

// ── STATS ────────────────────────────────────────────────────
let totalToday = 0, lastReset = new Date().toDateString();
const visitors = new Map();
function resetDailyIfNeeded() { const t = new Date().toDateString(); if (t !== lastReset) { totalToday = 0; lastReset = t; } }
function trackVisitor(ip) { visitors.set(ip, Date.now()); const c = Date.now()-5*60*1000; for(const[k,v] of visitors) if(v<c) visitors.delete(k); }
function getLiveVisitors() { const c = Date.now()-5*60*1000; return [...visitors.values()].filter(v=>v>c).length; }

// ── RATE LIMIT ───────────────────────────────────────────────
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const e = rateLimitMap.get(ip) || { count:0, start:now };
  if (now - e.start > 5*60*1000) { rateLimitMap.set(ip,{count:1,start:now}); return false; }
  if (e.count >= 10) return true;
  e.count++; rateLimitMap.set(ip,e); return false;
}

// ── CACHE ────────────────────────────────────────────────────
const cache = new Map();
function getCached(key) { const e=cache.get(key); if(e&&Date.now()-e.time<30000) return e.data; return null; }
function setCache(key, data) { cache.set(key, {data, time:Date.now()}); }

// ── TELEGRAM ─────────────────────────────────────────────────
async function sendTelegram(msg, chatId=TG_CHAT) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id:chatId, text:msg, parse_mode:'HTML', disable_web_page_preview:true })
    });
  } catch(e) { console.error('TG error:', e.message); }
}

// ── EXPIRY CHECKER ───────────────────────────────────────────
function checkExpiringLinks() {
  const links = loadLinks();
  const now = Date.now(), threeDays = 3*24*60*60*1000;
  for (const link of Object.values(links)) {
    if (!link.active) continue;
    const remaining = link.expiresAt - now;
    if (remaining > 0 && remaining <= threeDays && !link.warningSent) {
      const days = Math.ceil(remaining/(24*60*60*1000));
      sendTelegram(`⚠️ <b>Link Expiring Soon!</b>\n\n📧 ${link.email}\n👤 ${link.profile}\n🔑 ${link.pin}\n⏳ <b>${days} day(s) left</b>\n🔗 ${SITE_URL}/c/${link.token}\n\nRenew: /renew ${link.token} 28`);
      links[link.token].warningSent = true;
      saveLinks(links);
    }
  }
}
setInterval(checkExpiringLinks, 60*60*1000);

// ── AUTO OTP SCRAPER ─────────────────────────────────────────
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
      if (match) { const code=(match[1]||match[0]).replace(/\D/g,''); if(code&&code.length>=4&&code.length<=6&&!BLOCKED_CODES.includes(code)) return code; }
    }
    const allMatches = [...html.matchAll(/(?<![0-9])(\d{4})(?![0-9])/g)];
    const filtered = allMatches.filter(m=>!BLOCKED_CODES.includes(m[1])&&!['1080','1920','1440'].includes(m[1]));
    if (filtered.length > 0) return filtered[0][1];
    return null;
  } catch(e) { return null; }
}

// ── IMAP ─────────────────────────────────────────────────────
function fetchNetflixEmails(filterEmail, includeSignin=false) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: GMAIL_USER, password: GMAIL_PASS,
      host: 'imap.gmail.com', port: 993, tls: true,
      tlsOptions: { rejectUnauthorized: false }
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
                  // ── STRICT EMAIL MATCH ──
                  // Get ALL recipient addresses from To, CC, delivered-to headers
                  const allAddresses = [];
                  const toText = mail.to?.text || '';
                  const ccText = mail.cc?.text || '';
                  const deliveredTo = mail.headers?.get('delivered-to') || '';
                  const xDeliveredTo = mail.headers?.get('x-delivered-to') || '';
                  // Extract all emails from these fields
                  const extractEmails = (text) => {
                    if (!text || typeof text !== 'string') return [];
                    const matches = text.match(/[\w.-]+@[\w.-]+\.[a-z]{2,}/gi) || [];
                    return matches.map(e => e.toLowerCase().trim());
                  };
                  allAddresses.push(...extractEmails(toText));
                  allAddresses.push(...extractEmails(ccText));
                  allAddresses.push(...extractEmails(deliveredTo));
                  allAddresses.push(...extractEmails(xDeliveredTo));
                  // Primary toEmail for display
                  const toEmail = allAddresses[0] || toText.toLowerCase().trim();
                  const subject = (mail.subject || '').toLowerCase();
                  const bodyHtml = mail.html || '';
                  const bodyText = mail.text || '';
                  const bodyPlain = (bodyHtml || bodyText).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
                  const ts = mail.date ? new Date(mail.date).getTime() : Date.now();
                  // SMART EMAIL FILTER
                  if (filterEmail) {
                    const filterLower = filterEmail.toLowerCase().trim();

                    // Extract ALL email addresses from the full raw To header
                    // Handles: "Hide My Email <cereals-stem6h@icloud.com>"
                    const rawTo = mail.headerLines
                      ?.find(h => h.key === 'to')?.line || '';
                    const rawCc = mail.headerLines
                      ?.find(h => h.key === 'cc')?.line || '';

                    // Get all addresses from mailparser's parsed to/cc
                    const toAddresses = (mail.to?.value || []).map(a => (a.address||'').toLowerCase());
                    const ccAddresses = (mail.cc?.value || []).map(a => (a.address||'').toLowerCase());

                    // Also extract from raw header strings
                    const emailRegex = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
                    const rawToEmails = (rawTo.match(emailRegex)||[]).map(e=>e.toLowerCase());
                    const rawCcEmails = (rawCc.match(emailRegex)||[]).map(e=>e.toLowerCase());

                    // Combine all found addresses
                    const allFound = [...toAddresses, ...ccAddresses, ...rawToEmails, ...rawCcEmails, ...allAddresses];

                    const matched = allFound.some(a => a === filterLower);
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
    imap.once('error', (err) => { reject(err); });
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
  if (includeSignin && (sl.includes('sign-in code') || sl.includes('sign in code'))) {
    let signinCode = null;

    // Netflix sign-in email HTML contains the code with specific spacing like "8 1 7 1"
    // or as a plain 4-digit number in large text

    // Pattern 1: Spaced digits "8 1 7 1" format (Netflix HTML email style)
    const spacedMatch = bodyPlain.match(/\b(\d)\s(\d)\s(\d)\s(\d)\b/);
    if (spacedMatch) {
      const code = spacedMatch[1]+spacedMatch[2]+spacedMatch[3]+spacedMatch[4];
      if (!BLOCKED_CODES.includes(code)) signinCode = code;
    }

    // Pattern 2: HTML - code in its own element with large font/tracking
    if (!signinCode) {
      const htmlMatch = bodyHtml.match(/(?:letter-spacing|font-size)[^>]*>\s*([0-9]\s*[0-9]\s*[0-9]\s*[0-9])\s*</i);
      if (htmlMatch) {
        const code = htmlMatch[1].replace(/\s/g,'');
        if (code.length === 4 && !BLOCKED_CODES.includes(code)) signinCode = code;
      }
    }

    // Pattern 3: 4 digits between "code" and "Enter" in plain text
    if (!signinCode) {
      const between = bodyPlain.match(/sign in[^0-9]{0,50}(\d{4})[^0-9]/i) ||
                      bodyPlain.match(/your code[^0-9]{0,30}(\d{4})[^0-9]/i) ||
                      bodyPlain.match(/enter[^0-9]{0,30}(\d{4})[^0-9]/i);
      if (between && !BLOCKED_CODES.includes(between[1])) signinCode = between[1];
    }

    // Pattern 4: standalone 4-digit number preceded and followed by spaces/newlines
    if (!signinCode) {
      const lines = bodyPlain.split(/[\n\r]+/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^\d{4}$/.test(trimmed) && !BLOCKED_CODES.includes(trimmed)) {
          signinCode = trimmed; break;
        }
        // Also check spaced version "8 1 7 1"
        const spaced = trimmed.replace(/\s/g,'');
        if (/^\d{4}$/.test(spaced) && !BLOCKED_CODES.includes(spaced) && trimmed.length <= 8) {
          signinCode = spaced; break;
        }
      }
    }

    if (signinCode) return { type:'signin', label:'Sign-in Code', code:signinCode, to:toEmail, ts, expiresAt:ts+15*60*1000 };
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

// ── ADMIN AUTH ───────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_PASS) return res.status(401).json({ error:'Unauthorized' });
  next();
}

// ── TELEGRAM WEBHOOK ─────────────────────────────────────────
app.post('/tg-webhook', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg?.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;

  // /create email [| days]
  if (text.startsWith('/create')) {
    const parts = text.replace('/create','').trim().split('|').map(s=>s.trim());
    const emailRaw = parts[0];
    if (!emailRaw || !emailRaw.includes('@')) return sendTelegram('❌ Format: /create email@gmail.com\nOptional: /create email@gmail.com | 85', chatId);
    const email = emailRaw.toLowerCase();
    const days = parts[1] ? parseInt(parts[1]) : 28;
    const links = loadLinks();
    const now = Date.now();
    // Count existing active links for this email
    const existing = Object.values(links).filter(l => l.email===email && l.active && l.expiresAt>now);
    if (existing.length >= MAX_SLOTS) {
      return sendTelegram(`❌ <b>Account Full!</b>\n\n📧 ${email}\nAlready has ${MAX_SLOTS}/${MAX_SLOTS} active links!\n\nUse /list ${email} to see them.\nUse /revoke TOKEN to free a slot.`, chatId);
    }
    // Generate all 8 links
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
    msg2 += `\n━━━━━━━━━━━━━━━━━━\n📋 <b>Template:</b>\n\n` + buildCustomerMessage(email, '[PROFILE]', '[PIN]', '[LINK]', days);
    return sendTelegram(msg2, chatId);
  }

  // /list email
  if (text.startsWith('/list')) {
    const emailFilter = text.replace('/list','').trim().toLowerCase();
    const links = loadLinks();
    const now = Date.now();
    const filtered = Object.values(links).filter(l => !emailFilter || l.email.includes(emailFilter));
    if (!filtered.length) return sendTelegram(`No links found${emailFilter?' for '+emailFilter:''}`, chatId);
    let msg2 = `📋 <b>Links${emailFilter?' — '+emailFilter:''}</b>\n\n`;
    for (const l of filtered.sort((a,b)=>b.createdAt-a.createdAt)) {
      const daysLeft = Math.ceil((l.expiresAt-now)/(24*60*60*1000));
      const status = !l.active?'🚫 Revoked':daysLeft<=0?'⏰ Expired':daysLeft<=3?'⚠️ Expiring':'✅ Active';
      msg2 += `${status}\n👤 ${l.profile} | PIN: ${l.pin}\n🔗 /c/${l.token}\n⏳ ${daysLeft}d | Uses: ${l.uses}\n\n`;
    }
    return sendTelegram(msg2, chatId);
  }

  // /extend TOKEN days
  if (text.startsWith('/extend')) {
    const parts = text.replace('/extend','').trim().split(' ');
    if (parts.length < 2) return sendTelegram('❌ Format: /extend TOKEN days\nExample: /extend abc12345 28', chatId);
    const [token, daysStr] = parts;
    const days = parseInt(daysStr)||28;
    const links = loadLinks();
    if (!links[token]) return sendTelegram('❌ Link not found: '+token, chatId);
    links[token].expiresAt += days*24*60*60*1000;
    links[token].warningSent = false;
    links[token].active = true;
    saveLinks(links);
    const newExpiry = new Date(links[token].expiresAt).toLocaleDateString();
    return sendTelegram(`✅ <b>Extended!</b>\n\n🔗 /c/${token}\n👤 ${links[token].profile}\n⏳ +${days} days\n📅 New expiry: ${newExpiry}`, chatId);
  }

  // /renew TOKEN [days]
  if (text.startsWith('/renew')) {
    const parts = text.replace('/renew','').trim().split(' ');
    const token = parts[0];
    const days = parseInt(parts[1])||28;
    const links = loadLinks();
    if (!links[token]) return sendTelegram('❌ Link not found: '+token, chatId);
    const now = Date.now();
    links[token].expiresAt = now + days*24*60*60*1000;
    links[token].warningSent = false;
    links[token].active = true;
    saveLinks(links);
    const link = links[token];
    const fullLink = `${SITE_URL}/c/${token}`;
    const customerMsg = buildCustomerMessage(link.email, link.profile, link.pin, fullLink, days);
    return sendTelegram(`✅ <b>Renewed!</b>\n\n📧 ${link.email}\n👤 ${link.profile}\n⏳ ${days} days from now\n\n📋 <b>Customer Message:</b>\n\n${customerMsg}`, chatId);
  }

  // /revoke TOKEN
  if (text.startsWith('/revoke')) {
    const token = text.replace('/revoke','').trim();
    const links = loadLinks();
    if (!links[token]) return sendTelegram('❌ Link not found', chatId);
    links[token].active = false;
    saveLinks(links);
    return sendTelegram(`✅ Revoked /c/${token}`, chatId);
  }

  // /slots
  if (text === '/slots') {
    const links = loadLinks();
    const now = Date.now();
    const byEmail = {};
    for (const l of Object.values(links)) {
      if (!byEmail[l.email]) byEmail[l.email] = { active:0, total:0, profiles:[] };
      byEmail[l.email].total++;
      if (l.active && l.expiresAt>now) { byEmail[l.email].active++; byEmail[l.email].profiles.push(l.profile); }
    }
    let msg2 = '📊 <b>Slot Usage</b>\n\n';
    for (const [email, info] of Object.entries(byEmail)) {
      const bar = '█'.repeat(info.active)+'░'.repeat(Math.max(0,MAX_SLOTS-info.active));
      msg2 += `📧 ${email}\n${bar} ${info.active}/${MAX_SLOTS}\n\n`;
    }
    return sendTelegram(msg2||'No active links.', chatId);
  }

  // /stats
  if (text === '/stats') {
    const links = loadLinks();
    const now = Date.now();
    const active = Object.values(links).filter(l=>l.active&&l.expiresAt>now).length;
    const expired = Object.values(links).filter(l=>l.expiresAt<=now).length;
    const revoked = Object.values(links).filter(l=>!l.active).length;
    const totalUses = Object.values(links).reduce((s,l)=>s+l.uses,0);
    return sendTelegram(`📊 <b>FanFlix Stats</b>\n\n✅ Active: ${active}\n⏰ Expired: ${expired}\n🚫 Revoked: ${revoked}\n👁 Total uses: ${totalUses}\n👥 Live: ${getLiveVisitors()}\n📈 Today: ${totalToday}`, chatId);
  }

  // /help
  if (text === '/help' || text === '/start') {
    return sendTelegram(
      `🎬 <b>FanFlix Bot Commands</b>\n\n` +
      `<b>Create:</b>\n/create email@gmail.com\n/create email@gmail.com | 85\n\n` +
      `<b>Manage:</b>\n/list email — list all links\n/renew TOKEN 28 — renew link\n/extend TOKEN 28 — extend days\n/revoke TOKEN — revoke link\n\n` +
      `<b>Info:</b>\n/slots — slot usage\n/stats — full stats\n/help — this menu`, chatId
    );
  }
});

function buildCustomerMessage(email, profile, pin, link, days) {
  return `🎬 <b>FanFlix BD</b>\n\n📧 Email: <code>${email}</code>\n👤 Profile: ${profile}\n🔑 PIN: ${pin}\n\n🔗 Household Code Link:\n${link}\n\n📺 Login Tutorial (Must Watch):\n${LOGIN_VIDEO}\n\n🏠 Household Fix Tutorial:\n${HOUSEHOLD_VIDEO}\n\n⚠️ Important:\n• Any changes to the account are not allowed\n• Streaming is allowed on 1 device at a time\n• Do not use it from outside BD\n• You can sign in anytime if it shows signed out\n\n✅ Valid for ${days} days`;
}

// ── ADMIN ROUTES ─────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASS) res.json({ success:true, token:ADMIN_PASS });
  else res.status(401).json({ success:false, error:'Wrong password' });
});

app.get('/api/admin/links', adminAuth, (req, res) => {
  const links = loadLinks();
  const analytics = loadAnalytics();
  for (const token of Object.keys(links)) links[token].analytics = analytics[token] || { total:0, daily:{} };
  res.json({ success:true, links });
});

app.post('/api/admin/create', adminAuth, (req, res) => {
  const { email, profile, pin, days } = req.body;
  if (!email||!profile||!pin||!days) return res.status(400).json({ error:'Missing fields' });
  const links = loadLinks();
  const now = Date.now();
  // Check existing active link for same email+profile
  const existing = Object.values(links).find(l => l.email===email.toLowerCase() && l.profile===profile && l.active && l.expiresAt>now);
  if (existing) return res.json({ success:true, token:existing.token, link:`/c/${existing.token}`, existing:true });
  // Check max slots
  const activeCount = Object.values(links).filter(l => l.email===email.toLowerCase() && l.active && l.expiresAt>now).length;
  if (activeCount >= MAX_SLOTS) return res.status(400).json({ error:`Account full (${MAX_SLOTS}/${MAX_SLOTS} slots used)` });
  const token = generateToken();
  links[token] = { token, email:email.toLowerCase(), profile, pin, days:parseInt(days), createdAt:now, expiresAt:now+parseInt(days)*24*60*60*1000, uses:0, lastUsed:null, active:true, warningSent:false };
  saveLinks(links);
  res.json({ success:true, token, link:`/c/${token}` });
});

app.post('/api/admin/revoke/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  links[req.params.token].active = false;
  saveLinks(links);
  res.json({ success:true });
});

app.post('/api/admin/activate/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  links[req.params.token].active = true;
  saveLinks(links);
  res.json({ success:true });
});

app.post('/api/admin/extend/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  const { days } = req.body;
  links[req.params.token].expiresAt += parseInt(days)*24*60*60*1000;
  links[req.params.token].warningSent = false;
  saveLinks(links);
  res.json({ success:true });
});

// One-click renew — resets expiry from NOW
app.post('/api/admin/renew/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  const { days } = req.body;
  const d = parseInt(days)||28;
  links[req.params.token].expiresAt = Date.now() + d*24*60*60*1000;
  links[req.params.token].warningSent = false;
  links[req.params.token].active = true;
  saveLinks(links);
  res.json({ success:true, newExpiry: links[req.params.token].expiresAt });
});

app.delete('/api/admin/delete/:token', adminAuth, (req, res) => {
  const links = loadLinks();
  if (!links[req.params.token]) return res.status(404).json({ error:'Not found' });
  delete links[req.params.token];
  saveLinks(links);
  res.json({ success:true });
});

app.get('/api/admin/slots', adminAuth, (req, res) => {
  const links = loadLinks();
  const now = Date.now();
  const byEmail = {};
  for (const l of Object.values(links)) {
    if (!byEmail[l.email]) byEmail[l.email] = { active:0, total:0 };
    byEmail[l.email].total++;
    if (l.active && l.expiresAt>now) byEmail[l.email].active++;
  }
  res.json({ success:true, slots:byEmail, maxSlots:MAX_SLOTS });
});

// ── CUSTOMER LINK ─────────────────────────────────────────────
app.get('/api/link/:token', async (req, res) => {
  const links = loadLinks();
  const link = links[req.params.token];
  if (!link) return res.status(404).json({ success:false, error:'invalid', message:'Invalid link. Contact FanFlix BD.' });
  if (!link.active) return res.status(403).json({ success:false, error:'revoked', message:'Your access has been revoked. Contact FanFlix BD.' });
  const now = Date.now();
  const daysLeft = Math.ceil((link.expiresAt-now)/(24*60*60*1000));
  if (now > link.expiresAt) return res.status(403).json({ success:false, error:'expired', message:'Your FanFlix subscription has expired!', daysLeft:0 });
  link.uses += 1;
  link.lastUsed = now;
  saveLinks(links);
  trackAnalytics(req.params.token);
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  trackVisitor(ip);
  try {
    const codes = await fetchNetflixEmails(link.email, true);
    if (codes.length > 0) totalToday += 1;
    res.json({ success:true, codes, count:codes.length, profile:link.profile, pin:link.pin, email:link.email, daysLeft });
  } catch(err) {
    res.status(500).json({ success:false, error:'server', message:'Server error. Try again.' });
  }
});

// ── PUBLIC ROUTES ─────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  trackVisitor(ip); resetDailyIfNeeded();
  res.json({ live:getLiveVisitors(), today:totalToday });
});

// Debug endpoint - shows raw email headers for troubleshooting
app.get('/api/debug-email', async (req, res) => {
  const filterEmail = (req.query.email || '').trim().toLowerCase();
  try {
    const results = await new Promise((resolve, reject) => {
      const imap = new Imap({
        user: GMAIL_USER, password: GMAIL_PASS,
        host: 'imap.gmail.com', port: 993, tls: true,
        tlsOptions: { rejectUnauthorized: false }
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
              const p = new Promise((res2) => {
                msg.on('body', (stream) => {
                  simpleParser(stream, (err, mail) => {
                    if (err) return res2(null);
                    const toText = mail.to?.text || '';
                    const toValues = (mail.to?.value || []).map(a => a.address);
                    const subject = mail.subject || '';
                    res2({
                      subject,
                      to_text: toText,
                      to_parsed: toValues,
                      cc: mail.cc?.text || '',
                      header_lines: mail.headerLines?.filter(h => ['to','cc','delivered-to','x-forwarded-to','x-original-to','envelope-to'].includes(h.key)).map(h => h.line) || [],
                      matches_filter: filterEmail ? toValues.some(a => a?.toLowerCase() === filterEmail) || toText.toLowerCase().includes(filterEmail) : true
                    });
                  });
                });
              });
              promises.push(p);
            });
            fetch.once('end', async () => {
              const items = (await Promise.all(promises)).filter(Boolean);
              imap.end();
              resolve(items);
            });
            fetch.once('error', (e) => { imap.end(); reject(e); });
          });
        });
      });
      imap.once('error', reject);
      imap.connect();
    });
    res.json({ success: true, filter: filterEmail, count: results.length, emails: results });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/debug-signin', async (req, res) => {
  const filterEmail = (req.query.email || '').trim().toLowerCase();
  try {
    const results = await new Promise((resolve, reject) => {
      const imap = new Imap({
        user: GMAIL_USER, password: GMAIL_PASS,
        host: 'imap.gmail.com', port: 993, tls: true,
        tlsOptions: { rejectUnauthorized: false }
      });
      imap.once('ready', () => {
        imap.openBox('INBOX', true, (err) => {
          if (err) { imap.end(); return reject(err); }
          const since = new Date(Date.now() - 20*60*1000);
          imap.search([['SINCE', since], ['SUBJECT', 'sign-in code']], (err, uids) => {
            if (err || !uids || uids.length === 0) { imap.end(); return resolve([]); }
            const fetch = imap.fetch(uids, { bodies: '' });
            const promises = [];
            fetch.on('message', (msg) => {
              const p = new Promise((res2) => {
                msg.on('body', (stream) => {
                  simpleParser(stream, (err, mail) => {
                    if (err) return res2(null);
                    const toValues = (mail.to?.value || []).map(a => a.address?.toLowerCase());
                    const bodyPlain = (mail.html || mail.text || '').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
                    // Extract all 4-digit numbers from body
                    const allNums = [...bodyPlain.matchAll(/(?<![0-9])(\d{4})(?![0-9])/g)].map(m => m[1]);
                    res2({
                      to: mail.to?.text,
                      to_parsed: toValues,
                      subject: mail.subject,
                      matches_filter: filterEmail ? toValues.some(a => a === filterEmail) : true,
                      all_4digit_numbers: allNums,
                      body_plain_first200: bodyPlain.substring(0, 200)
                    });
                  });
                });
              });
              promises.push(p);
            });
            fetch.once('end', async () => {
              const items = (await Promise.all(promises)).filter(Boolean);
              imap.end();
              resolve(items);
            });
            fetch.once('error', (e) => { imap.end(); reject(e); });
          });
        });
      });
      imap.once('error', reject);
      imap.connect();
    });
    res.json({ success: true, filter: filterEmail, results });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok:true, user:GMAIL_USER?GMAIL_USER.replace(/(.{3}).*(@.*)/,'$1***$2'):'NOT SET' });
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
    const codes = await fetchNetflixEmails(email, false);
    const fetchTime = ((Date.now()-start)/1000).toFixed(1);
    setCache(email, codes);
    if (codes.length > 0) totalToday += 1;
    res.json({ success:true, codes, count:codes.length, fetchTime });
  } catch(err) {
    res.status(500).json({ success:false, error:err.message });
  }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/c/:token', (req, res) => res.sendFile(path.join(__dirname,'public','customer.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

ensureDataDir();
app.listen(PORT, () => {
  console.log(`FanFlix running on port ${PORT}`);
  sendTelegram('🟢 <b>FanFlix Started</b>\n\nType /help for commands');
});
