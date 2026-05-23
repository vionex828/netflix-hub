<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>FanFlix – Your Codes</title>
<link rel="manifest" href="/manifest.json">
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{
  --red:#E50914;--red2:#a50000;
  --bg:#0a0a0a;--s1:#111;--s2:#161616;--s3:#1c1c1c;--s4:#222;--s5:#2a2a2a;
  --border:rgba(255,255,255,.08);--border2:rgba(255,255,255,.15);
  --text:#fff;--muted:#888;--muted2:#555;
  --green:#46d369;--amber:#f5a623;--blue:#4da6ff;--purple:#9664ff;
  --f:'Inter',sans-serif;--m:'IBM Plex Mono',monospace;--h:'Anton',sans-serif;
}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{overflow-x:hidden}
body{background:var(--bg);color:var(--text);font-family:var(--f);min-height:100vh;-webkit-font-smoothing:antialiased}

/* NAV */
nav{background:rgba(10,10,10,.97);backdrop-filter:blur(20px);padding:0 1.2rem;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;border-bottom:1px solid var(--border)}
.logo{font-family:var(--h);font-size:1.7rem;letter-spacing:3px}
.logo .f{color:var(--red)}.logo .l{color:var(--text)}
.nav-avatar{width:34px;height:34px;border-radius:50%;background:var(--red);display:flex;align-items:center;justify-content:center;font-family:var(--h);font-size:.9rem;color:#fff}

/* PROGRESS BAR TOP */
.prog{position:fixed;top:0;left:0;right:0;height:2px;z-index:999}
.prog.on .pb{animation:pa 1.5s ease infinite}
.pb{height:100%;background:var(--red);width:0;box-shadow:0 0 8px var(--red)}
@keyframes pa{0%{width:0;margin-left:0}50%{width:60%}100%{width:0;margin-left:100%}}

/* PAGE */
.page{max-width:500px;margin:0 auto;padding:1rem 1rem 6rem}

/* STATUS CARD */
.scard{background:var(--s1);border:1px solid var(--border);border-radius:18px;overflow:hidden;margin-bottom:.9rem;animation:fu .5s ease both}
.scard-top{padding:1.2rem 1.4rem;display:flex;align-items:center;gap:1rem}
.netflix-n{width:64px;height:64px;border-radius:14px;background:linear-gradient(135deg,#8b0000,#E50914);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:var(--h);font-size:2.4rem;color:#fff;letter-spacing:0;box-shadow:0 4px 20px rgba(229,9,20,.35)}
.scard-mid{flex:1;min-width:0}
.stitle{font-size:1.15rem;font-weight:700;color:var(--green);display:flex;align-items:center;gap:7px;margin-bottom:3px}
.sdot{width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;animation:glow 2s ease infinite}
@keyframes glow{0%,100%{box-shadow:0 0 0 0 rgba(70,211,105,.5)}70%{box-shadow:0 0 0 5px rgba(70,211,105,0)}}
.scard.warning .stitle{color:var(--amber)}.scard.warning .sdot{background:var(--amber)}
.scard.danger .stitle{color:var(--red)}.scard.danger .sdot{background:var(--red)}
.ssub{font-size:.8rem;color:var(--muted);line-height:1.4}
.days-block{text-align:right;flex-shrink:0}
.days-num{font-family:var(--h);font-size:3.2rem;line-height:1;color:var(--green)}
.scard.warning .days-num{color:var(--amber)}.scard.danger .days-num{color:var(--red)}
.days-lbl{font-family:var(--m);font-size:.5rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-top:1px}
.scard-prog{padding:.6rem 1.4rem 1.2rem}
.prog-labels{display:flex;justify-content:space-between;font-family:var(--m);font-size:.6rem;color:var(--muted);margin-bottom:6px}
.prog-track{background:var(--s4);border-radius:100px;height:7px;overflow:hidden}
.prog-fill{height:100%;border-radius:100px;transition:width .6s ease}
.prog-fill.green{background:linear-gradient(90deg,#2ecc71,var(--green))}
.prog-fill.amber{background:linear-gradient(90deg,#f39c12,var(--amber))}
.prog-fill.red{background:linear-gradient(90deg,#c0392b,var(--red))}

/* INFO GRID — 2 cols */
.igrid{display:grid;grid-template-columns:1fr 1fr;gap:.7rem;margin-bottom:.7rem;animation:fu .5s ease .05s both}
.icell{background:var(--s1);border:1px solid var(--border);border-radius:14px;padding:1rem 1.1rem;display:flex;align-items:center;gap:.85rem}
.icell.full{grid-column:1/-1}
.iico{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.iico.red{background:rgba(229,9,20,.15)}.iico.blue{background:rgba(77,166,255,.12)}.iico.amber{background:rgba(245,166,35,.12)}.iico.green{background:rgba(70,211,105,.12)}.iico.grey{background:var(--s4)}.iico.purple{background:rgba(150,100,255,.12)}
.ilbl{font-family:var(--m);font-size:.52rem;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted2);margin-bottom:4px}
.ival{font-size:.9rem;font-weight:600;color:var(--text)}
.ival.green{color:var(--green)}.ival.amber{color:var(--amber)}
.isub{font-size:.7rem;color:var(--muted);margin-top:2px}
.copy-btn{display:inline-flex;align-items:center;gap:5px;margin-top:7px;background:var(--s3);border:1px solid var(--border2);border-radius:7px;padding:5px 12px;color:var(--muted);font-family:var(--m);font-size:.6rem;cursor:pointer;transition:all .2s}
.copy-btn:hover{color:var(--text);border-color:var(--muted)}
.pin-row{display:flex;align-items:center;gap:8px;margin-top:2px}
.eye-btn{background:none;border:none;color:var(--muted);cursor:pointer;padding:2px;transition:color .2s}
.eye-btn:hover{color:var(--text)}

/* REFRESH BTN */
.rbtn{width:100%;background:linear-gradient(135deg,var(--red),var(--red2));border:none;border-radius:16px;padding:1.1rem 1.5rem;cursor:pointer;margin-bottom:.9rem;display:flex;align-items:center;gap:1.1rem;transition:all .2s;animation:fu .5s ease .1s both;position:relative;overflow:hidden}
.rbtn::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,.06),transparent);pointer-events:none}
.rbtn:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 8px 28px rgba(229,9,20,.4)}
.rbtn:disabled{opacity:.7;cursor:not-allowed}
.rbtn-ico-wrap{width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.rbtn-ico{transition:none}
.rbtn-ico.spinning{animation:spin 1s linear infinite}
.rbtn-text{flex:1;text-align:left}
.rbtn-title{font-family:var(--h);font-size:1.2rem;letter-spacing:3px;color:#fff;text-transform:uppercase;display:block}
.rbtn-sub{font-family:var(--m);font-size:.65rem;color:rgba(255,255,255,.5);display:block;margin-top:2px;letter-spacing:.5px}
.rbtn-arrow{color:rgba(255,255,255,.4);flex-shrink:0}

/* ACTIVITY */
.acard{background:var(--s1);border:1px solid var(--border);border-radius:16px;padding:1.1rem 1.3rem;margin-bottom:.9rem;animation:fu .5s ease .15s both}
.ahead{display:flex;align-items:center;justify-content:space-between;margin-bottom:.9rem}
.atitle{display:flex;align-items:center;gap:.5rem;font-size:.9rem;font-weight:600}
.aright{color:var(--red);font-family:var(--m);font-size:.62rem;display:flex;align-items:center;gap:4px;cursor:pointer}
.alist{display:flex;flex-direction:column}
.aitem{display:flex;gap:.8rem;align-items:flex-start;padding:.5rem 0;position:relative}
.aitem:not(:last-child)::after{content:'';position:absolute;left:5px;top:20px;bottom:-4px;width:1px;background:var(--s4)}
.adot{width:11px;height:11px;border-radius:50%;flex-shrink:0;margin-top:3px;border:2px solid var(--bg)}
.adot.green{background:var(--green)}.adot.grey{background:var(--muted2)}
.atime{font-family:var(--m);font-size:.6rem;color:var(--muted2);flex-shrink:0;width:54px;padding-top:1px}
.atxt{font-size:.82rem;font-weight:600}
.asub{font-size:.7rem;color:var(--muted);margin-top:1px}

/* CODES */
.cwrap{animation:fu .5s ease .2s both}
.cheader{display:flex;align-items:center;gap:.6rem;margin-bottom:.8rem}
.ctitle{font-size:1rem;font-weight:700}
.cbadge{background:var(--s3);border:1px solid var(--border);border-radius:100px;padding:2px 10px;font-family:var(--m);font-size:.6rem;color:var(--muted)}
.tabs{display:flex;gap:.4rem;margin-bottom:.9rem;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{padding:7px 16px;border-radius:100px;border:1px solid var(--border);background:transparent;color:var(--muted2);font-size:.78rem;font-weight:500;cursor:pointer;transition:all .2s;white-space:nowrap;font-family:var(--f);display:flex;align-items:center;gap:5px}
.tab.a-all{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.18);color:var(--text)}
.tab.a-household{background:rgba(70,211,105,.1);border-color:rgba(70,211,105,.3);color:var(--green)}
.tab.a-update{background:rgba(245,166,35,.1);border-color:rgba(245,166,35,.3);color:var(--amber)}
.tab.a-signin{background:rgba(77,166,255,.1);border-color:rgba(77,166,255,.3);color:var(--blue)}.tab.a-verify{background:rgba(150,100,255,.1);border-color:rgba(150,100,255,.3);color:var(--purple)}
.tc{font-family:var(--m);font-size:.6rem;opacity:.6}
.cards{display:flex;flex-direction:column;gap:.7rem}

/* CODE CARD */
.card{background:var(--s1);border:1px solid var(--border);border-radius:14px;padding:1.2rem 1.4rem;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:1rem;position:relative;overflow:hidden;animation:cin .5s cubic-bezier(.34,1.56,.64,1) both;transition:border-color .2s,transform .2s;cursor:pointer}
@keyframes cin{from{opacity:0;transform:translateY(16px) scale(.97)}to{opacity:1;transform:none}}
.card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px}
.card.household::before{background:var(--green)}.card.update::before{background:var(--amber)}.card.signin::before{background:var(--blue)}.card.verify::before{background:var(--purple)}
.card:hover{border-color:var(--border2);transform:translateY(-1px)}
.card.fresh.household{background:linear-gradient(135deg,rgba(70,211,105,.05),var(--s1) 60%);border-color:rgba(70,211,105,.2)}
.card.fresh.update{background:linear-gradient(135deg,rgba(245,166,35,.05),var(--s1) 60%);border-color:rgba(245,166,35,.2)}
.card.fresh.signin{background:linear-gradient(135deg,rgba(77,166,255,.05),var(--s1) 60%);border-color:rgba(77,166,255,.2)}.card.fresh.verify{background:linear-gradient(135deg,rgba(150,100,255,.05),var(--s1) 60%);border-color:rgba(150,100,255,.2)}
.fbadge{position:absolute;top:10px;right:12px;font-family:var(--m);font-size:.5rem;letter-spacing:2px;padding:3px 8px;border-radius:3px;font-weight:600;text-transform:uppercase}
.household .fbadge{background:var(--green);color:#000;animation:fg 2s ease infinite}
.update .fbadge{background:var(--amber);color:#000}
.signin .fbadge{background:var(--blue);color:#fff}.verify .fbadge{background:var(--purple);color:#fff}
@keyframes fg{0%,100%{box-shadow:0 0 6px rgba(70,211,105,.3)}50%{box-shadow:0 0 18px rgba(70,211,105,.7)}}
.cico{width:52px;height:52px;border-radius:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;position:relative}
.household .cico{background:rgba(70,211,105,.1)}.update .cico{background:rgba(245,166,35,.1)}.signin .cico{background:rgba(77,166,255,.1)}.verify .cico{background:rgba(150,100,255,.1)}
.pdot{position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:var(--red);border:2px solid var(--s1);animation:dp 1.5s ease infinite}
@keyframes dp{0%,100%{transform:scale(1)}50%{transform:scale(1.3)}}
.tvscan{position:absolute;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--amber),transparent);animation:sc 2s ease infinite}
@keyframes sc{0%{top:-2px;opacity:0}10%{opacity:1}90%{opacity:1}100%{top:110%;opacity:0}}
.ctype{font-family:var(--m);font-size:.56rem;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px}
.household .ctype{color:var(--green)}.update .ctype{color:var(--amber)}.signin .ctype{color:var(--blue)}.verify .ctype{color:var(--purple)}
.ccode{font-family:var(--h);font-size:3.2rem;letter-spacing:14px;line-height:1;color:var(--text)}
.clink{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-size:.82rem;font-weight:500;border:1px solid;border-radius:8px;padding:10px 18px;margin-top:6px;transition:all .2s}
.clink.g{color:var(--green);border-color:rgba(70,211,105,.25)}.clink.g:hover{background:rgba(70,211,105,.08)}
.clink.a{color:var(--amber);border-color:rgba(245,166,35,.25)}.clink.a:hover{background:rgba(245,166,35,.08)}
.cmeta{display:flex;align-items:center;gap:.7rem;margin-top:6px}
.ctime{font-family:var(--m);font-size:.58rem;color:var(--muted2)}
.ccd{font-family:var(--m);font-size:.6rem}
.cd-ok{color:var(--green)}.cd-warn{color:var(--amber)}.cd-exp{color:var(--red)}
.cflip{animation:cf .15s ease}
@keyframes cf{0%{opacity:0;transform:translateY(-3px)}100%{opacity:1;transform:none}}
.cpbtn{background:var(--s3);border:1px solid var(--s5);color:var(--muted2);padding:10px 16px;border-radius:9px;cursor:pointer;font-family:var(--m);font-size:.62rem;letter-spacing:1px;text-transform:uppercase;transition:all .2s;white-space:nowrap;flex-shrink:0}
.cpbtn:hover{border-color:var(--border2);color:var(--text)}
.cpbtn.ok{border-color:var(--green)!important;color:var(--green)!important;background:rgba(70,211,105,.07)!important}

/* RENEWAL */
.rpopup{display:none;opacity:0;transition:opacity .4s;background:rgba(245,166,35,.06);border:1px solid rgba(245,166,35,.2);border-radius:12px;padding:1rem 1.2rem;margin-bottom:.9rem;align-items:center;gap:.9rem}

/* EMPTY */
.empty{text-align:center;padding:3rem 1rem}
.empty svg{opacity:.15;margin-bottom:.8rem}
.empty h3{font-family:var(--h);font-size:1.2rem;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:.5rem}
.empty p{font-size:.8rem;color:var(--muted2);line-height:1.8}

/* EXPIRED/ERROR */
.ewrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:70vh;padding:2rem;text-align:center}
.elogo{font-family:var(--h);font-size:2rem;letter-spacing:3px;margin-bottom:2rem}
.elogo .f{color:var(--red)}.elogo .l{color:var(--muted2)}
.ebox{background:var(--s1);border:1px solid rgba(229,9,20,.2);border-radius:20px;padding:2.5rem 2rem;max-width:360px;width:100%}
.etitle{font-family:var(--h);font-size:1.7rem;letter-spacing:2px;color:var(--red);margin-bottom:.5rem;text-transform:uppercase}
.emsg{font-size:.85rem;color:var(--muted);line-height:1.8;margin-bottom:1.8rem}
.wabig{display:inline-flex;align-items:center;gap:10px;background:#25D366;color:#000;padding:13px 26px;border-radius:10px;text-decoration:none;font-weight:700;font-size:.9rem;transition:all .25s}
.wabig:hover{background:#1ebe5d;transform:translateY(-2px)}

/* SK */
.sk{background:linear-gradient(90deg,var(--s3) 25%,var(--s4) 50%,var(--s3) 75%);background-size:200% 100%;animation:sh 1.5s infinite;border-radius:10px}
@keyframes sh{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* WA FLOAT */
.waf{position:fixed;bottom:1.4rem;right:1.4rem;z-index:200;width:52px;height:52px;border-radius:50%;background:#25D366;display:flex;align-items:center;justify-content:center;text-decoration:none;box-shadow:0 4px 20px rgba(37,211,102,.4)}

/* COPY OVERLAY */
.covl{position:fixed;inset:0;z-index:500;display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0;transition:opacity .25s}
.covl.show{opacity:1}
.cbox{background:rgba(0,0,0,.92);border:1px solid rgba(70,211,105,.3);border-radius:20px;padding:1.8rem 2.5rem;display:flex;flex-direction:column;align-items:center;gap:.7rem;backdrop-filter:blur(20px);transform:scale(.8);transition:transform .35s cubic-bezier(.34,1.56,.64,1)}
.covl.show .cbox{transform:scale(1)}
.ccheck{width:52px;height:52px;border-radius:50%;background:var(--green);display:flex;align-items:center;justify-content:center}
.clbl{font-family:var(--h);font-size:1.1rem;letter-spacing:3px;color:var(--text);text-transform:uppercase}

#toast{position:fixed;bottom:1.8rem;left:50%;transform:translateX(-50%) translateY(20px);background:var(--green);color:#000;font-family:var(--h);font-size:.88rem;padding:10px 24px;border-radius:6px;letter-spacing:3px;opacity:0;transition:all .3s cubic-bezier(.34,1.56,.64,1);pointer-events:none;z-index:999;white-space:nowrap;text-transform:uppercase}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

@keyframes fu{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="prog" id="prog"><div class="pb" id="pb"></div></div>

<nav>
  <div class="logo"><span class="f">FAN</span><span class="l">FLIX</span></div>
  <div class="nav-avatar" id="nav-avatar">?</div>
</nav>

<div id="page">
  <div class="page">
    <div style="height:160px;border-radius:18px;margin-bottom:.9rem" class="sk"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.7rem;margin-bottom:.7rem">
      <div style="height:90px;border-radius:14px" class="sk"></div>
      <div style="height:90px;border-radius:14px" class="sk"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.7rem;margin-bottom:.9rem">
      <div style="height:90px;border-radius:14px" class="sk"></div>
      <div style="height:90px;border-radius:14px" class="sk"></div>
    </div>
    <div style="height:80px;border-radius:16px;margin-bottom:.9rem" class="sk"></div>
  </div>
</div>

<div class="covl" id="covl">
  <div class="cbox">
    <div class="ccheck"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg></div>
    <div class="clbl">Copied!</div>
  </div>
</div>

<a class="waf" href="https://wa.me/8801928382918" target="_blank">
  <svg width="26" height="26" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
</a>
<div id="toast"></div>

<script>
let allCodes=[],curTab='all',pinShown=false,actLog=[],refTimer=null,cdTimer=null;
const BLOCKED=['2023','2024','2025','2026','2027','2028','0000'];

window.onload=()=>{
  const token=window.location.pathname.match(/\/c\/([a-zA-Z0-9]+)/)?.[1];
  if(!token){showError('invalid','Invalid link.');return;}
  window._tok=token;
  sp();
  fetchCodes(token);
};

function sp(){document.getElementById('prog').classList.add('on')}
function ep(){
  const p=document.getElementById('prog');p.classList.remove('on');
  const b=document.getElementById('pb');b.style.width='100%';
  setTimeout(()=>{b.style.width='0';},400);
}

async function fetchCodes(token,isRefresh=false){
  if(isRefresh){sp();const r=document.getElementById('rbtn-ico');if(r)r.classList.add('spinning');}
  try{
    const res=await fetch(`/api/link/${token}`);
    const data=await res.json();
    ep();
    const r=document.getElementById('rbtn-ico');if(r)r.classList.remove('spinning');
    if(!data.success){
      if(data.error==='expired')showExpired();
      else showError(data.error,data.message);
      return;
    }
    const now=Date.now();
    data.codes=data.codes.filter(c=>{
      if(c.code&&BLOCKED.includes(c.code))return false;
      if(c.expiresAt&&c.expiresAt<now)return false;
      return true;
    });
    const seen=new Set();
    data.codes=data.codes.filter(c=>{const k=c.code||c.link;if(seen.has(k))return false;seen.add(k);return true;});
    allCodes=data.codes;
    window._ld=data;
    if(!isRefresh){buildPage(data);addAct('green','Ready','System is active');}
    else{
      updateCodes(data);
      if(data.codes.length>0){addAct('green',`${data.codes.length} code(s) found`,'Codes ready to copy');playBeep();}
    }
    if(refTimer)clearInterval(refTimer);
    refTimer=setInterval(()=>fetchCodes(token,true),60*1000);
    if(cdTimer)clearInterval(cdTimer);
    cdTimer=setInterval(tickCd,1000);
    if(data.daysLeft<=3&&data.daysLeft>0){
      setTimeout(()=>{const p=document.getElementById('rpopup');if(p){p.style.display='flex';setTimeout(()=>p.style.opacity='1',50);}},1500);
    }
  }catch(e){
    ep();
    const r=document.getElementById('rbtn-ico');if(r)r.classList.remove('spinning');
    if(!isRefresh)showError('error','Could not connect.');
  }
}

function buildPage(data){
  const days=data.daysLeft||0;
  const totalDays=data.totalDays||28;
  const sc=days<=0?'danger':days<=3?'warning':'active';
  const stitle=days<=0?'Account Expired':days<=3?'Expiring Soon':'Account Active';
  const ssub=days<=0?'Please renew your subscription.':days<=3?`Only ${days} days remaining — renew now!`:'Your account is in good standing.';
  const pct=Math.min(100,Math.max(0,(days/totalDays)*100));
  const pcls=days<=3?'red':days<=7?'amber':'green';
  const expDate=new Date(Date.now()+days*24*60*60*1000);
  const expStr=expDate.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  const pLetter=(data.profile||'?').replace('Profile ','').trim().charAt(0)||'?';
  const h=allCodes.filter(c=>c.type==='household').length;
  const u=allCodes.filter(c=>c.type==='update').length;
  const s=allCodes.filter(c=>c.type==='signin').length;
  const v=allCodes.filter(c=>c.type==='verify').length;
  const now=new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});

  const av=document.getElementById('nav-avatar');if(av)av.textContent=pLetter;

  document.getElementById('page').innerHTML=`
  <div class="page">

    <!-- STATUS CARD -->
    <div class="scard ${sc}">
      <div class="scard-top">
        <div class="netflix-n">N</div>
        <div class="scard-mid">
          <div class="stitle"><span class="sdot"></span>${stitle}</div>
          <div class="ssub">${ssub}</div>
        </div>
        ${days>0?`<div class="days-block"><div class="days-num">${days}</div><div class="days-lbl">Days Left</div></div>`:''}
      </div>
      <div class="scard-prog">
        <div class="prog-labels"><span>${days} days remaining</span><span>${Math.round(pct)}%</span></div>
        <div class="prog-track"><div class="prog-fill ${pcls}" style="width:${pct}%"></div></div>
      </div>
    </div>

    <!-- ROW 1: Email + Profile -->
    <div class="igrid">
      <div class="icell full" style="grid-column:1/-1">
        <div class="iico red"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E50914" stroke-width="2" stroke-linecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></div>
        <div style="min-width:0;overflow:hidden">
          <div class="ilbl">Netflix Email</div>
          <div class="ival" style="font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(data.email)}</div>
          <button class="copy-btn" onclick="doCopy('${esc(data.email)}',null,false)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Email</button>
        </div>
      </div>
    </div>

    <!-- ROW 2: Profile + PIN -->
    <div class="igrid">
      <div class="icell">
        <div class="iico blue"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
        <div><div class="ilbl">Profile</div><div class="ival">${esc(data.profile||'-')}</div></div>
      </div>
      <div class="icell">
        <div class="iico amber"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f5a623" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
        <div><div class="ilbl">PIN</div>
          <div class="pin-row">
            <span class="ival" id="pin-display">••••</span>
            <button class="eye-btn" onclick="togglePin()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
          </div>
        </div>
      </div>
    </div>

    <!-- ROW 3: Account Status + Device Status -->
    <div class="igrid">
      <div class="icell">
        <div class="iico green"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#46d369" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg></div>
        <div><div class="ilbl">Account Status</div><div class="ival green">Active</div></div>
      </div>
      <div class="icell">
        <div class="iico grey"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div>
        <div><div class="ilbl">Device Status</div><div class="ival green">Active</div><div class="isub">2 Logins Allowed</div></div>
      </div>
    </div>

    <!-- ROW 4: Membership full width -->
    <div class="igrid" style="margin-bottom:.9rem">
      <div class="icell" style="grid-column:1/-1">
        <div class="iico purple"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9664ff" stroke-width="2" stroke-linecap="round"><path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z"/></svg></div>
        <div><div class="ilbl">Membership</div><div class="ival">Premium</div><div class="isub">Renews ${expStr}</div></div>
      </div>
    </div>

    <!-- RENEWAL POPUP -->
    <div class="rpopup" id="rpopup">
      <div style="width:34px;height:34px;border-radius:9px;background:rgba(245,166,35,.15);display:flex;align-items:center;justify-content:center;flex-shrink:0"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#f5a623" stroke-width="2.5" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
      <div style="flex:1"><div style="font-size:.84rem;font-weight:600;color:var(--amber)">Expiring in ${days} day${days!==1?'s':''}!</div><div style="font-size:.72rem;color:var(--muted);margin-top:2px">Contact FanFlix BD to renew.</div></div>
      <a href="https://wa.me/8801928382918" target="_blank" style="background:#25D366;color:#000;padding:8px 16px;border-radius:7px;text-decoration:none;font-weight:700;font-size:.76rem;white-space:nowrap">Renew</a>
    </div>

    <!-- REFRESH BTN -->
    <button class="rbtn" id="rbtn" onclick="doRefresh()">
      <div class="rbtn-ico-wrap">
        <svg id="rbtn-ico" class="rbtn-ico" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      </div>
      <div class="rbtn-text">
        <span class="rbtn-title">Refresh Codes</span>
        <span class="rbtn-sub">Scan inbox and get new codes</span>
      </div>
      <div class="rbtn-arrow"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
    </button>

    <!-- LIVE ACTIVITY -->
    <div class="acard">
      <div class="ahead">
        <div class="atitle"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#E50914" stroke-width="2.5" stroke-linecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Live Activity</div>
        <div class="aright"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
      </div>
      <div class="alist" id="alist">
        <div class="aitem"><div class="adot green"></div><div class="atime">${now}</div><div><div class="atxt">Ready</div><div class="asub">System is active</div></div></div>
      </div>
    </div>

    <!-- CODES -->
    <div class="cwrap">
      <div class="cheader">
        <div class="ctitle">Your Codes</div>
        <span class="cbadge" id="cbadge">${allCodes.length}</span>
      </div>
      <div class="tabs">
        <button class="tab a-all" id="tab-all" onclick="switchTab('all')">All <span class="tc">${allCodes.length}</span></button>
        <button class="tab" id="tab-household" onclick="switchTab('household')">Household <span class="tc">${h}</span></button>
        <button class="tab" id="tab-update" onclick="switchTab('update')">TV Update <span class="tc">${u}</span></button>
        ${s>0?`<button class="tab" id="tab-signin" onclick="switchTab('signin')">Sign-in <span class="tc">${s}</span></button>`:''}
        ${v>0?`<button class="tab" id="tab-verify" onclick="switchTab('verify')">Verify <span class="tc">${v}</span></button>`:''}
      </div>
      <div class="cards" id="cards"></div>
    </div>

  </div>`;
  renderCards();
}

function doRefresh(){
  const b=document.getElementById('rbtn');if(b)b.disabled=true;
  fetchCodes(window._tok,true).finally(()=>{const b=document.getElementById('rbtn');if(b)b.disabled=false;});
}

function updateCodes(data){
  allCodes=data.codes;
  const h=allCodes.filter(c=>c.type==='household').length;
  const u=allCodes.filter(c=>c.type==='update').length;
  const s=allCodes.filter(c=>c.type==='signin').length;
  const v=allCodes.filter(c=>c.type==='verify').length;
  const se=(id,v)=>{const e=document.getElementById(id);if(e)e.innerHTML=v;};
  se('cbadge',allCodes.length);
  se('tab-all',`All <span class="tc">${allCodes.length}</span>`);
  se('tab-household',`Household <span class="tc">${h}</span>`);
  se('tab-update',`TV Update <span class="tc">${u}</span>`);
  renderCards(true);
}

function addAct(cls,title,sub){
  const now=new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
  actLog.unshift({cls,title,sub,time:now});
  if(actLog.length>3)actLog=actLog.slice(0,3);
  const l=document.getElementById('alist');if(!l)return;
  l.innerHTML=actLog.map(a=>`<div class="aitem"><div class="adot ${a.cls}"></div><div class="atime">${a.time}</div><div><div class="atxt">${a.title}</div><div class="asub">${a.sub}</div></div></div>`).join('');
}

function togglePin(){
  pinShown=!pinShown;
  const d=document.getElementById('pin-display');
  if(d)d.textContent=pinShown?(window._ld?.pin||'----'):'••••';
}

function switchTab(t){
  curTab=t;
  document.querySelectorAll('.tab').forEach(x=>x.className='tab');
  const el=document.getElementById('tab-'+t);if(el)el.classList.add('tab','a-'+t);
  renderCards();
}

function renderCards(smooth=false){
  const list=curTab==='all'?allCodes:allCodes.filter(i=>i.type===curTab);
  const c=document.getElementById('cards');if(!c)return;
  if(!list.length){
    c.innerHTML=`<div class="empty"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg><h3>No Codes Found</h3><p>No Netflix codes in the last 20 minutes.<br>Request a code on your device,<br>then tap <strong>Refresh Codes</strong>.</p></div>`;
    return;
  }
  const html=list.map((item,i)=>cardHtml(item,i)).join('');
  if(smooth){c.style.opacity='0';c.style.transition='opacity .2s';setTimeout(()=>{c.innerHTML=html;c.style.opacity='1';attachL();},180);}
  else{c.innerHTML=html;attachL();}
}

function attachL(){
  document.querySelectorAll('.card[data-code]').forEach(c=>{
    c.addEventListener('click',()=>doCopy(c.dataset.code,null,true));
  });
}

function cardHtml(item,i){
  const delay=`animation-delay:${i*.07}s`;
  const fresh=(Date.now()-item.ts)<10*60*1000;
  const fc=fresh?' fresh':'';
  const fb=fresh?'<span class="fbadge">Fresh</span>':'';
  const cd=item.expiresAt?`<span class="ccd" data-exp="${item.expiresAt}">${fmtCd(item.expiresAt)}</span>`:'';
  const rt=item.ts?new Date(item.ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}):'';
  const tt=rt?`<span class="ctime">${rt}</span>`:'';
  const pIco=`<div class="cico"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#46d369" stroke-width="2.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.5" stroke-linecap="round"/></svg><div class="pdot"></div></div>`;
  const tvIco=`<div class="cico" style="position:relative"><svg width="28" height="22" viewBox="0 0 24 20" fill="none" stroke="#f5a623" stroke-width="2"><rect x="1" y="1" width="22" height="14" rx="2"/><line x1="8" y1="18" x2="16" y2="18"/><line x1="12" y1="15" x2="12" y2="18"/></svg><div style="position:absolute;inset:4px 5px 6px;background:rgba(245,166,35,.1);overflow:hidden;border-radius:2px"><div class="tvscan"></div></div></div>`;
  const lIco=`<div class="cico"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>`;
  if(item.type==='update')return`<div class="card update${fc}" style="${delay}">${fb}${tvIco}<div style="min-width:0"><div class="ctype">TV Household Update</div><a class="clink a" href="${esc(item.link)}" target="_blank">Update Household →</a><div class="cmeta">${tt}</div></div><button class="cpbtn" onclick="event.stopPropagation();doCopy('${esc(item.link)}',this,false)">Copy</button></div>`;
  const vIco=`<div class="cico"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9664ff" stroke-width="2.5" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg></div>`;
  if(item.type==='verify')return`<div class="card verify${fc}" style="${delay}" data-code="${esc(item.code)}">${fb}${vIco}<div style="min-width:0"><div class="ctype">Verification Code</div><div class="ccode" style="font-size:2.6rem;letter-spacing:10px">${item.code}</div><div class="cmeta">${tt}${cd}</div></div><button class="cpbtn" onclick="event.stopPropagation();doCopy('${esc(item.code)}',this,false)">Copy</button></div>`;
  if(item.type==='signin')return`<div class="card signin${fc}"` style="${delay}" data-code="${esc(item.code)}">${fb}${lIco}<div style="min-width:0"><div class="ctype">Sign-in Code</div><div class="ccode">${item.code}</div><div class="cmeta">${tt}${cd}</div></div><button class="cpbtn" onclick="event.stopPropagation();doCopy('${esc(item.code)}',this,false)">Copy</button></div>`;
  if(item.code)return`<div class="card household${fc}" style="${delay}" data-code="${esc(item.code)}">${fb}${pIco}<div style="min-width:0"><div class="ctype">Temporary Access Code</div><div class="ccode">${item.code}</div><div class="cmeta">${tt}${cd}</div></div><button class="cpbtn" onclick="event.stopPropagation();doCopy('${esc(item.code)}',this,false)">Copy</button></div>`;
  return`<div class="card household${fc}" style="${delay}">${fb}${pIco}<div style="min-width:0"><div class="ctype">Temporary Access Code</div><a class="clink g" href="${esc(item.link)}" target="_blank">Get Code →</a><div class="cmeta">${tt}</div></div><button class="cpbtn" onclick="event.stopPropagation();doCopy('${esc(item.link)}',this,false)">Copy</button></div>`;
}

function showExpired(){document.getElementById('page').innerHTML=`<div class="ewrap"><div class="elogo"><span class="f">FAN</span><span class="l">FLIX</span></div><div class="ebox"><div class="etitle">Subscription Expired</div><div class="emsg">Your FanFlix subscription has expired.<br>Contact us to renew and keep watching.</div><a class="wabig" href="https://wa.me/8801928382918" target="_blank">Contact FanFlix BD</a></div></div>`;}
function showError(type,msg){document.getElementById('page').innerHTML=`<div class="ewrap"><div class="elogo"><span class="f">FAN</span><span class="l">FLIX</span></div><div class="ebox"><div class="etitle">${type==='revoked'?'Access Revoked':'Error'}</div><div class="emsg">${msg||'Could not connect.'}</div><a class="wabig" href="https://wa.me/8801928382918" target="_blank">Contact FanFlix BD</a></div></div>`;}

function fmtCd(exp){
  const r=exp-Date.now();
  if(r<=0)return`<span class="cd-exp">Expired</span>`;
  const m=Math.floor(r/60000),s=Math.floor((r%60000)/1000);
  return`<span class="${r<2*60*1000?'cd-warn':'cd-ok'}" data-exp="${exp}"><span class="ct">${m}:${s.toString().padStart(2,'0')}</span></span>`;
}

function tickCd(){
  document.querySelectorAll('[data-exp]').forEach(el=>{
    const exp=parseInt(el.dataset.exp);if(!exp||isNaN(exp))return;
    const r=exp-Date.now();
    if(r<=0){el.className='cd-exp';el.textContent='Expired';return;}
    if(r<2*60*1000)playBeep();
    const m=Math.floor(r/60000),s=Math.floor((r%60000)/1000);
    el.className=r<2*60*1000?'ccd cd-warn':'ccd cd-ok';
    const t=el.querySelector('.ct');const nv=`${m}:${s.toString().padStart(2,'0')}`;
    if(t&&t.textContent!==nv){t.classList.add('cflip');t.textContent=nv;setTimeout(()=>t.classList.remove('cflip'),150);}
  });
}

function doCopy(text,btn,overlay){
  navigator.clipboard.writeText(text).then(()=>{
    if(btn){btn.textContent='Copied';btn.classList.add('ok');setTimeout(()=>{btn.textContent='Copy';btn.classList.remove('ok');},2000);}
    if(overlay){const o=document.getElementById('covl');o.classList.add('show');setTimeout(()=>o.classList.remove('show'),1200);}
    showToast('Copied!');
  });
}

function playBeep(){try{const ctx=new(window.AudioContext||window.webkitAudioContext)();const o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=880;g.gain.setValueAtTime(.3,ctx.currentTime);g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.3);o.start();o.stop(ctx.currentTime+.3);}catch(e){}}
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1800);}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
</script>
</body>
</html>
