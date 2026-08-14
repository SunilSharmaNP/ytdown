/**
 * Terabox Direct Download Link — Vercel Serverless API
 * Version: Ultimate Security Bypass (Origin & Referer Fix)
 */

const SITE_URL = "https://flowvideoplayer.cc";
const API_URL = "https://flowvideoplayer.com/telegram/bot/search/video"; 

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

  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
  };

  try {
    // ─── STEP 1: Main website (.cc) se token aur cookies churana ───
    const homeResponse = await fetch(SITE_URL, { headers: HEADERS });
    const homeHtml = await homeResponse.text();
    
    let rawCookies = [];
    if (typeof homeResponse.headers.getSetCookie === 'function') {
        rawCookies = homeResponse.headers.getSetCookie();
    } else {
        const fallback = homeResponse.headers.get("set-cookie");
        if (fallback) {
           rawCookies = fallback.split(/,\s*(?=[a-zA-Z0-9_\-]+(?:%[a-zA-Z0-9_\-]+)?=)/);
        }
    }
    const parsedCookies = rawCookies.map(c => c.split(';')[0]).join('; ');
    
    const csrfMatch = homeHtml.match(/<meta name="csrf-token" content="([^"]+)">/);
    const csrfToken = csrfMatch ? csrfMatch[1] : "";

    if (!csrfToken) {
       return res.status(500).json({ success: false, error: "CSRF Token missing" });
    }

    // ─── STEP 2: Hidden API (.com) ko hit karna, `.cc` ka bhes badal kar ───
    const apiResponse = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": HEADERS["User-Agent"],
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-TOKEN": csrfToken,
        "Cookie": parsedCookies,
        // YAHAN FIX KIYA HAI: Server check karega ki hum kahan se aaye hain,
        // Aur hum usey batayenge ki hum flowvideoplayer.cc se hi aaye hain!
        "Origin": SITE_URL,             
        "Referer": SITE_URL + "/"       
      },
      body: JSON.stringify({ url: targetUrl.trim() }) 
    });

    const data = await apiResponse.json();

    // Check agar ab bhi block kiya (just in case)
    if (data.status === false && data.message === "Direct access blocked") {
        return res.status(403).json({
            success: false,
            error: "Referer Guard bypass failed.",
            raw: data
        });
    }

    // Final Link nikalna
    const fastStreamUrl = extractStreamUrl(data);

    if (!fastStreamUrl) {
      return res.status(404).json({ 
        success: false, 
        error: "Direct Link missing", 
        raw_response: data 
      });
    }

    // Success! 🎉 Direct download/stream link return karna
    return res.status(200).json({
      success: true,
      original_url: targetUrl,
      download_url: fastStreamUrl.replace(/\\\//g, "/")
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
