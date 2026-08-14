// api/terabox.js — v4: folder resolution + direct dlink extraction

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const UA_MOBILE  = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = req.method === 'POST' ? req.body?.url : req.query?.url;
  if (!url) return res.status(400).json({ success: false, error: 'URL required' });

  try {
    const data = await getTeraboxLinks(url.trim());
    res.status(200).json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ── Extract surl ──────────────────────────────────────────────────────────────
function extractSurl(rawUrl) {
  if (!rawUrl.startsWith('http')) rawUrl = 'https://' + rawUrl;
  const u = new URL(rawUrl);
  const m = u.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const s = u.searchParams.get('surl');
  if (s) return s;
  throw new Error('Cannot extract share token from URL');
}

// ── Cookie helpers ────────────────────────────────────────────────────────────
function parseCookiesToObj(raw) {
  const obj = {};
  if (!raw) return obj;
  const arr = Array.isArray(raw) ? raw : [raw];
  for (const chunk of arr) {
    for (const part of chunk.split(/,(?=\s*[a-zA-Z_-]+=)/)) {
      const [kv] = part.split(';');
      const idx = kv.indexOf('=');
      if (idx > 0) obj[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
    }
  }
  return obj;
}

function objToStr(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── Follow redirects manually, collect ALL cookies ───────────────────────────
async function fetchChain(startUrl, baseHeaders) {
  let currentUrl = startUrl;
  let cookies = {};
  let html = '';
  let finalUrl = startUrl;

  for (let i = 0; i < 6; i++) {
    const res = await fetch(currentUrl, {
      headers: { ...baseHeaders, Cookie: objToStr(cookies) },
      redirect: 'manual',
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) Object.assign(cookies, parseCookiesToObj(setCookie));

    if (res.status >= 300 && res.status < 400) {
      let loc = res.headers.get('location') || '';
      if (!loc) break;
      if (!loc.startsWith('http')) loc = new URL(loc, currentUrl).href;
      currentUrl = loc;
      continue;
    }

    html = await res.text();
    finalUrl = currentUrl;
    break;
  }

  return { cookies: objToStr(cookies), cookieObj: cookies, html, finalUrl };
}

// ── Extract jsToken + bdstoken from HTML ──────────────────────────────────────
function extractTokens(html) {
  const jsTokenPatterns = [
    /window\.jsToken\s*=\s*["']?([A-Za-z0-9%_+=\/-]{16,})/i,
    /"jsToken"\s*:\s*"([A-Za-z0-9%_+=\/-]{16,})"/i,
    /jsToken\s*=\s*["']([A-Za-z0-9%_+=\/-]{16,})["']/i,
    /["']token["']\s*:\s*["']([A-Za-z0-9%_+=\/-]{32,})["']/i,
  ];
  let jsToken = '';
  for (const re of jsTokenPatterns) {
    const m = html.match(re);
    if (m) { jsToken = decodeURIComponent(m[1]); break; }
  }
  const bdstokenMatch = html.match(/bdstoken["'\s:=]+([a-zA-Z0-9]{16,})/);
  const bdstoken = bdstokenMatch ? bdstokenMatch[1] : '';
  return { jsToken, bdstoken };
}

// ── Safe JSON fetch ───────────────────────────────────────────────────────────
async function tryFetch(url, headers) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    return await res.json();
  } catch { return null; }
}

// ── Resolve folders recursively ───────────────────────────────────────────────
async function resolveFiles(list, surl, apiHeaders, jsToken, host, depth = 0) {
  if (depth > 3) return list; // max 3 levels deep
  const allFiles = [];

  for (const f of list) {
    if (f.isdir && f.path) {
      const dirPath = encodeURIComponent(f.path);
      const d = await tryFetch(
        `https://${host}/share/list?app_id=250528&shorturl=${surl}&root=0` +
        `&dir=${dirPath}&page=1&num=100&order=time&desc=1` +
        `&jsToken=${encodeURIComponent(jsToken)}`,
        apiHeaders
      );
      if (d?.errno === 0 && d.list?.length) {
        const nested = await resolveFiles(d.list, surl, apiHeaders, jsToken, host, depth + 1);
        allFiles.push(...nested);
      } else {
        // path nahi mila, fs_id se try karo
        const d2 = await tryFetch(
          `https://${host}/share/list?app_id=250528&shorturl=${surl}&root=0` +
          `&fid=${f.fs_id}&page=1&num=100&order=time&desc=1` +
          `&jsToken=${encodeURIComponent(jsToken)}`,
          apiHeaders
        );
        if (d2?.errno === 0 && d2.list?.length) {
          const nested2 = await resolveFiles(d2.list, surl, apiHeaders, jsToken, host, depth + 1);
          allFiles.push(...nested2);
        } else {
          allFiles.push(f); // as-is
        }
      }
    } else {
      allFiles.push(f);
    }
  }

  return allFiles;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function getTeraboxLinks(shareUrl) {
  const surl = extractSurl(shareUrl);
  const parsedUrl = new URL(shareUrl.startsWith('http') ? shareUrl : 'https://' + shareUrl);
  const originHost = parsedUrl.hostname;
  const pageUrl = `https://${originHost}/s/${surl}`;

  // Step 1 — collect session
  const { cookies, html, finalUrl } = await fetchChain(pageUrl, {
    'User-Agent': UA_DESKTOP,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Upgrade-Insecure-Requests': '1',
  });

  const finalHost = new URL(finalUrl).hostname;
  const { jsToken, bdstoken } = extractTokens(html);

  const apiHeaders = {
    'User-Agent': UA_DESKTOP,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: finalUrl,
    Cookie: cookies,
    'X-Requested-With': 'XMLHttpRequest',
  };

  const jtEncoded = encodeURIComponent(jsToken);
  const hosts = [...new Set([finalHost, originHost, 'www.terabox.com'])];
  let lastData = null;

  for (const h of hosts) {
    // Endpoint A: share/list
    let d = await tryFetch(
      `https://${h}/share/list?app_id=250528&shorturl=${surl}&root=1` +
      `&page=1&num=100&order=time&desc=1&jsToken=${jtEncoded}&bdstoken=${bdstoken}`,
      { ...apiHeaders, Referer: `https://${h}/s/${surl}` }
    );
    if (d?.errno === 0) {
      const resolved = await resolveFiles(d.list || [], surl, apiHeaders, jsToken, h);
      return formatResult({ ...d, list: resolved }, surl);
    }
    if (d) lastData = d;

    // Endpoint B: shorturlinfo
    d = await tryFetch(
      `https://${h}/api/shorturlinfo?app_id=250528&shorturl=${surl}&root=1&jsToken=${jtEncoded}`,
      { ...apiHeaders, Referer: `https://${h}/s/${surl}` }
    );
    if (d?.errno === 0) {
      const resolved = await resolveFiles(d.list || [], surl, apiHeaders, jsToken, h);
      return formatResult({ ...d, list: resolved }, surl);
    }
    if (d) lastData = d;

    // Endpoint C: mobile UA
    d = await tryFetch(
      `https://${h}/share/list?app_id=250528&shorturl=${surl}&root=1` +
      `&page=1&num=100&order=time&desc=1&jsToken=${jtEncoded}`,
      { ...apiHeaders, 'User-Agent': UA_MOBILE, Referer: `https://${h}/s/${surl}` }
    );
    if (d?.errno === 0) {
      const resolved = await resolveFiles(d.list || [], surl, apiHeaders, jsToken, h);
      return formatResult({ ...d, list: resolved }, surl);
    }
    if (d) lastData = d;
  }

  if (lastData) {
    throw new Error(
      `TeraBox error ${lastData.errno}: ${lastData.errmsg || 'Unknown'} | ` +
      `jsToken: ${jsToken ? 'YES(' + jsToken.slice(0, 10) + '...)' : 'NO'} | ` +
      `cookies: ${cookies ? cookies.slice(0, 50) + '...' : 'none'}`
    );
  }

  throw new Error('All endpoints failed — no JSON response from TeraBox');
}

// ── Format final output ───────────────────────────────────────────────────────
function formatResult(data, surl) {
  const list = data.list || [];
  const files = list.map((f) => ({
    filename: f.server_filename,
    size: formatBytes(f.size),
    size_bytes: f.size,
    is_dir: !!f.isdir,
    fs_id: String(f.fs_id),
    dlink: f.dlink || null,
    thumbnail: f.thumbs?.url3 || null,
    category: f.category,
    path: f.path || null,
  }));

  const download_links = files
    .filter((f) => !f.is_dir && f.dlink)
    .map((f) => ({
      filename: f.filename,
      size: f.size,
      download_url: f.dlink,
    }));

  return {
    surl,
    share_title: data.share_title || '',
    total_files: files.length,
    files,
    download_links,
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + u[i];
}
