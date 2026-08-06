const YOUTUBE_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "youtu.be",
  "music.youtube.com",
]);

function getVideoId(input) {
  if (typeof input !== "string" || input.trim().length === 0) {
    return null;
  }

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(hostname)) {
    return null;
  }

  if (hostname === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  }

  const queryId = url.searchParams.get("v");
  if (queryId && /^[A-Za-z0-9_-]{6,20}$/.test(queryId)) {
    return queryId;
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  const pathId =
    pathParts[0] === "shorts" || pathParts[0] === "embed"
      ? pathParts[1]
      : null;

  return pathId && /^[A-Za-z0-9_-]{6,20}$/.test(pathId) ? pathId : null;
}

function getRequestedUrl(req) {
  if (req.method === "GET") {
    return req.query?.url;
  }

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

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
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
  const videoId = getVideoId(requestedUrl);

  if (!videoId) {
    sendJson(res, 400, {
      error:
        "A valid public YouTube URL is required. Supported URLs include youtube.com/watch?v=..., youtu.be/..., /shorts/..., and /embed/....",
    });
    return;
  }

  const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl =
    `https://www.youtube.com/oembed?url=${encodeURIComponent(sourceUrl)}` +
    "&format=json";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(oembedUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      sendJson(res, 502, {
        error: `YouTube metadata request failed with status ${response.status}.`,
      });
      return;
    }

    const metadata = await response.json();

    sendJson(res, 200, {
      sourceUrl: requestedUrl,
      videoId,
      title: metadata.title || "Untitled YouTube video",
      authorName: metadata.author_name || "Unknown creator",
      authorUrl: metadata.author_url || "https://www.youtube.com/",
      thumbnailUrl:
        metadata.thumbnail_url ||
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      watchUrl: sourceUrl,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      downloadAvailable: false,
      downloadLinks: [],
      message:
        "Direct download URLs are not provided. This endpoint exposes public metadata and safe canonical YouTube links only.",
    });
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "YouTube metadata request timed out."
        : "YouTube public metadata could not be reached.";

    sendJson(res, 502, { error: message });
  } finally {
    clearTimeout(timeout);
  }
};
