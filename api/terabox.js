/**
 * Terabox Direct Download Link — Vercel Serverless API
 * Bypass 419 CSRF Token Error
 */

const BASE_URL = "https://flowvideoplayer.com";
const API_URL = "https://flowvideoplayer.cc/telegram/bot/search/video"; 

function extractStreamUrl(obj) {
  if (!obj) return null;
  if (typeof obj === "object") {
    if (obj.fast_stream_url) return obj.fast_stream_url;
    if (obj.download_link) return obj.download_link; 
    for (let key in obj) {
      const found = extractStreamUrl(obj[key]);
      if (found) return found;
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const targetUrl = req.query?.url || (req.body && req.body.url);
  if (!targetUrl) {
    return res.status(400).json({ success: false, error: "URL is required" });
  }

  try {
    // ─── STEP 1: Homepage Fetch (Token & Proper Cookies Extraction) ───
    const homeResponse = await fetch(BASE_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
      }
    });
    
    const homeHtml = await homeResponse.text();
    
    // Cookie Extraction (Fix for 419 Error)
    let rawCookies = [];
    if (typeof homeResponse.headers.getSetCookie === 'function') {
        rawCookies = homeResponse.headers.getSetCookie();
    } else {
        const fallback = homeResponse.headers.get("set-cookie");
        if (fallback) rawCookies = [fallback];
    }
    
    // Format cookies like a real browser: "laravel_session=xyz; XSRF-TOKEN=abc"
    const parsedCookies = rawCookies.map(cookie => cookie.split(';')[0]).join('; ');
    
    // CSRF Token Extraction
    const csrfMatch = homeHtml.match(/<meta name="csrf-token" content="([^"]+)">/);
    const csrfToken = csrfMatch ? csrfMatch[1] : "";

    // ─── STEP 2: API Fetch with Perfect Headers ───────────────────────
    const apiResponse = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-TOKEN": csrfToken,
        "Cookie": parsedCookies,
        "Origin": BASE_URL,
        "Referer": BASE_URL + "/"
      },
      body: JSON.stringify({ url: targetUrl.trim() }) 
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      return res.status(apiResponse.status).json({ 
        success: false, 
        error: `Upstream API returned status ${apiResponse.status}`,
        details: errorText
      });
    }

    const data = await apiResponse.json();
    const fastStreamUrl = extractStreamUrl(data);

    if (!fastStreamUrl) {
      return res.status(404).json({
        success: false,
        error: "Link not found in response",
        raw_response: data
      });
    }

    return res.status(200).json({
      success: true,
      original_url: targetUrl,
      download_url: fastStreamUrl.replace(/\\\//g, "/")
    });

  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      error: "Internal Server Error",
      message: error.message
    });
  }
};
