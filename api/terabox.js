/**
 * Terabox Direct Download Link — Vercel Serverless API
 * -------------------------------------------------------
 * Resolves a Terabox URL into a direct stream/download link
 * using the backend API of flowvideoplayer.
 *
 * Usage:
 *   GET  /api/terabox?url=https://teraboxapp.com/s/...
 */

// ─── Constants & Endpoints ──────────────────────────────────────────────
const BASE_URL = "https://flowvideoplayer.com";
const API_URL = "https://flowvideoplayer.com/telegram/bot/search/video";

// ─── Helper function to find link in dynamic JSON ───────────────────────
// (Kyunki JSON ka structure change ho sakta hai, yeh function 
//  poore data mein 'fast_stream_url' ko dhoondh nikalega)
function extractStreamUrl(obj) {
  if (!obj) return null;
  if (typeof obj === "object") {
    if (obj.fast_stream_url) return obj.fast_stream_url;
    if (obj.download_link) return obj.download_link; // Fallback
    
    for (let key in obj) {
      const found = extractStreamUrl(obj[key]);
      if (found) return found;
    }
  }
  return null;
}

// ─── Vercel Serverless Handler ──────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS setup - Taaki kisi bhi player ya app se call ho sake
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // 1. Get User's Terabox URL
  const targetUrl = req.query?.url || (req.body && req.body.url);
  if (!targetUrl) {
    return res.status(400).json({ success: false, error: "Please provide a valid Terabox URL in 'url' parameter." });
  }

  try {
    // ─── STEP 1: Fetch CSRF Token & Cookies (Security Bypass) ───────────
    // Hum pehle website ka homepage fetch karenge taaki session aur token mil jaye
    const homeResponse = await fetch(BASE_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    
    const homeHtml = await homeResponse.text();
    const cookies = homeResponse.headers.get("set-cookie") || "";
    
    // HTML se meta tag ke zariye CSRF token nikalna
    const csrfMatch = homeHtml.match(/<meta name="csrf-token" content="([^"]+)">/);
    const csrfToken = csrfMatch ? csrfMatch[1] : "";

    // ─── STEP 2: Call the Hidden Video API ──────────────────────────────
    const apiResponse = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json", // Sometimes APIs use form-data, json is standard
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-TOKEN": csrfToken, // Jo token image me dikha tha
        "Cookie": cookies,         // Session bypass
        "Origin": BASE_URL,
        "Referer": BASE_URL + "/"
      },
      // API ko URL send karna
      body: JSON.stringify({ url: targetUrl.trim() }) 
    });

    if (!apiResponse.ok) {
      return res.status(apiResponse.status).json({ 
        success: false, 
        error: `Upstream API returned status ${apiResponse.status}` 
      });
    }

    const data = await apiResponse.json();

    // ─── STEP 3: Extract final direct link and send ─────────────────────
    const fastStreamUrl = extractStreamUrl(data);

    if (!fastStreamUrl) {
      return res.status(404).json({
        success: false,
        error: "Video processing complete, but direct link was not found in response.",
        raw_response: data // Debugging ke liye
      });
    }

    // Clean final JSON Response
    return res.status(200).json({
      success: true,
      original_url: targetUrl,
      download_url: fastStreamUrl.replace(/\\\//g, "/") // Slashes ko theek karna
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ 
      success: false, 
      error: "Internal Server Error", 
      message: error.message 
    });
  }
};
