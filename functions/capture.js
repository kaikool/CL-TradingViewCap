// app.js — Browserless Function API (không cài puppeteer cục bộ)


import express from "express";
import cors from "cors";

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

const PORT = process.env.PORT || 8080;

// ==== Map TF ====
const TF_MAP = { M1:"1",M3:"3",M5:"5",M15:"15",M30:"30", H1:"60",H2:"120",H4:"240", D:"D",W:"W",MN:"M" };

// ==== Helpers chung ====
function clamp(v, min, max, d) {
  const n = Number.parseInt(v ?? d, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
}
function isRateLimitErrorMessage(msg) {
  const m = (msg || "").toLowerCase();
  return m.includes("429") || m.includes("too many requests") || m.includes("rate limit") || m.includes("unexpected server response: 429");
}
function J(data, status = 200, extra = {}) {
  return {
    status,
    headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store", ...extra },
    body: JSON.stringify(data),
  };
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
async function fetchTO(url, opts={}, ms=120000){ // BL timeout 120s
  const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort("timeout"),ms);
  try{ return await fetch(url,{...opts,signal:ctl.signal}); } finally { clearTimeout(t); }
}

// ==== Hàng đợi tuần tự (semaphore = 1) ====
let queue = Promise.resolve();
function enqueue(job) {
  const run = async () => job().catch(e => { throw e; });
  queue = queue.then(run, run);
  return queue;
}

// ==== Cloudinary signed upload (SHA-1, KHÔNG HMAC) ====
async function uploadCloudinarySigned(uint8Array, publicId) {
  const ts = Math.floor(Date.now() / 1000);
  const paramString = `public_id=${publicId}&timestamp=${ts}`;

  // sha1(paramString + API_SECRET)
  const enc = new TextEncoder();
  const data = enc.encode(paramString + CLOUDINARY_API_SECRET);
  const digest = await crypto.subtle.digest("SHA-1", data);
  const signature = Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");

  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  const form = new FormData();
  form.append("file", new Blob([uint8Array], { type:"image/png" }), `${publicId}.png`);
  form.append("public_id", publicId);
  form.append("api_key", CLOUDINARY_API_KEY);
  form.append("timestamp", String(ts));
  form.append("signature", signature);

  const resp = await fetch(endpoint, { method: "POST", body: form });
  if (!resp.ok) throw new Error(`Cloudinary upload failed: ${resp.status} ${await resp.text()}`);
  return await resp.json();
}

// ==== Browserless Function code builder ====
// Trả về chuỗi code; EVAL sẽ trả về chính function (dòng cuối "handler")
function buildBLCode() {
  return `
async function handler({ page, context }) {
  const TF_MAP={M1:"1",M3:"3",M5:"5",M15:"15",M30:"30",H1:"60",H2:"120",H4:"240",D:"D",W:"W",MN:"M"};
  const interval=TF_MAP[context.tf]||"60";
  const chartUrl=\`https://www.tradingview.com/chart/\${context.chartId}/?symbol=\${encodeURIComponent(context.ticker)}&interval=\${interval}\`;

  // Viewport
  await page.setViewport({width:Number(context.w),height:Number(context.h),deviceScaleFactor:2});

  // Cookie (set 1 lần bằng url, không cần prime 2 lần)
  await page.setCookie({
    name:"sessionid",
    value:context.sessionId,
    url:"https://www.tradingview.com",
    path:"/",
    httpOnly:true,
    secure:true,
    sameSite:"Lax"
  });

  // Vào chart
  try {
    await page.goto(chartUrl,{waitUntil:"networkidle2",timeout:30000});
  } catch (e) {
    if ((e?.message||"").toLowerCase().includes("429")) {
      throw new Error("Unexpected server response: 429");
    }
    await page.goto(chartUrl,{waitUntil:"domcontentloaded",timeout:30000});
  }

  // Ẩn toolbar
  await page.addStyleTag({content:\`.layout__area--left,.drawingToolbar,.tv-floating-toolbar,[class*="drawingToolbar"],[class*="left-toolbar"]{display:none !important;}\`});

  // Focus + TF hotkey
  async function focusChart(){
    const sels=["canvas[data-name='pane']","div[data-name='pane'] canvas","div[class*='chart-container'] canvas","canvas","body"];
    for(const sel of sels){const h=await page.$(sel); if(h){try{await h.click();}catch{} return;}}
  }
  await focusChart();
  if(["D","W","M"].includes(interval)){await page.keyboard.press(interval);}
  else { for(const ch of interval) await page.keyboard.type(ch); await page.keyboard.press("Enter"); }
  await new Promise(r=>setTimeout(r,800));

  // Pan 50 nến
  await focusChart();
  for(let i=0;i<50;i++){ try{await page.keyboard.press("ArrowRight");}catch{} await new Promise(r=>setTimeout(r,10)); }

  // Tìm vùng chart để crop
  async function findChartContainer(){
    const sels=["div[class*='chart-container']","[data-name='pane']","div[data-name='pane']","div[class*='chart-markup']"];
    for(const sel of sels){const h=await page.$(sel); if(h) return h;}
    return await page.$("canvas[data-name='pane']")||await page.$("canvas");
  }
  const el=await findChartContainer();
  let clip=null;
  if(el){
    await el.evaluate(e=>e.scrollIntoView({block:"center",inline:"center"}));
    const box=await el.boundingBox();
    if(box){
      const pad=2;
      clip={x:Math.max(0,box.x-pad),y:Math.max(0,box.y-pad),width:Math.max(1,box.width+pad*2),height:Math.max(1,box.height+pad*2)};
    }
  }

  // Ẩn crosshair
  try{
    if(clip) await page.mouse.move(clip.x+clip.width+8,clip.y+8);
    else await page.mouse.move(0,0);
  }catch{}

  const buf=(clip)
    ? await page.screenshot({type:"png",clip})
    : await page.screenshot({type:"png",fullPage:true});

  // Trả dạng object để /function có thể bọc JSON
  return { data: buf, type: "image/png" };
}
handler
`.trim();
}

// ==== App ====
const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: "*" }));

