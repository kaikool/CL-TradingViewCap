f/**
 * Cloudflare Pages Function: /capture  (HARD-CODED)
 * - Gọi Browserless /function để render chart TradingView và chụp PNG
 * - Upload Cloudinary (signed) bằng api_key/api_secret đã hard-code
 * - Trả JSON: { ok, url, public_id, width, height, bytes }
 *
 * NOTE:
 *  - Dùng kèm /functions/_middleware.js để bật CORS (nếu cần)
 *  - Endpoint: GET /capture?ticker=OANDA:XAUUSD&tf=H4&w=1440&h=900
 */

/* ====== HARD-CODE CONSTANTS ====== */
// Browserless / TradingView
const BROWSERLESS_TOKEN   = "2T3pecgTuZd5bOCc222501c80fb1028904a85a373f3163dcd";
const BROWSERLESS_REGION  = "production-sfo";
const TV_SESSIONID        = "o1hixcbxh1cvz59ri1u6d9juggsv9jko";
const CHART_ID            = "fCLTltqk";
const DEFAULT_TICKER      = "OANDA:XAUUSD";

// Cloudinary
const CLOUDINARY_CLOUD_NAME = "dxi9ensjq";
const CLOUDINARY_API_KEY    = "784331526282828";
const CLOUDINARY_API_SECRET = "9rbzDsR-tj87ao_NfDeX3lBoWPE";
/* ================================== */

const TF_MAP = {
  M1: "1", M3: "3", M5: "5", M15: "15", M30: "30",
  H1: "60", H2: "120", H4: "240",
  D: "D", W: "W", MN: "M",
};

function clamp(v, min, max, d) {
  const n = Number.parseInt(v ?? d, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
}
function isRateLimitErrorMessage(msg) {
  const m = (msg || "").toLowerCase();
  return m.includes("429") || m.includes("too many requests") || m.includes("rate limit") || m.includes("unexpected server response: 429");
}
function json(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(extraHeaders || {}),
    },
  });
}
function replyRateLimited(detail, retryAfterSec = 60) {
  return json({ ok: false, error: "Rate limited upstream", detail: detail || "Too Many Requests" }, 429, {
    "Retry-After": String(retryAfterSec),
  });
}
function fmtFilename(ticker, tf, tz = "Asia/Bangkok") {
  const now = new Date();
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "2-digit", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  const dd = p.day, mm = p.month, yy = p.year, HH = p.hour, MM = p.minute;
  const symbol = ticker.includes(":") ? ticker.split(":")[1] : ticker;
  return `${dd}${mm}${yy}_${HH}${MM}_${symbol}_${tf.toUpperCase()}`;
}

