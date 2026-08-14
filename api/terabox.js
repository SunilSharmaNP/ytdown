// api/terabox.js — v5
// Live verified fixes (sample surl 1UlFrS6ugBwq_VrXdFnnsVw):
//   #1 jsToken extraction — old regex matched minified JS garbage; real token
//      is injected via eval(decodeURIComponent(`...fn("<HEX>")...`))
//   #2 isdir normalize — TeraBox returns STRING "0"/"1", not boolean; old
//      !!f.isdir was truthy for "0" → every file misreported as folder
//   #3 dlink pipeline — /api/shorturlinfo gives shareid/uk/sign/timestamp +
//      flat list; /api/download (per file) gives the signed DDL
// Unverified step (sandbox tool failures blocked final live run):
//   - Capturing an actual non-null dlink from /api/download; this is exactly
//     what your Vercel deploy will validate the first time you call it.

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

function extractSurl(rawUrl) {
  if (!rawUrl.startsWith('http')) rawUrl = 'https://' + rawUrl;
  const u = new URL(rawUrl);
  const m = u.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const s = u.searchParams.get('surl');
  if (s) return s;
  throw new Error('Cannot extract share token from URL');
}

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

// Follow redirect chain manually and merge cookies from each hop
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

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ BUG FIX #1 — jsToken extraction                                         │
// │ Live page (verified):                                                   │
// │   <script>                                                              │
// │     eval(decodeURIComponent(`function%20fn%28a%29%7Bwindow.jsToken%20  │
// │       %3D%20a%7D%3Bfn%28%22F2F3A167F72F247FCED89EF6CCD60DEF1BC16F4F  │
// │       C9C501C4976AECC54742C29FF29005251297D11AF87B506B639ED27B9A5...  │
// │       %22%29`))                                                         │
// │   </script>                                                             │
// └─────────────────────────────────────────────────────────────────────────┘
function extractJsToken(html) {
  const m1 = html.match(/fn%28%22([A-Za-z0-9%_+=\/-]{16,})%22%29/);
  if (m1) return decodeURIComponent(m1[1]);
  const m2 = html.match(/fn\(["']([A-Za-z0-9%_+=\/-]{16,})["']\)/);
  if (m2) return m2[1];
  const m3 = html.match(/window\.jsToken\s*=\s*["']?([A-Za-z0-9%_+=\/-]{16,})/i);
  if (m3) {
    try { return decodeURIComponent(m3[1]); } catch { return m3[1]; }
  }
  return '';
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ BUG FIX #2 — isdir normalization                                      │
// │ Live response (sample item): {"isdir":"0", ...}  ← STRING, not bool   │
// │ Old code: !!f.isdir was truthy for BOTH "0" AND "1"                   │
// └─────────────────────────────────────────────────────────────────────────┘
function isDir(f) {
  const v = f.isdir;
  return v === '1' || v === 1 || v === true || v === 'true';
}

async function tryFetchJson(url, headers) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    return await res.json();
  } catch { return null; }
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ BUG FIX #3 — dlink extraction per file                                 │
// │ list items don't carry dlink; /api/download gives the signed URL      │
// └─────────────────────────────────────────────────────────────────────────┘
async function getDlink(f, ctx) {
  if (f.dlink) return f.dlink;
  const fidlist = encodeURIComponent(JSON.stringify([String(f.fs_id)]));
  const baseParams =
    `fidlist=${fidlist}&shorturl=${ctx.surl}&app_id=250528` +
    `&jsToken=${encodeURIComponent(ctx.jsToken)}` +
    `&shareid=${encodeURIComponent(ctx.shareid)}` +
    `&uk=${encodeURIComponent(ctx.uk)}` +
    `&sign=${encodeURIComponent(ctx.sign)}` +
    `&timestamp=${encodeURIComponent(ctx.timestamp)}`;
  let d = await tryFetchJson(`https://${ctx.finalHost}/api/download?${baseParams}`, ctx.apiHeaders);
  if (d && d.dlink) return d.dlink;
  d = await tryFetchJson(`https://${ctx.finalHost}/share/download?${baseParams}`, ctx.apiHeaders);
  if (d && d.dlink) return d.dlink;
  return null;
}

async function resolveFolders(list, ctx, depth = 0) {
  if (depth > 3) return list; // safety cap
  const out = [];
  for (const f of list) {
    if (isDir(f) && f.path) {
      const dirPath = encodeURIComponent(f.path);
      const d = await tryFetchJson(
        `https://${ctx.finalHost}/share/list?app_id=250528&shorturl=${ctx.surl}` +
        `&root=0&dir=${dirPath}&page=1&num=100&order=time&desc=1` +
        `&jsToken=${encodeURIComponent(ctx.jsToken)}` +
        `&shareid=${encodeURIComponent(ctx.shareid)}` +
        `&uk=${encodeURIComponent(ctx.uk)}`,
        ctx.apiHeaders
      );
      if (d?.errno === 0 && d.list?.length) {
        out.push(...await resolveFolders(d.list, ctx, depth + 1));
      } else {
        out.push(f);
      }
    } else {
      out.push(f);
    }
  }
  return out;
}

async function getTeraboxLinks(shareUrl) {
  const surl = extractSurl(shareUrl);
  const parsedUrl = new URL(shareUrl.startsWith('http') ? shareUrl : 'https://' + shareUrl);
  const originHost = parsedUrl.hostname;

  // ── Step 1: open share page → collect session cookies + jsToken
  const candidates = [originHost, 'www.1024tera.com', '1024terabox.com', 'www.terabox.com', 'terabox.app'];
  let html = '', cookies = '', finalUrl = '', jsToken = '';

  for (const host of candidates) {
    try {
      const r = await fetchChain(`https://${host}/s/${surl}`, {
        'User-Agent': UA_DESKTOP,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
      });
      if (r.html.length > 0) {
        html = r.html; cookies = r.cookies; finalUrl = r.finalUrl;
        jsToken = extractJsToken(html);
        if (jsToken) break;
      }
    } catch { /* try next mirror */ }
  }

  if (!jsToken) {
    throw new Error(
      `Could not extract jsToken. html length: ${html.length}. ` +
      'Site may have updated or share token is invalid.'
    );
  }

  const finalHost = new URL(finalUrl).hostname;
  const apiHeaders = {
    'User-Agent': UA_DESKTOP,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: finalUrl,
    Cookie: cookies,
    'X-Requested-With': 'XMLHttpRequest',
  };

  // ── Step 2: /api/shorturlinfo → shareid/uk/sign/timestamp + flat list
  const info = await tryFetchJson(
    `https://${finalHost}/api/shorturlinfo?app_id=250528&shorturl=${surl}` +
    `&root=1&jsToken=${encodeURIComponent(jsToken)}`,
    { ...apiHeaders, Referer: `https://${finalHost}/s/${surl}` }
  );

  if (!info || info.errno !== 0) {
    throw new Error(
      `TeraBox error ${info?.errno || 'unknown'}: ${info?.errmsg || 'no data'} | ` +
      `jsToken: ${jsToken ? 'YES(' + jsToken.slice(0, 10) + '...)' : 'NO'} | ` +
      `cookies: ${cookies ? cookies.slice(0, 50) + '...' : 'none'}`
    );
  }

  const ctx = {
    finalHost,
    apiHeaders,
    surl,
    jsToken,
    shareid: info.shareid || '',
    uk: info.uk || '',
    sign: info.sign || '',
    timestamp: info.timestamp || '',
  };

  // ── Step 3: recursively resolve nested folders
  const resolved = await resolveFolders(info.list || [], ctx);

  // ── Step 4: attach signed dlink to each file
  const files = [];
  for (const f of resolved) {
    const item = { ...f };
    if (!isDir(f)) item.dlink = await getDlink(f, ctx);
    files.push(item);
  }

  return formatResult({ ...info, list: files }, surl);
}

function formatResult(data, surl) {
  const list = data.list || [];
  const files = list.map((f) => ({
    filename: f.server_filename,
    size: formatBytes(f.size),
    size_bytes: f.size,
    is_dir: isDir(f),
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

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + u[i];
}
