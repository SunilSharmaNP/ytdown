/**
 * Terabox Direct Download Link — Vercel Serverless API
 * 100% Security Bypass (Correct Origin & Referer)
 */

// Frontend URL (Jahan se token churana hai aur jiska bhes badalna hai)
const SITE_URL = "https://flowvideoplayer.cc";

// Backend API URL (Jahan target / attack karna hai)
const API_URL = "https://flowvideoplayer.com/telegram/bot/search/video"; 

// Link dhundhne ka formula
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
  // API ko sabhi jagah access karne ki permission
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const targetUrl = req.query?.url || (req.body && req.body.url);
  if (!targetUrl) {
    return res.status(400).json({ success: false, error: "TeraBox URL is required" });
  }

  try {
    // ─── STEP 1: Asli website (.cc) par jao aur Security Token uthao ───
    const homeResponse = await fetch(SITE_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36"
      }
    });
    
    const homeHtml = await homeResponse.text();
    const csrfMatch = homeHtml.match(/<meta name="csrf-token" content="([^"]+)">/);
    const csrfToken = csrfMatch ? csrfMatch[1] : "";

    // ─── STEP 2: Hidden API (.com) ko target karo, .cc ka identity card dikha kar ───
    const apiResponse = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-TOKEN": csrfToken, // Churaya hua token
        // Yahan Guard Bypass ho raha hai:
        "Origin": "https://flowvideoplayer.cc",             
        "Referer": "https://flowvideoplayer.cc/"       
      },
      body: JSON.stringify({ url: targetUrl.trim() }) 
    });

    const data = await apiResponse.json();

    // Agar ab bhi koi dikkat aayi, toh seedha Vercel pe dikh jayegi
    if (data.status === false) {
        return res.status(403).json({
            success: false,
            error: "Backend API rejected the request.",
            api_message: data.message,
            raw: data
        });
    }

    // JSON ke andar direct link nikalna
    const fastStreamUrl = extractStreamUrl(data);

    if (!fastStreamUrl) {
      return res.status(404).json({ 
        success: false, 
        error: "Video found, but download link is hidden.", 
        raw_response: data 
      });
    }

    // Jadoo! Final Download Link Ready Hai
    return res.status(200).json({
      success: true,
      original_url: targetUrl,
      download_url: fastStreamUrl.replace(/\\\//g, "/") // Extras slashes \/ hatane ke liye
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: "Server Error", details: error.message });
  }
};
