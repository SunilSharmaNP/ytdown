// api/terabox.js — v5: fixed jsToken extraction + isdir normalization + dlink via /api/download

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

// ── Extract jsToken — FIXED (Bug #1) ─────────────────────────────────────────
// Real token is injected as:
//   eval(decodeURIComponent(`function%20fn%28a%29%7Bwindow.jsToken%20%3D%20a%7D%3Bfn%28%22<TOKEN>%22%29`))
function extractJsToken(html) {
  const m1 = html.match(/fn%28%22([A-Za-z0-9%_+=\/-]{16,})%22%29/);
  if (m1) return decodeURIComponent(m1[1]);
  const m2 = html.match(/fn\(["']([A-Za-z0-9%_+=\/-]{16,})["']\)/);
  if (m2) return m2[1];
  const m3 = html.match(/window\.jsToken\s*=\s*["']?([A-Za-z0-9%_+=\/-]{16,})/i);
  if (m3) return decodeURIComponent(m3[1]);
  return '';
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

// ── is_dir normalization — FIXED (Bug #2) ────────────────────────────────────
// TeraBox returns isdir as STRING "0"/"1", NOT boolean. Old code's !!f.isdir
// treated "0" (a file) as truthy → every file was misread as a folder.
function isDir(f) {
  return f.isdir === '1' || f.isdir === 1 || f.isdir === true;
}

// ── Get dlink for a file — NEW (Bug #3) ──────────────────────────────────────
// list items don't carry dlink; call /api/download with the file's fs_id.
async function getDlink(f, ctx) {
  const { finalHost, apiHeaders, surl, jsToken, shareid, uk, sign, timestamp } = ctx;
  const fidlist = encodeURIComponent(JSON.stringify([String(f.fs_id)]));
  const base =
    `https://${finalHost}/api/download?fidlist=${fidlist}&shorturl=${surl}` +
    `&app_id=250528&jsToken=${encodeURIComponent(jsToken)}` +
    `&shareid=${shareid}&uk=${uk}&sign=${encodeURIComponent(sign)}&timestamp=${timestamp}`;
  const d = await tryFetch(base, { ...apiHeaders, Referer: `https://${finalHost}/s/${surl}` });
  if (d && d.errno === 0 && d.dlink) return d.dlink;

  // fallback endpoint
  const base2 =
    `https://${finalHost}/share/download?fidlist=${fidlist}&shorturl=${surl}` +
    `&app_id=250528&jsToken=${encodeURIComponent(jsToken)}` +
    `&shareid=${shareid}&uk=${uk}&sign=${encodeURIComponent(sign)}&timestamp=${timestamp}`;
  const d2 = await tryFetch(base2, { ...apiHeaders, Referer: `https://${finalHost}/s/${surl}` });
  if (d2 && d2.errno === 0 && d2.dlink) return d2.dlink;

  return null;
}

// ── Resolve folders recursively (with shareid/uk — FIXED) ────────────────────
async function resolveFiles(list, ctx, depth = 0) {
  if (depth > 3) return list;
  const allFiles = [];

  for (const f of list) {
    if (isDir(f) && f.path) {
      const dirPath = encodeURIComponent(f.path);
      const d = await tryFetch(
        `https://${ctx.finalHost}/share/list?app_id=250528&shorturl=${ctx.surl}&root=0` +
        `&dir=${dirPath}&page=1&num=100&order=time&desc=1` +
        `&jsToken=${encodeURIComponent(ctx.jsToken)}&shareid=${ctx.shareid}&uk=${ctx.uk}`,
        { ...ctx.apiHeaders, Referer: `https://${ctx.finalHost}/s/${ctx.surl}` }
      );
      if (d?.errno === 0 && d.list?.length) {
        const nested = await resolveFiles(d.list, ctx, depth + 1);
        allFiles.push(...nested);
      } else {
        allFiles.push(f);
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
  const jsToken = extractJsToken(html);

  const apiHeaders = {
    'User-Agent': UA_DESKTOP,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: finalUrl,
    Cookie: cookies,
    'X-Requested-With': 'XMLHttpRequest',
  };

  // Step 2 — shorturlinfo gives shareid/uk/sign/timestamp + root list
  const info = await tryFetch(
    `https://${finalHost}/api/shorturlinfo?app_id=250528&shorturl=${surl}&root=1&jsToken=${encodeURIComponent(jsToken)}`,
    { ...apiHeaders, Referer: `https://${finalHost}/s/${surl}` }
  );

  if (!info || info.errno !== 0) {
    throw new Error(
      `TeraBox shorturlinfo failed: errno=${info?.errno} | ` +
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

  // Step 3 — resolve folders recursively
  const resolved = await resolveFiles(info.list || [], ctx);

  // Step 4 — attach dlinks to every file
  const withDlinks = [];
  for (const f of resolved) {
    const item = { ...f };
    if (!isDir(f)) item.dlink = item.dlink || (await getDlink(f, ctx));
    withDlinks.push(item);
  }

  return formatResult({ ...info, list: withDlinks }, surl);
}

// ── Format final output ───────────────────────────────────────────────────────
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

// ── Utility ───────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + u[i];
}
