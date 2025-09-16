// ===== HARD-CODE =====
const BROWSERLESS_TOKEN   = "2T3pecgTuZd5bOCc222501c80fb1028904a85a373f3163dcd";
const BROWSERLESS_REGION  = "production-sfo";
const TV_SESSIONID        = "o1hixcbxh1cvz59ri1u6d9juggsv9jko";
const CHART_ID            = "fCLTltqk";
const DEFAULT_TICKER      = "OANDA:XAUUSD";

const CLOUDINARY_CLOUD_NAME = "dxi9ensjq";
const CLOUDINARY_API_KEY    = "784331526282828";
const CLOUDINARY_API_SECRET = "9rbzDsR-tj87ao_NfDeX3lBoWPE";
// ======================

const TF_MAP = { M1:"1",M3:"3",M5:"5",M15:"15",M30:"30", H1:"60",H2:"120",H4:"240", D:"D",W:"W",MN:"M" };

function clamp(v, min, max, d) {
  const n = Number.parseInt(v ?? d, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
}
function isRateLimitErrorMessage(msg) {
  const m = (msg || "").toLowerCase();
  return m.includes("429") || m.includes("too many requests") || m.includes("rate limit") || m.includes("unexpected server response: 429");
}
function J(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store", ...extra },
  });
}
function rateLimited(detail, retryAfterSec = 60) {
  return J({ ok:false, error:"Rate limited upstream", detail: detail || "Too Many Requests" }, 429, { "Retry-After": String(retryAfterSec) });
}
function fmtName(ticker, tf, tz = "Asia/Bangkok") {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year:"2-digit", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false,
  }).formatToParts(new Date()).reduce((a,part)=>(a[part.type]=part.value,a),{});
  const symbol = ticker.includes(":") ? ticker.split(":")[1] : ticker;
  return `${p.day}${p.month}${p.year}_${p.hour}${p.minute}_${symbol}_${tf.toUpperCase()}`;
}

function buildBLCode() {
  return `
export default async function ({ page, context }) {
  const TF_MAP={M1:"1",M3:"3",M5:"5",M15:"15",M30:"30",H1:"60",H2:"120",H4:"240",D:"D",W:"W",MN:"M"};
  const interval=TF_MAP[context.tf]||"60";
  const chartUrl=\`https://www.tradingview.com/chart/\${context.chartId}/?symbol=\${encodeURIComponent(context.ticker)}&interval=\${interval}\`;
  async function setCookieAndPrime(){
    await page.goto("https://www.tradingview.com",{waitUntil:"domcontentloaded"});
    await page.setCookie({name:"sessionid",value:context.sessionId,domain:".tradingview.com",path:"/",httpOnly:true,secure:true,sameSite:"Lax"});
    await page.goto("https://www.tradingview.com",{waitUntil:"domcontentloaded"});
  }
  async function focusChart(){
    const sels=["canvas[data-name='pane']","div[data-name='pane'] canvas","div[class*='chart-container'] canvas","canvas","body"];
    for(const sel of sels){const h=await page.$(sel);if(h){try{await h.click();}catch{} return;}}
  }
  async function setTimeframeHotkey(){
    await focusChart();
    if(["D","W","M"].includes(interval)){await page.keyboard.press(interval);}
    else{for(const ch of interval) await page.keyboard.type(ch); await page.keyboard.press("Enter");}
  }
  async function findChartContainer(){
    const sels=["div[class*='chart-container']","[data-name='pane']","div[data-name='pane']","div[class*='chart-markup']"];
    for(const sel of sels){const h=await page.$(sel); if(h) return h;}
    return await page.$("canvas[data-name='pane']")||await page.$("canvas");
  }
  async function screenshotChartRegion(){
    const el=await findChartContainer(); if(!el) return null;
    await el.evaluate(e=>e.scrollIntoView({block:"center",inline:"center"}));
    const box=await el.boundingBox(); if(!box) return null;
    const pad=2, clip={x:Math.max(0,box.x-pad),y:Math.max(0,box.y-pad),width:Math.max(1,box.width+pad*2),height:Math.max(1,box.height+pad*2)};
    return await page.screenshot({type:"png",clip});
  }
  await page.setViewport({width:Number(context.w),height:Number(context.h),deviceScaleFactor:2});
  try{await setCookieAndPrime();}catch(e){}
  try{await page.goto(chartUrl,{waitUntil:"networkidle2",timeout:30000});}
  catch(e){ if((e?.message||"").toLowerCase().includes("429")){throw new Error("Unexpected server response: 429");}
    await page.goto(chartUrl,{waitUntil:"domcontentloaded",timeout:30000});
  }
  await setTimeframeHotkey(); await new Promise(r=>setTimeout(r,800));
  await page.addStyleTag({content:\`.layout__area--left,.drawingToolbar,.tv-floating-toolbar,[class*="drawingToolbar"],[class*="left-toolbar"]{display:none !important;}\`});
  await focusChart();
  for(let i=0;i<50;i++){try{await page.keyboard.press("ArrowRight");}catch{} await new Promise(r=>setTimeout(r,10));}
  try{const el=await findChartContainer(); const box=el&&await el.boundingBox(); if(box){await page.mouse.move(box.x+box.width+8,box.y+8);} else {await page.mouse.move(0,0);} }catch{}
  const buf=(await screenshotChartRegion())||await page.screenshot({type:"png",fullPage:true});
  return { data: buf, type: "image/png" };
}
  `.trim();
}

