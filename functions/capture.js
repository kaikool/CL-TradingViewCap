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
  // Trả về binary PNG để /function có thể trả trực tiếp hoặc bọc JSON tùy cấu hình
  return { data: buf, type: "image/png" };
}
  `.trim();
}

async function fetchTO(url, opts={}, ms=60000){
  const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort("timeout"),ms);
  try{ return await fetch(url,{...opts,signal:ctl.signal}); } finally { clearTimeout(t); }
}

// Cloudinary signed upload (HMAC-SHA1)
async function uploadCloudinarySigned(fileBlob, publicId) {
  const ts = Math.floor(Date.now() / 1000);

  // 1) string_to_sign: các tham số (không rỗng) theo thứ tự alpha & nối bằng '&'
  // Ở đây ta chỉ dùng: public_id, timestamp
  const paramString = `public_id=${publicId}&timestamp=${ts}`;

  // 2) signature = SHA1(paramString + API_SECRET)  <-- KHÔNG dùng HMAC
  const enc = new TextEncoder();
  const data = enc.encode(paramString + CLOUDINARY_API_SECRET);
  const digest = await crypto.subtle.digest("SHA-1", data);
  const signature = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");

  // 3) POST lên Cloudinary
  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  const form = new FormData();
  form.append("file", fileBlob, `${publicId}.png`);
  form.append("public_id", publicId);         // nếu muốn vào folder, đặt public_id = "tradingview/..."
  form.append("api_key", CLOUDINARY_API_KEY);
  form.append("timestamp", String(ts));
  form.append("signature", signature);

  const resp = await fetch(endpoint, { method: "POST", body: form });
  if (!resp.ok) throw new Error(`Cloudinary upload failed: ${resp.status} ${await resp.text()}`);
  return await resp.json();
}

export const onRequestGet = async ({ request }) => {
  const url = new URL(request.url);

  // Không có query => health
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

  // ---- XỬ LÝ CẢ 2 KIỂU PHẢN HỒI: binary PNG hoặc JSON bọc Buffer/base64 ----
  const ct = (r.headers.get("content-type")||"").toLowerCase();

  let pngArrayBuffer;

  if (ct.includes("image/png") || ct.includes("application/octet-stream")) {
    // Upstream trả nhị phân trực tiếp
    pngArrayBuffer = await r.arrayBuffer();

  } else if (ct.includes("application/json")) {
    const text = await r.text();
    if (isRateLimitErrorMessage(text)) return rateLimited(text);

    let obj;
    try { obj = JSON.parse(text); }
    catch { return J({ ok:false, error:"Upstream JSON parse failed", detail: text.slice(0,400) }, 502); }

    // Các biến thể phổ biến:
    // 1) { data: { type:"Buffer", data:[...bytes] }, type:"image/png" }
    // 2) { data: "<base64>", type:"image/png", encoding:"base64" }
    // 3) { body: { data:{type:"Buffer", data:[...]}, ... } }
    let bytes = null;

    if (obj?.data?.type === "Buffer" && Array.isArray(obj?.data?.data)) {
      bytes = new Uint8Array(obj.data.data);
    } else if (typeof obj?.data === "string" && (obj?.encoding === "base64" || /^[A-Za-z0-9+/=]+$/.test(obj.data))) {
      // decode base64 -> Uint8Array
      const b64 = obj.data;
      const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      bytes = bin;
    } else if (obj?.body?.data?.type === "Buffer" && Array.isArray(obj?.body?.data?.data)) {
      bytes = new Uint8Array(obj.body.data.data);
    }

    if (!bytes) {
      return J({ ok:false, error:"Unsupported upstream JSON shape", sample: Object.keys(obj).slice(0,6) }, 502);
    }

    pngArrayBuffer = bytes.buffer;

  } else {
    // Content-Type lạ → trả về để debug
    const t = await r.text();
    if (isRateLimitErrorMessage(t)) return rateLimited(t);
    return J({ ok:false, error:"Unexpected upstream content-type", detail: t.slice(0,400) }, 502);
  }

  // ---- Upload Cloudinary ----
  const blob = new Blob([pngArrayBuffer], { type:"image/png" });
  const publicId = fmtName(ticker, tf, "Asia/Bangkok");

  let up;
  try { up = await uploadCloudinarySigned(blob, publicId); }
  catch (e) { return J({ ok:false, error:e?.message||"Cloudinary upload failed" }, 502); }

  return J({ ok:true, url:up.secure_url, public_id:up.public_id, width:up.width, height:up.height, bytes:up.bytes });
};
