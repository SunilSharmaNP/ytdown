/**
 * YouTube All-Quality Downloader — Vercel Serverless API
 * -------------------------------------------------------
 * Usage:
 *   GET  /api/youtube?url=https://youtu.be/VIDEO_ID
 *   POST /api/youtube   body: { "url": "https://youtu.be/VIDEO_ID" }
 *
 * Response: JSON with all available quality download links
 */

// ─── YouTube URL Parsing ──────────────────────────────────────────────────────

const YOUTUBE_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "youtu.be",
  "music.youtube.com",
]);

function getVideoId(input) {
  if (typeof input !== "string" || input.trim().length === 0) return null;

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol)) return null;

  const hostname = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(hostname)) return null;

  if (hostname === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  }

  const queryId = url.searchParams.get("v");
  if (queryId && /^[A-Za-z0-9_-]{6,20}$/.test(queryId)) return queryId;

  const pathParts = url.pathname.split("/").filter(Boolean);
  const pathId =
    pathParts[0] === "shorts" || pathParts[0] === "embed" ? pathParts[1] : null;

  return pathId && /^[A-Za-z0-9_-]{6,20}$/.test(pathId) ? pathId : null;
}

function getRequestedUrl(req) {
  if (req.method === "GET") return req.query?.url;
  if (req.method === "POST") {
    if (typeof req.body === "string") {
      try { return JSON.parse(req.body)?.url; } catch { return null; }
    }
    return req.body?.url;
  }
  return null;
}

function sendJson(res, status, data) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.status(status).json(data);
}

// ─── Savenow.to API Configuration ────────────────────────────────────────────

const SAVENOW_API_KEY  = "dfcb6d76f2f6a9894gjkege8a4ab232222";
const SAVENOW_BASE     = "https://p.savenow.to";
const POLL_INTERVAL_MS = 1800;          // poll every 1.8s
const POLL_MAX_TRIES   = 25;            // max ~45s per format
const REQUEST_TIMEOUT  = 12000;         // 12s per individual HTTP call

/** All formats to try in parallel */
const ALL_FORMATS = [
  // ── Video ──────────────────────────────────────────────────────────────────
  { id: "144",  label: "MP4 144p",  type: "video" },
  { id: "240",  label: "MP4 240p",  type: "video" },
  { id: "360",  label: "MP4 360p",  type: "video" },
  { id: "480",  label: "MP4 480p",  type: "video" },
  { id: "720",  label: "MP4 720p",  type: "video" },
  { id: "1080", label: "MP4 1080p", type: "video" },
  { id: "1440", label: "MP4 1440p", type: "video" },
  { id: "4k",   label: "WEBM 4K",   type: "video" },
  // ── Audio ──────────────────────────────────────────────────────────────────
  { id: "mp3",  label: "MP3 Audio", type: "audio" },
  { id: "m4a",  label: "M4A Audio", type: "audio" },
  { id: "aac",  label: "AAC Audio", type: "audio" },
  { id: "flac", label: "FLAC Audio",type: "audio" },
  { id: "opus", label: "OPUS Audio",type: "audio" },
  { id: "ogg",  label: "OGG Audio", type: "audio" },
  { id: "wav",  label: "WAV Audio", type: "audio" },
];

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Referer":    "https://y2mate.yt/",
  "Origin":     "https://y2mate.yt",
};

async function fetchJSON(url, timeoutMs = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Step 1: Start a download job for one format ───────────────────────────────

async function startDownload(ytUrl, format) {
  const apiUrl =
    `${SAVENOW_BASE}/api/v2/download` +
    `?format=${encodeURIComponent(format)}` +
    `&url=${encodeURIComponent(ytUrl)}` +
    `&apikey=${SAVENOW_API_KEY}`;

  const data = await fetchJSON(apiUrl);

  // API returns { success: true, id, progress_url, title, ... }
  if (!data.success || !data.id || !data.progress_url) {
    throw new Error(data.message || "No job ID returned");
  }
  return data; // { id, progress_url, title, thumbnail_url, full_format, ... }
}

// ─── Step 2: Poll progress until finished ────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntilDone(progressUrl) {
  for (let attempt = 0; attempt < POLL_MAX_TRIES; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    let data;
    try {
      data = await fetchJSON(progressUrl);
    } catch {
      continue; // network blip — retry
    }

    const status = (data.text || "").toLowerCase();

    // ✅ Done
    if (data.success === 1 && data.download_url) {
      return { ok: true, downloadUrl: data.download_url, data };
    }

    // ❌ Explicit failure
    if (status === "error" || status === "failed") {
      return { ok: false, reason: data.message || "conversion error" };
    }

    // Still in progress (downloading / converting / preparing) — keep polling
  }

  return { ok: false, reason: "timed out after max polls" };
}

