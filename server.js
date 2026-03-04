import fs from "fs";
import path from "path";
import http from "http";
import crypto from "crypto";
import express from "express";
import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import WebSocket, { WebSocketServer } from "ws";

// ================== CONFIG ==================
const PORT = Number(process.env.PORT || 3000);

// 무대는 EN+DE 고정
const STAGE_LANGS = ["en", "de"];

// “유럽언어는 EN 기준 / 아시아언어는 KR 기준” 예시
const EU_PIVOT_LANGS = new Set([
  "de","fr","es","it","pt","nl","sv","no","da","fi","pl","cs","sk","hu","ro","bg","el","hr","sl","lt","lv","et"
]);
const ASIA_PIVOT_LANGS = new Set(["ko","ja","zh","zh-cn","zh-tw","th","vi","id","ms"]);

// 프리페치 개수
const PREFETCH_N = Number(process.env.PREFETCH_N || 8);

// 라이브 오버레이 TTL (ms)
const LIVE_TTL_MS = Number(process.env.LIVE_TTL_MS || 6000);

// 번역 provider
// deepl | google | openai | mock
const PROVIDER = (process.env.TRANSLATE_PROVIDER || "mock").toLowerCase();

// ================== LOAD CSV (KR/EN) ==================
const csvPath = path.join(process.cwd(), "subtitles.csv");
if (!fs.existsSync(csvPath)) {
  console.error("ERROR: subtitles.csv not found in project root.");
  process.exit(1);
}

const csvText = fs.readFileSync(csvPath, "utf8");
const records = parse(csvText, { columns: true, skip_empty_lines: true });

/** cueMap: cue_id -> { kr, en } */
const cueMap = new Map();
for (const r of records) {
  const cueId = Number(r.cue_id);
  if (!Number.isFinite(cueId)) continue;
  cueMap.set(cueId, { kr: r.kr ?? "", en: r.en ?? "" });
}
const cueIds = Array.from(cueMap.keys()).sort((a, b) => a - b);
if (cueIds.length === 0) {
  console.error("ERROR: No cues loaded from subtitles.csv");
  process.exit(1);
}

// ================== SQLITE CACHE ==================
const db = new Database(path.join(process.cwd(), "cache.sqlite"));
db.exec(`
  CREATE TABLE IF NOT EXISTS translations (
    cue_id INTEGER NOT NULL,
    lang TEXT NOT NULL,
    source_lang TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (cue_id, lang)
  );
`);

const stmtGet = db.prepare(`SELECT text, source_hash FROM translations WHERE cue_id=? AND lang=?`);
const stmtUpsert = db.prepare(`
  INSERT INTO translations (cue_id, lang, source_lang, source_hash, text, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(cue_id, lang) DO UPDATE SET
    source_lang=excluded.source_lang,
    source_hash=excluded.source_hash,
    text=excluded.text,
    updated_at=excluded.updated_at
`);

// ================== HELPERS ==================
function sha1(s) {
  return crypto.createHash("sha1").update(s, "utf8").digest("hex");
}

function getPivotSource(targetLang, cue) {
  // 유럽언어는 EN 기준이 보통 자연스러움(특히 DE)
  if (EU_PIVOT_LANGS.has(targetLang)) return { sourceLang: "en", sourceText: cue.en };
  // 아시아권은 KR 기준이 의미 보존에 유리한 경우 많음
  if (ASIA_PIVOT_LANGS.has(targetLang)) return { sourceLang: "ko", sourceText: cue.kr };
  // 그 외는 EN 기준으로
  return { sourceLang: "en", sourceText: cue.en };
}

function clampCueIndex(idx) {
  if (idx < 0) return 0;
  if (idx >= cueIds.length) return cueIds.length - 1;
  return idx;
}

// ================== TRANSLATION PROVIDERS ==================
async function translateWithDeepL({ text, sourceLang, targetLang }) {
  const key = process.env.DEEPL_AUTH_KEY;
  if (!key) throw new Error("DEEPL_AUTH_KEY is missing.");

  // Free 키는 api-free, Pro 키는 api
  const isFreeKey = key.endsWith(":fx") || key.includes("free");
  const host = isFreeKey ? "https://api-free.deepl.com" : "https://api.deepl.com";

  // DeepL은 언어 코드가 대문자일 때가 많음 (KO, EN, DE 등)
  const source = sourceLang.toUpperCase();
  const target = targetLang.toUpperCase();

  // NOTE: 2025년 이후 DeepL은 legacy form-body auth_key 방식이 중단됨.
  // 반드시 header-based authentication 사용:
  //   Authorization: DeepL-Auth-Key <KEY>
  const params = new URLSearchParams();
  params.set("text", text);
  params.set("source_lang", source);
  params.set("target_lang", target);

  const res = await fetch(`${host}/v2/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `DeepL-Auth-Key ${key}`,
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepL error: ${res.status} ${body}`);
  }
  const data = await res.json();
  return (data?.translations?.[0]?.text ?? "").toString();
}


