// app.js — Browserless /function (no puppeteer-core in app)
import express from "express";
import cors from "cors";
import { v2 as cloudinary } from "cloudinary";

// ====== HARDCODE ======
const TOKEN              = "2T3pecgTuZd5bOCc222501c80fb1028904a85a373f3163dcd"; // Browserless token
const TV_SESSIONID       = "o1hixcbxh1cvz59ri1u6d9juggsv9jko";                   // TradingView sessionid
const CHART_ID           = "fCLTltqk";
const DEFAULT_TICKER     = "OANDA:XAUUSD";
const BROWSERLESS_REGION = "production-sfo";
const FN_ENDPOINT        = `https://${BROWSERLESS_REGION}.browserless.io/function?token=${TOKEN}`;

// Cloudinary (HARDCODE)
cloudinary.config({
  cloud_name: "dxi9ensjq",
  api_key:    "784331526282828",
  api_secret: "9rbzDsR-tj87ao_NfDeX3lBoWPE",
});

const PORT = process.env.PORT || 8080;

// ==== Map TF ====
const TF_MAP = {
  M1: "1", M3: "3", M5: "5", M15: "15", M30: "30",
  H1: "60", H2: "120", H4: "240",
  D: "D", W: "W", MN: "M",
};

// ==== Helpers ====
function clamp(v, min, max, d) {
  const n = Number.parseInt(v ?? d, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
}
function intervalOf(tfKey) {
  return TF_MAP[(tfKey || "").toUpperCase()] || "60";
}
function formatFilename(ticker, tf) {
  const now = new Date();
  const dd   = String(now.getDate()).padStart(2, "0");
  const mm   = String(now.getMonth() + 1).padStart(2, "0");
  const yy   = String(now.getFullYear()).slice(-2);
  const HH   = String(now.getHours()).padStart(2, "0");
  const MM   = String(now.getMinutes()).padStart(2, "0");
  const symbol = ticker.includes(":") ? ticker.split(":")[1] : ticker;
  return `${dd}${mm}${yy}_${HH}${MM}_${symbol}_${tf.toUpperCase()}`;
}
// Mutex: tuần tự 1 request/lần để tránh 429
let inFlight = false;
const acquire = async () => { while (inFlight) await new Promise(r => setTimeout(r, 150)); inFlight = true; };
const release = () => { inFlight = false; };

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: "*" }));

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---- detect upstream rate-limit
function isRateLimitErrorMessage(msg) {
  const m = (msg || "").toLowerCase();
  return m.includes("429") || m.includes("too many requests") || m.includes("rate limit") || m.includes("unexpected server response: 429");
}
function replyRateLimited(res, detail, retryAfterSec = 60) {
  res.setHeader("Retry-After", String(retryAfterSec));
  return res.status(429).json({ ok:false, error:"Rate limited upstream", detail: detail || "Too Many Requests" });
}

