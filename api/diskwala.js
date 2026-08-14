/**
 * DiskWala Direct Download Link — Vercel Serverless API
 * -------------------------------------------------------
 * Resolves a DiskWala share URL (https://www.diskwala.com/app/<id>)
 * into a signed direct-download link (the same one the site uses for
 * streaming) via thedisk wala.com's free resolver API.
 *
 * Usage:
 *   GET  /api/diskwala?url=https://www.diskwala.com/app/VIDEO_ID
 *   POST /api/diskwala   body: { "url": "https://www.diskwala.com/app/VIDEO_ID" }
 *
 * Response: JSON with the direct download URL + video title.
 */

// ─── Upstream resolver (thedisk wala.com free API) ─────────────────────────────
const DISKWALA_API = "https://thediskwala.com/api/diskwala-free";

const DISKWALA_HOSTS = new Set([
  "www.diskwala.com",
  "diskwala.com",
  "thediskwala.com",
]);

// ─── DiskWala URL parsing ────────────────────────────────────────────────────
function getAppId(input) {
  if (typeof input !== "string" || input.trim().length === 0) return null;

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol)) return null;

  const hostname = url.hostname.toLowerCase();
  if (!DISKWALA_HOSTS.has(hostname)) return null;

  // /app/<id>  or  /s/<id>
  const m = url.pathname.match(/\/(?:app|s)\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
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
  res.status(status).setHeader("Content-Type", "application/json");
  res.status(status).json(data);
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const requestedUrl = getRequestedUrl(req);
  if (!requestedUrl) {
    return sendJson(res, 400, { success: false, error: "URL required" });
  }

  const appId = getAppId(requestedUrl);
  if (!appId) {
    return sendJson(res, 400, {
      success: false,
      error:
        "Invalid DiskWala URL. Expected https://www.diskwala.com/app/<id>",
    });
  }

  try {
    const apiUrl = `${DISKWALA_API}?url=${encodeURIComponent(
      requestedUrl.trim()
    )}`;

    const upstream = await fetch(apiUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });

    if (!upstream.ok) {
      return sendJson(res, upstream.status, {
        success: false,
        error: `Upstream error ${upstream.status}`,
      });
    }

    const data = await upstream.json();
    if (!data.success || !data.url) {
      return sendJson(res, 502, {
        success: false,
        error: data.error || "Failed to resolve download link",
      });
    }

    return sendJson(res, 200, {
      success: true,
      appId,
      sourceUrl: requestedUrl.trim(),
      title: data.title || "",
      downloadUrl: data.url,
    });
  } catch (err) {
    return sendJson(res, 500, { success: false, error: err.message });
  }
};