async function translateWithGoogle({ text, sourceLang, targetLang }) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) throw new Error("GOOGLE_TRANSLATE_API_KEY is missing.");

  const url = new URL("https://translation.googleapis.com/language/translate/v2");
  url.searchParams.set("key", key);

  const body = {
    q: text,
    source: sourceLang,
    target: targetLang,
    format: "text",
  };

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Google Translate error: ${res.status} ${t}`);
  }

  const data = await res.json();
  // Google은 HTML entity가 들어올 수 있음. 공연용이면 그대로 써도 되지만, 여기서는 간단히 그대로 반환.
  return (data?.data?.translations?.[0]?.translatedText ?? "").toString();
}

async function translateWithOpenAI({ text, sourceLang, targetLang }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is missing.");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const prompt = `Translate the following text from ${sourceLang} to ${targetLang}.
Return only the translated text. Keep it short and natural for theater surtitles.

Text:
${text}`;

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI error: ${res.status} ${t}`);
  }

  const data = await res.json();
  // Responses API: output_text convenience field is sometimes available; otherwise traverse output.
  if (typeof data.output_text === "string") return data.output_text.trim();

  const parts = [];
  for (const item of (data.output || [])) {
    for (const c of (item.content || [])) {
      if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("").trim();
}

async function translateText({ text, sourceLang, targetLang }) {
  if (!text) return "";

  // IMPORTANT: 공연 중엔 번역 API 문제로 서버가 죽으면 안 됨.
  // 그래서 provider 호출은 항상 try/catch로 감싸고, 실패 시 안전하게 fallback.
  try {
    if (PROVIDER === "deepl") return await translateWithDeepL({ text, sourceLang, targetLang });
    if (PROVIDER === "google") return await translateWithGoogle({ text, sourceLang, targetLang });
    if (PROVIDER === "openai") return await translateWithOpenAI({ text, sourceLang, targetLang });
    // mock
    return text;
  } catch (err) {
    console.error("[translateText] provider failed:", err?.message || err);

    // DeepL을 쓰다가 실패하면(지원 언어/요금/일시 장애 등) Google 키가 있으면 자동 fallback
    if (PROVIDER === "deepl" && process.env.GOOGLE_TRANSLATE_API_KEY) {
      try {
        return await translateWithGoogle({ text, sourceLang, targetLang });
      } catch (e2) {
        console.error("[translateText] google fallback failed:", e2?.message || e2);
      }
    }

    // 최후: 원문 그대로 반환 (빈칸/크래시 방지)
    return text;
  }
}


// 캐시 포함 번역
async function getOrTranslateCue(cueId, targetLang) {
  const cue = cueMap.get(cueId);
  if (!cue) return "";

  // KR/EN은 원본으로 바로 제공
  if (targetLang === "ko") return cue.kr;
  if (targetLang === "en") return cue.en;

  const { sourceLang, sourceText } = getPivotSource(targetLang, cue);
  const sourceHash = sha1(`${sourceLang}:${sourceText}`);

  const row = stmtGet.get(cueId, targetLang);
  if (row && row.source_hash === sourceHash) return row.text;

  const translated = await translateText({ text: sourceText, sourceLang, targetLang });
  stmtUpsert.run(cueId, targetLang, sourceLang, sourceHash, translated, Date.now());
  return translated;
}

// ================== LIVE OVERLAY (in-memory) ==================
let liveOverlay = null; // { id, kr, en, perLang: Map, expiresAt }
let liveTimer = null;

async function setLiveOverlayFromKR(krText) {
  const id = crypto.randomUUID();
  // 라이브 입력은 KR -> EN (기준) -> DE(무대)
  const en = await translateText({ text: krText, sourceLang: "ko", targetLang: "en" });
  const de = await translateText({ text: en, sourceLang: "en", targetLang: "de" });

  liveOverlay = {
    id,
    kr: krText,
    en,
    perLang: new Map([["de", de]]),
    expiresAt: Date.now() + LIVE_TTL_MS,
  };

  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    liveOverlay = null;
    broadcast({ type: "live", payload: null });
  }, LIVE_TTL_MS);

  broadcast({
    type: "live",
    payload: { id, en, de, expiresAt: liveOverlay.expiresAt },
  });
}

async function getLiveForLang(lang) {
  if (!liveOverlay) return null;
  if (lang === "ko") return liveOverlay.kr;
  if (lang === "en") return liveOverlay.en;

  const cached = liveOverlay.perLang.get(lang);
  if (cached) return cached;

  const sourceLang = EU_PIVOT_LANGS.has(lang) ? "en" : "ko";
  const sourceText = sourceLang === "en" ? liveOverlay.en : liveOverlay.kr;

  const t = await translateText({ text: sourceText, sourceLang, targetLang: lang });
  liveOverlay.perLang.set(lang, t);
  return t;
}