// ==== /capture via Browserless /function ====
app.get("/capture", async (req, res) => {
  const tfKey = (req.query.tf || "H1").toString().toUpperCase();
  const tf    = TF_MAP[tfKey] ? tfKey : "H1";
  const w     = clamp(req.query.w, 640, 2560, 1440);
  const h     = clamp(req.query.h, 480, 1440, 900);
  const raw   = (req.query.ticker ?? "").toString().trim();
  const ticker = raw !== "" ? raw : DEFAULT_TICKER;

  const code = `
    // ESM code executed inside Browserless /function
    export default async function ({ page, context }) {
      const TF_MAP = { M1:"1",M3:"3",M5:"5",M15:"15",M30:"30", H1:"60",H2:"120",H4:"240", D:"D",W:"W",MN:"M" };
      const interval = TF_MAP[context.tf] || "60";
      const chartUrl = \`https://www.tradingview.com/chart/\${context.chartId}/?symbol=\${encodeURIComponent(context.ticker)}&interval=\${interval}\`;

      async function setCookieAndPrime() {
        await page.goto("https://www.tradingview.com", { waitUntil: "domcontentloaded" });
        await page.setCookie({
          name: "sessionid", value: context.sessionId, domain: ".tradingview.com",
          path: "/", httpOnly: true, secure: true, sameSite: "Lax",
        });
        await page.goto("https://www.tradingview.com", { waitUntil: "domcontentloaded" });
      }
      async function focusChart() {
        const sels = ["canvas[data-name='pane']", "div[data-name='pane'] canvas", "div[class*='chart-container'] canvas", "canvas", "body"];
        for (const sel of sels) { const h = await page.$(sel); if (h) { try { await h.click(); } catch {} return; } }
      }
      async function setTimeframeHotkey() {
        await focusChart();
        if (["D","W","M"].includes(interval)) {
          await page.keyboard.press(interval);
        } else {
          for (const ch of interval) await page.keyboard.type(ch);
          await page.keyboard.press("Enter");
        }
      }
      async function findChartContainer() {
        const sels = ["div[class*='chart-container']", "[data-name='pane']", "div[data-name='pane']", "div[class*='chart-markup']"];
        for (const sel of sels) { const h = await page.$(sel); if (h) return h; }
        return await page.$("canvas[data-name='pane']") || await page.$("canvas");
      }
      async function screenshotChartRegion() {
        const el = await findChartContainer();
        if (!el) return null;
        await el.evaluate(e => e.scrollIntoView({ block: "center", inline: "center" }));
        const box = await el.boundingBox();
        if (!box) return null;
        const pad = 2;
        const clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
                       width: Math.max(1, box.width + pad*2), height: Math.max(1, box.height + pad*2) };
        return await page.screenshot({ type: "png", clip });
      }

      await page.setViewport({ width: Number(context.w), height: Number(context.h), deviceScaleFactor: 2 });

      try {
        await setCookieAndPrime();
      } catch (e) {
        // still continue; cookie may not be critical in some cases
      }

      try {
        await page.goto(chartUrl, { waitUntil: "networkidle2", timeout: 30000 });
      } catch (e) {
        // fallback & propagate 429 text up
        if ((e?.message || "").toLowerCase().includes("429")) {
          throw new Error("Unexpected server response: 429");
        }
        await page.goto(chartUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      }

      await setTimeframeHotkey();
      await new Promise(r => setTimeout(r, 800));

      // hide left toolbars
      await page.addStyleTag({ content: \`
        .layout__area--left, .drawingToolbar, .tv-floating-toolbar,
        [class*="drawingToolbar"], [class*="left-toolbar"] { display:none !important; }
      \`});

      // pan 50 candles to the right
      await focusChart();
      for (let i = 0; i < 50; i++) {
        try { await page.keyboard.press("ArrowRight"); } catch {}
        await new Promise(r => setTimeout(r, 10));
      }

      // move mouse to hide crosshair
      try {
        const el = await findChartContainer();
        const box = el && await el.boundingBox();
        if (box) { await page.mouse.move(box.x + box.width + 8, box.y + 8); } else { await page.mouse.move(0, 0); }
      } catch {}

      const buf = (await screenshotChartRegion()) || await page.screenshot({ type: "png", fullPage: true });

      // Return binary PNG so Browserless sets Content-Type: image/png
      return { data: buf, type: "image/png" };
    }
  `;

  try {
    await acquire();

    // POST JSON (so ta truyền context gọn gàng)
    const payload = {
      code,
      context: { tf: tf, ticker, chartId: CHART_ID, sessionId: TV_SESSIONID, w, h }
    };

    const resp = await fetch(FN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (resp.status === 429) {
      release();
      return replyRateLimited(res, "Browserless 429");
    }
    if (!resp.ok) {
      const text = await resp.text();
      release();
      if (isRateLimitErrorMessage(text)) return replyRateLimited(res, text);
      return res.status(500).json({ ok:false, error: text || `Upstream error ${resp.status}` });
    }

    const ctype = (resp.headers.get("content-type") || "").toLowerCase();
    if (!ctype.includes("image/png")) {
      const text = await resp.text();
      release();
      // Trường hợp Browserless trả JSON lỗi
      if (isRateLimitErrorMessage(text)) return replyRateLimited(res, text);
      return res.status(500).json({ ok:false, error: "Unexpected upstream content-type", detail: text });
    }

    // Get PNG buffer
    const ab = await resp.arrayBuffer();
    const buf = Buffer.from(ab);

    const fname = formatFilename(ticker, tf).replace(".png", "");

    // Upload Cloudinary
    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: "image", folder: "tradingview", public_id: fname, overwrite: true, format: "png" },
        (error, result) => error ? reject(error) : resolve(result)
      );
      stream.end(buf);
    });

    release();

    res.json({
      ok: true,
      url: uploaded.secure_url,
      public_id: uploaded.public_id,
      width: uploaded.width,
      height: uploaded.height,
      bytes: uploaded.bytes
    });

  } catch (e) {
    release();
    if (isRateLimitErrorMessage(e?.message)) return replyRateLimited(res, e?.message);
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});
