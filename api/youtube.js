const YOUTUBE_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "youtu.be",
  "music.youtube.com",
]);

const RAPIDAPI_HOST = "ytstream-download-youtube-videos.p.rapidapi.com";
const RAPIDAPI_KEY = "484987d36bmsh4d07e9393d91c06p15086ejsnb06160736aa7";

// ── Preferred itags in priority order ──────────────────────────────────────
// Muxed (video + audio together) — best for direct download
const MUXED_ITAGS = {
  18: { label: "MP4 - 360p (Audio+Video)", type: "video", ext: "mp4" },
};

// Video-only adaptive (no audio) — high quality but needs separate audio
const VIDEO_ITAGS = {
  136: { label: "MP4 - 720p HD (Video only)", type: "video", ext: "mp4" },
  135: { label: "MP4 - 480p SD (Video only)", type: "video", ext: "mp4" },
  134: { label: "MP4 - 360p SD (Video only)", type: "video", ext: "mp4" },
  133: { label: "MP4 - 240p SD (Video only)", type: "video", ext: "mp4" },
  160: { label: "MP4 - 144p SD (Video only)", type: "video", ext: "mp4" },
};

// Audio-only
const AUDIO_ITAGS = {
  140: { label: "M4A - 128K (Audio only)", type: "audio", ext: "m4a" },
  139: { label: "M4A - 48K (Audio only)",  type: "audio", ext: "m4a" },
};

// ── Helpers ────────────────────────────────────────────────────────────────

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
    pathParts[0] === "shorts" || pathParts[0] === "embed"
      ? pathParts[1]
      : null;

  return pathId && /^[A-Za-z0-9_-]{6,20}$/.test(pathId) ? pathId : null;
}

function getRequestedUrl(req) {
  if (req.method === "GET") return req.query?.url;

  if (req.method === "POST") {
    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body)?.url;
      } catch {
        return null;
      }
    }
    return req.body?.url;
  }

  return null;
}

function sendJson(res, status, data) {
  res.status(status).json(data);
}

// ── Fetch YouTube metadata via oEmbed (free, no quota) ─────────────────────
async function fetchMetadata(videoId, signal) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl =
    `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;

  const resp = await fetch(oembedUrl, {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!resp.ok) {
    throw Object.assign(new Error("oembed_failed"), { status: resp.status });
  }

  return resp.json();
}

// ── Fetch download formats via RapidAPI YTStream ───────────────────────────
async function fetchFormats(videoId, signal) {
  const url = `https://${RAPIDAPI_HOST}/dl?id=${encodeURIComponent(videoId)}`;

  const resp = await fetch(url, {
    headers: {
      "Content-Type":  "application/json",
      "x-rapidapi-host": RAPIDAPI_HOST,
      "x-rapidapi-key":  RAPIDAPI_KEY,
    },
    signal,
  });

  if (!resp.ok) {
    throw Object.assign(new Error("rapidapi_failed"), { status: resp.status });
  }

  const data = await resp.json();
  if (data.status !== "OK") {
    throw Object.assign(new Error("rapidapi_not_ok"), { detail: data.status });
  }

  return data;
}

// ── Parse raw format lists into clean download links ──────────────────────
function parseDownloadLinks(videoId, data) {
  const links = [];

  const allFormats = [
    ...(data.formats || []),
    ...(data.adaptiveFormats || []),
  ];

  for (const f of allFormats) {
    const itag = f.itag;
    const url  = f.url;
    if (!url) continue;

    const meta =
      MUXED_ITAGS[itag] || VIDEO_ITAGS[itag] || AUDIO_ITAGS[itag];
    if (!meta) continue;

    // Quality label for display
    const qualityLabel = f.qualityLabel || f.audioQuality || "";
    const bitrateKbps  = f.bitrate ? Math.round(f.bitrate / 1000) : null;

    links.push({
      itag,
      label:    meta.label,
      type:     meta.type,
      ext:      meta.ext,
      quality:  qualityLabel,
      bitrate:  bitrateKbps ? `${bitrateKbps} kbps` : null,
      mimeType: f.mimeType?.split(";")[0] || null,
      hasAudio: meta === MUXED_ITAGS[itag] || meta === AUDIO_ITAGS[itag],
      width:    f.width  || null,
      height:   f.height || null,
      size:     f.contentLength
        ? `${(parseInt(f.contentLength) / 1024 / 1024).toFixed(1)} MB`
        : null,
      url,
    });
  }

  // Sort: muxed first, then video by height desc, then audio by bitrate desc
  links.sort((a, b) => {
    const order = { video: 1, audio: 2 };
    if (order[a.type] !== order[b.type]) return order[a.type] - order[b.type];
    if (a.type === "video") return (b.height || 0) - (a.height || 0);
    return (b.itag === 140 ? 1 : 0) - (a.itag === 140 ? 1 : 0);
  });

  return links;
}

// ── Main handler ───────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    sendJson(res, 405, { error: "Use GET or POST for this endpoint." });
    return;
  }

  const requestedUrl = getRequestedUrl(req);
  const videoId      = getVideoId(requestedUrl);

  if (!videoId) {
    sendJson(res, 400, {
      error:
        "A valid public YouTube URL is required. " +
        "Supported: youtube.com/watch?v=..., youtu.be/..., /shorts/..., /embed/...",
    });
    return;
  }

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 12000);

  try {
    // Run oEmbed + RapidAPI in parallel to save time
    const [metadata, rawData] = await Promise.all([
      fetchMetadata(videoId, controller.signal),
      fetchFormats(videoId, controller.signal),
    ]);

    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const downloadLinks = parseDownloadLinks(videoId, rawData);

    sendJson(res, 200, {
      // ── Video identity ─────────────────────────────────────────────────
      sourceUrl:    requestedUrl,
      videoId,
      watchUrl,
      embedUrl:     `https://www.youtube.com/embed/${videoId}`,

      // ── Metadata ──────────────────────────────────────────────────────
      title:        metadata.title       || rawData.title     || "Untitled",
      authorName:   metadata.author_name || rawData.channelTitle || "Unknown",
      authorUrl:    metadata.author_url  || `https://www.youtube.com/channel/${rawData.channelId}`,
      thumbnailUrl:
        metadata.thumbnail_url ||
        rawData.thumbnail       ||
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      durationSeconds: rawData.lengthSeconds
        ? parseInt(rawData.lengthSeconds)
        : null,
      viewCount:    rawData.viewCount ? parseInt(rawData.viewCount) : null,

      // ── Download links ────────────────────────────────────────────────
      downloadAvailable: downloadLinks.length > 0,
      downloadLinks,

      // ── Expiry note ──────────────────────────────────────────────────
      note:
        "Download URLs are signed and expire after a few hours. " +
        "Fetch fresh links if a URL stops working.",
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      sendJson(res, 504, { error: "Request timed out. Please try again." });
      return;
    }
    if (error?.message === "oembed_failed") {
      sendJson(res, 502, {
        error: `YouTube metadata unavailable (status ${error.status}). Video may be private or removed.`,
      });
      return;
    }
    if (error?.message === "rapidapi_failed") {
      sendJson(res, 502, {
        error: `Download service unavailable (status ${error.status}). Try again shortly.`,
      });
      return;
    }
    sendJson(res, 502, {
      error: "Could not fetch video information. Please try again.",
    });
  } finally {
    clearTimeout(timeout);
  }
};