app.get("/health", (req, res) => {
  const { status, headers, body } = J({ ok: true, time: new Date().toISOString() });
  res.status(status).set(headers).send(body);
});

// GET /capture?ticker=...&tf=H4&w=1440&h=900
app.get("/capture", async (req, res) => {
  const tfKey = (req.query.tf || "H1").toString().toUpperCase();
  const tf = TF_MAP[tfKey] ? tfKey : "H1";
  const w = clamp(req.query.w, 640, 2560, 1440);
  const h = clamp(req.query.h, 480, 1440, 900);
  const ticker = (req.query.ticker ?? DEFAULT_TICKER).toString().trim() || DEFAULT_TICKER;

  try {
    const { status, headers, body } = await enqueue(async () => {
      // ---- Call Browserless (Function API) ----
      const fn = `https://${BROWSERLESS_REGION}.browserless.io/function?token=${BROWSERLESS_TOKEN}`;
      const payload = { code: buildBLCode(), context: { tf, ticker, chartId: CHART_ID, sessionId: TV_SESSIONID, w, h } };

      let r;
      try {
        r = await fetchTO(fn, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(payload) }, 120000);
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

      // ---- Nhận cả binary lẫn JSON ----
      const ct = (r.headers.get("content-type")||"").toLowerCase();
      let pngBytes;

      if (ct.includes("image/png") || ct.includes("application/octet-stream")) {
        const ab = await r.arrayBuffer();
        pngBytes = new Uint8Array(ab);

      } else if (ct.includes("application/json")) {
        const text = await r.text();
        if (isRateLimitErrorMessage(text)) return rateLimited(text);

        let obj;
        try { obj = JSON.parse(text); }
        catch { return J({ ok:false, error:"Upstream JSON parse failed", detail: text.slice(0,400) }, 502); }

        // Hỗ trợ các biến thể:
        // 1) { data: { type:"Buffer", data:[...bytes] }, type:"image/png" }
        // 2) { data: "<base64>", type:"image/png", encoding:"base64" }
        // 3) { body: { data:{type:"Buffer", data:[...]}, ... } }
        if (obj?.data?.type === "Buffer" && Array.isArray(obj?.data?.data)) {
          pngBytes = new Uint8Array(obj.data.data);
        } else if (typeof obj?.data === "string" && (obj?.encoding === "base64" || /^[A-Za-z0-9+/=]+$/.test(obj.data))) {
          const bin = Uint8Array.from(atob(obj.data), c => c.charCodeAt(0));
          pngBytes = bin;
        } else if (obj?.body?.data?.type === "Buffer" && Array.isArray(obj?.body?.data?.data)) {
          pngBytes = new Uint8Array(obj.body.data.data);
        } else {
          return J({ ok:false, error:"Unsupported upstream JSON shape", sample: Object.keys(obj).slice(0,6) }, 502);
        }
      } else {
        const t = await r.text();
        if (isRateLimitErrorMessage(t)) return rateLimited(t);
        return J({ ok:false, error:"Unexpected upstream content-type", detail: t.slice(0,400) }, 502);
      }

      // ---- Upload Cloudinary (signed) ----
      const publicId = fmtName(ticker, tf, "Asia/Bangkok");
      let up;
      try { up = await uploadCloudinarySigned(pngBytes, publicId); }
      catch (e) { return J({ ok:false, error:e?.message||"Cloudinary upload failed" }, 502); }

      // Trả kết quả
      return J({ ok:true, url:up.secure_url, public_id:up.public_id, width:up.width, height:up.height, bytes:up.bytes });
    });

    res.status(status).set(headers).send(body);

  } catch (e) {
    const { status, headers, body } = J({ ok:false, error:e?.message||String(e) }, 500);
    res.status(status).set(headers).send(body);
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});