function buildBrowserlessCode() {
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
        const el=await findChartContainer();
        if(!el) return null;
        await el.evaluate(e=>e.scrollIntoView({block:"center",inline:"center"}));
        const box=await el.boundingBox();
        if(!box) return null;
        const pad=2, clip={x:Math.max(0,box.x-pad),y:Math.max(0,box.y-pad),width:Math.max(1,box.width+pad*2),height:Math.max(1,box.height+pad*2)};
        return await page.screenshot({type:"png",clip});
      }
      await page.setViewport({width:Number(context.w),height:Number(context.h),deviceScaleFactor:2});
      try{await setCookieAndPrime();}catch(e){}
      try{await page.goto(chartUrl,{waitUntil:"networkidle2",timeout:30000});}
      catch(e){ if((e?.message||"").toLowerCase().includes("429")){throw new Error("Unexpected server response: 429");}
        await page.goto(chartUrl,{waitUntil:"domcontentloaded",timeout:30000});
      }
      await setTimeframeHotkey();
      await new Promise(r=>setTimeout(r,800));
      await page.addStyleTag({content:\`.layout__area--left,.drawingToolbar,.tv-floating-toolbar,[class*="drawingToolbar"],[class*="left-toolbar"]{display:none !important;}\`});
      await focusChart();
      for(let i=0;i<50;i++){try{await page.keyboard.press("ArrowRight");}catch{} await new Promise(r=>setTimeout(r,10));}
      try{const el=await findChartContainer(); const box=el&&await el.boundingBox(); if(box){await page.mouse.move(box.x+box.width+8,box.y+8);} else {await page.mouse.move(0,0);} }catch{}
      const buf=(await screenshotChartRegion())||await page.screenshot({type:"png",fullPage:true});
      return { data: buf, type: "image/png" };
    }
  `.trim();
}

async function fetchWithTimeout(url, opts = {}, ms = 60000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort("timeout"), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// Cloudinary signed upload (không cần preset)
async function uploadCloudinarySigned(fileBlob, publicId) {
  const ts = Math.floor(Date.now() / 1000);

  // params string theo Cloudinary (sorted & concatenated) + api_secret
  const paramString = `public_id=${publicId}&timestamp=${ts}`;
  const toSign = paramString + CLOUDINARY_API_SECRET;

  // HMAC-SHA1
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(CLOUDINARY_API_SECRET),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signatureBuf = await crypto.subtle.sign("HMAC", key, enc.encode(paramString));
  const signatureHex = Array.from(new Uint8Array(signatureBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  const form = new FormData();
  form.append("file", fileBlob, `${publicId}.png`);
  form.append("public_id", publicId);
  form.append("api_key", CLOUDINARY_API_KEY);
  form.append("timestamp", String(ts));
  form.append("signature", signatureHex);

  const resp = await fetch(endpoint, { method: "POST", body: form });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Cloudinary upload failed: ${resp.status} ${t}`);
  }
  return await resp.json();
}

export const onRequestGet = async ({ request }) => {
  const url = new URL(request.url);
  const tfKey = (url.searchParams.get("tf") || "H1").toUpperCase();
  const tf = TF_MAP[tfKey] ? tfKey : "H1";
  const w = clamp(url.searchParams.get("w"), 640, 2560, 1440);
  const h = clamp(url.searchParams.get("h"), 480, 1440, 900);
  const ticker = (url.searchParams.get("ticker") || DEFAULT_TICKER).trim();

  const FN_ENDPOINT = `https://${BROWSERLESS_REGION}.browserless.io/function?token=${BROWSERLESS_TOKEN}`;
  const code = buildBrowserlessCode();

  const payload = {
    code,
    context: { tf, ticker, chartId: CHART_ID, sessionId: TV_SESSIONID, w, h },
  };

  let resp;
  try {
    resp = await fetchWithTimeout(FN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, 60000);
  } catch (e) {
    if ((e + "").includes("timeout")) {
      return json({ ok:false, error:"Upstream timeout calling Browserless" }, 504);
    }
    return json({ ok:false, error:"Upstream error calling Browserless", detail: e?.message || String(e) }, 502);
  }

  if (resp.status === 429) {
    return replyRateLimited("Browserless 429");
  }
  if (!resp.ok) {
    const text = await resp.text();
    if (isRateLimitErrorMessage(text)) return replyRateLimited(text);
    return json({ ok:false, error: text || `Upstream error ${resp.status}` }, 502);
  }

  const ctype = (resp.headers.get("content-type") || "").toLowerCase();
  if (!(ctype.includes("image/png") || ctype.includes("application/octet-stream"))) {
    const text = await resp.text();
    if (isRateLimitErrorMessage(text)) return replyRateLimited(text);
    return json({ ok:false, error:"Unexpected upstream content-type", detail: text }, 502);
  }

  const ab = await resp.arrayBuffer();
  const publicId = fmtFilename(ticker, tf, "Asia/Bangkok");
  const fileBlob = new Blob([ab], { type: "image/png" });

  let uploaded;
  try {
    uploaded = await uploadCloudinarySigned(fileBlob, publicId);
  } catch (e) {
    return json({ ok:false, error: e?.message || "Cloudinary upload failed" }, 502);
  }

  return json({
    ok: true,
    url: uploaded.secure_url,
    public_id: uploaded.public_id,
    width: uploaded.width,
    height: uploaded.height,
    bytes: uploaded.bytes,
  });
};