// ================== STATE ==================
let cueIndex = 0;
let currentCueId = cueIds[cueIndex];

// 이번 공연에서 “실제로 선택된 모바일 언어들” 추적
const activeMobileLangs = new Set(); // e.g. "ko", "fr", "ja" ...
activeMobileLangs.add("ko"); // 기본

// ================== WEB SERVER ==================
const app = express();
app.use(express.static(path.join(process.cwd(), "public")));
app.get("/health", (_, res) => res.json({ ok: true, provider: PROVIDER }));

const server = http.createServer(app);

// ================== WEBSOCKET ==================
const wss = new WebSocketServer({ server });

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

async function buildPayloadForStage(cueId) {
  const en = await getOrTranslateCue(cueId, "en");
  const de = await getOrTranslateCue(cueId, "de");
  return { cueId, en, de };
}

async function buildPayloadForMobile(cueId, lang) {
  const en = await getOrTranslateCue(cueId, "en");
  const local = await getOrTranslateCue(cueId, lang);
  let live = null;
  if (liveOverlay) {
    live = {
      en: liveOverlay.en,
      local: await getLiveForLang(lang),
      expiresAt: liveOverlay.expiresAt,
    };
  }
  return { cueId, en, local, lang, live };
}

async function prefetchAround(cueId) {
  const idx = cueIds.indexOf(cueId);
  if (idx < 0) return;

  const langsToPrefetch = new Set([...activeMobileLangs, ...STAGE_LANGS, "de"]);
  for (let offset = 0; offset < PREFETCH_N; offset++) {
    const nextIdx = idx + offset;
    if (nextIdx >= cueIds.length) break;
    const id = cueIds[nextIdx];

    for (const lang of langsToPrefetch) {
      if (lang === "ko" || lang === "en") continue;
      getOrTranslateCue(id, lang).catch(() => {});
    }
  }
}

wss.on("connection", (ws) => {
  ws.meta = { role: "unknown", lang: "ko" };

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "hello") {
      ws.meta.role = msg.role ?? "unknown";
      ws.meta.lang = (msg.lang ?? "ko").toLowerCase();

      if (ws.meta.role === "mobile") activeMobileLangs.add(ws.meta.lang);

      // initial state
      if (ws.meta.role === "stage") {
        safeSend(ws, { type: "state", payload: await buildPayloadForStage(currentCueId) });
        safeSend(ws, { type: "live", payload: liveOverlay ? {
          id: liveOverlay.id,
          en: liveOverlay.en,
          de: await getLiveForLang("de"),
          expiresAt: liveOverlay.expiresAt
        } : null });
      } else if (ws.meta.role === "mobile") {
        safeSend(ws, { type: "state", payload: await buildPayloadForMobile(currentCueId, ws.meta.lang) });
      } else if (ws.meta.role === "operator") {
        const cue = cueMap.get(currentCueId);
        safeSend(ws, { type: "operator_state", payload: {
          cueId: currentCueId,
          kr: cue?.kr ?? "",
          en: cue?.en ?? "",
          total: cueIds.length
        }});
      }

      prefetchAround(currentCueId).catch(() => {});
      return;
    }

    // operator controls
    if (ws.meta.role === "operator" && msg.type === "control") {
      const action = msg.action;

      if (action === "next") cueIndex = clampCueIndex(cueIndex + 1);
      if (action === "prev") cueIndex = clampCueIndex(cueIndex - 1);
      if (action === "jump") {
        const target = Number(msg.cueId);
        const idx = cueIds.indexOf(target);
        if (idx >= 0) cueIndex = idx;
      }

      currentCueId = cueIds[cueIndex];

      broadcast({ type: "state", payload: await buildPayloadForStage(currentCueId) });

      const cue = cueMap.get(currentCueId);
      broadcast({ type: "operator_state", payload: {
        cueId: currentCueId,
        kr: cue?.kr ?? "",
        en: cue?.en ?? "",
        total: cueIds.length
      }});

      prefetchAround(currentCueId).catch(() => {});
      return;
    }

    // operator live
    if (ws.meta.role === "operator" && msg.type === "live") {
      const krText = String(msg.kr ?? "").trim();
      if (!krText) {
        liveOverlay = null;
        if (liveTimer) clearTimeout(liveTimer);
        broadcast({ type: "live", payload: null });
        return;
      }
      await setLiveOverlayFromKR(krText);
      return;
    }

    // mobile change language
    if (ws.meta.role === "mobile" && msg.type === "set_lang") {
      const lang = String(msg.lang ?? "ko").toLowerCase();
      ws.meta.lang = lang;
      activeMobileLangs.add(lang);
      safeSend(ws, { type: "state", payload: await buildPayloadForMobile(currentCueId, ws.meta.lang) });
      prefetchAround(currentCueId).catch(() => {});
      return;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Provider: ${PROVIDER}`);
});