// ─── Step 3: Process one format end-to-end ───────────────────────────────────

async function processFormat(ytUrl, fmt) {
  try {
    const job = await startDownload(ytUrl, fmt.id);
    const result = await pollUntilDone(job.progress_url);

    if (!result.ok) {
      return { format: fmt.id, label: fmt.label, type: fmt.type, status: "unavailable", reason: result.reason };
    }

    return {
      format:      fmt.id,
      label:       fmt.label,
      type:        fmt.type,
      status:      "ready",
      downloadUrl: result.downloadUrl,
      fullFormat:  job.full_format || fmt.label,
    };
  } catch (err) {
    return { format: fmt.id, label: fmt.label, type: fmt.type, status: "error", reason: err.message };
  }
}

// ─── YouTube oEmbed metadata ─────────────────────────────────────────────────

async function getYouTubeMetadata(videoId) {
  const oembedUrl =
    `https://www.youtube.com/oembed` +
    `?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}` +
    `&format=json`;
  try {
    const meta = await fetchJSON(oembedUrl, 8000);
    return {
      title:       meta.title         || "Untitled",
      authorName:  meta.author_name   || "Unknown",
      authorUrl:   meta.author_url    || "https://www.youtube.com/",
      thumbnailUrl: meta.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  } catch {
    return {
      title: "Untitled",
      authorName: "Unknown",
      authorUrl: "https://www.youtube.com/",
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    sendJson(res, 405, { error: "Use GET or POST." });
    return;
  }

  // ── Validate YouTube URL ────────────────────────────────────────────────────
  const requestedUrl = getRequestedUrl(req);
  const videoId      = getVideoId(requestedUrl);

  if (!videoId) {
    sendJson(res, 400, {
      error: "A valid YouTube URL is required.",
      examples: [
        "?url=https://youtu.be/NgfuIXhRB1Y",
        "?url=https://www.youtube.com/watch?v=NgfuIXhRB1Y",
        "?url=https://www.youtube.com/shorts/VIDEO_ID",
      ],
    });
    return;
  }

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // ── Fetch metadata + all formats in parallel ────────────────────────────────
  const [meta, ...formatResults] = await Promise.all([
    getYouTubeMetadata(videoId),
    ...ALL_FORMATS.map((fmt) => processFormat(ytUrl, fmt)),
  ]);

  // ── Split into available / unavailable ─────────────────────────────────────
  const available   = formatResults.filter((r) => r.status === "ready");
  const unavailable = formatResults.filter((r) => r.status !== "ready");

  // ── Build clean response ───────────────────────────────────────────────────
  sendJson(res, 200, {
    videoId,
    sourceUrl:    requestedUrl,
    watchUrl:     ytUrl,
    embedUrl:     `https://www.youtube.com/embed/${videoId}`,
    title:        meta.title,
    authorName:   meta.authorName,
    authorUrl:    meta.authorUrl,
    thumbnailUrl: meta.thumbnailUrl,

    // ✅ All ready-to-download links
    downloadLinks: available.map((r) => ({
      format:      r.format,
      label:       r.label,
      type:        r.type,
      fullFormat:  r.fullFormat,
      downloadUrl: r.downloadUrl,
    })),

    // ℹ️ Summary counts
    summary: {
      total:       ALL_FORMATS.length,
      available:   available.length,
      unavailable: unavailable.length,
    },

    // ⚠️ Failed/unavailable formats (for debugging)
    unavailableFormats: unavailable.map((r) => ({
      format: r.format,
      label:  r.label,
      reason: r.reason,
    })),
  });
};