async function fetchTO(url, opts={}, ms=60000){
  const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort("timeout"),ms);
  try{ return await fetch(url,{...opts,signal:ctl.signal}); } finally { clearTimeout(t); }
}

// Cloudinary signed upload (HMAC-SHA1)
async function uploadCloudinarySigned(blob, publicId) {
  const ts = Math.floor(Date.now()/1000);
  const param = `public_id=${publicId}&timestamp=${ts}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(CLOUDINARY_API_SECRET), {name:"HMAC",hash:"SHA-1"}, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(param));
  const signature = Array.from(new Uint8Array(sigBuf)).map(b=>b.toString(16).padStart(2,"0")).join("");

  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  const form = new FormData();
  form.append("file", blob, `${publicId}.png`);
  form.append("public_id", publicId);
  form.append("api_key", CLOUDINARY_API_KEY);
  form.append("timestamp", String(ts));
  form.append("signature", signature);

  const r = await fetch(endpoint, { method:"POST", body: form });
  if (!r.ok) throw new Error(`Cloudinary upload failed: ${r.status} ${await r.text()}`);
  return await r.json();
}

export const onRequestGet = async ({ request }) => {
  const url = new URL(request.url);

  // Không có query => trả health (như bạn yêu cầu)
  if ([...url.searchParams.keys()].length === 0) {
    return J({ ok: true, time: new Date().toISOString() });
  }

  const tfKey = (url.searchParams.get("tf") || "H1").toUpperCase();
  const tf = TF_MAP[tfKey] ? tfKey : "H1";
  const w = clamp(url.searchParams.get("w"), 640, 2560, 1440);
  const h = clamp(url.searchParams.get("h"), 480, 1440, 900);
  const ticker = (url.searchParams.get("ticker") || DEFAULT_TICKER).trim();

  const fn = `https://${BROWSERLESS_REGION}.browserless.io/function?token=${BROWSERLESS_TOKEN}`;
  const payload = { code: buildBLCode(), context: { tf, ticker, chartId: CHART_ID, sessionId: TV_SESSIONID, w, h } };

  let r;
  try {
    r = await fetchTO(fn, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(payload) }, 60000);
  } catch (e) {
    if ((e+"").includes("timeout")) return J({ ok:false, error:"Upstream timeout calling Browserless" }, 504);
    return J({ ok:false, error:"Upstream error calling Browserless", detail:e?.message||String(e) }, 502);
  }
  if (r.status === 429) return rateLimited("Browserless 429");
  if (!r.ok) {
    const t = await r.text();
    if (isRateLimitErrorMessage(t)) return rateLimited(t);
    return J({ ok:false, error: t || `Upstream error ${r.status}` }, 502);
  }

  const ct = (r.headers.get("content-type")||"").toLowerCase();
  if (!(ct.includes("image/png") || ct.includes("application/octet-stream"))) {
    const t = await r.text();
    if (isRateLimitErrorMessage(t)) return rateLimited(t);
    return J({ ok:false, error:"Unexpected upstream content-type", detail:t }, 502);
  }

  const ab = await r.arrayBuffer();
  const blob = new Blob([ab], { type:"image/png" });
  const publicId = fmtName(ticker, tf, "Asia/Bangkok");

  let up;
  try { up = await uploadCloudinarySigned(blob, publicId); }
  catch (e) { return J({ ok:false, error:e?.message||"Cloudinary upload failed" }, 502); }

  return J({ ok:true, url:up.secure_url, public_id:up.public_id, width:up.width, height:up.height, bytes:up.bytes });
};
