// api/terabox.js — v7 (Flow-contract compatible, verify_v2-gate-aware)
// ┌───────────────────────────────────────────────────────────────────────┐
// │ v7 — adds two honesty gates that v6 was missing after live probing.   │
// │                                                                       │
// │ Live sandbox trace (this turn, surl 1UlFrS6ugBwq_VrXdFnnsVw, fs_id    │
// │ 935939240832008):                                                     │
// │   /api/shorturlinfo?shorturl=1<surl>&root=1&jsToken=… (Chrome UA,    │
// │     Referer: https://www.terabox.com/s/<surl>, full TeraBox cookie    │
// │     jar harvested from the share page) →                              │
// │     errno=0   shareid=60589288603   uk=4398275714208                  │
// │     sign=51ad2d9308887bf6c30461fc67a0c50f943c005a                    │
// │     timestamp=1786696549                                              │
// │   /share/download?…&fid_list=[fs_id]&primaryid=…&sign=…&ts=… →        │
// │     errno=400310 errmsg="need verify_v2"                              │
// │   /api/download?…signed-params → errno=-6                              │
// │   /share/tplist?…&shorturl=… → 6 KB static HTML, not a JSON endpoint  │
// │   mirror www.1024tera.com → errno=400210                               │
// │   mirror dm.terabox.app    → errno=400210                               │
// │   mirror www.teraboxapp.com → errno=400210                              │
// │   POST /share/download w/ mobile JSON body → errno=400310              │
// │                                                                       │
// │ ┌───────────────────────────────────────────────────────────────────┐ │
// │ │ VERDICT                                                            │ ││
// │ │ dlink extraction is BLOCKED at the server tier when there is no    │ ││
// │ │ ndus cookie. TeraBox requires a browser session for any             │ ││
// │ │ /share/download to succeed. Vercel/Cloudflare-Worker IPs, fresh     │ ││
// │ │ IPs in general, all return errno 400310.                            │ ││
// │ │ The fix:                                                            │ ││
// │ │   1. Try 6 server-side endpoints (legacy browsers carry ndus)       │ ││
// │ │   2. If all fail, surface signed_info + top-level signed{} to the    │ ││
// │ │      caller so a client-side pass can finish with the user's own    │ ││
// │ │      cookie (Telegram-bot user, browser extension, PWA, etc.)       │ ││
// │ │   3. Optional ?resolver=flow|thundersave points at a hosted proxy    │ ││
/// │      that already has ndus cookies                                   │ │
// │ └───────────────────────────────────────────────────────────────────┘ │
// └───────────────────────────────────────────────────────────────────────┘

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const TB_HOSTS = [
  'www.1024tera.com','1024terabox.com','www.terabox.com','terabox.app',
  'teraboxapp.com','nephobox.com','mirrobox.com','freeterabox.com',
  '4funbox.com','tibibox.com','momerybox.com'
];

// Resolver-chain hook. Each one is a third-party service that already has a
// populated ndus session. Set ?resolver=flow (or thundersave) and we'll try it.
const RESOLVERS = {
  flow:       { host: 'flowvideoplayer.com', path: '/video/download',
                method: 'POST',
                bodyShape: d => ({ url: d.fast_stream_url || d.download_url }) },
  thundersave:{ host: 'thundersave.com',     path: '/api/terabox-dl',
                method: 'POST',
                bodyShape: d => ({ surl: d.surl, fs_id: d.fs_id }) },
  none: null
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = (req.method === 'POST' ? req.body?.url : req.query?.url) || '';
  const resolverName = (req.method === 'POST' ? req.body?.resolver : req.query?.resolver) || 'none';
  const resolver = RESOLVERS[resolverName] || RESOLVERS.none;
  if (!url) return res.status(400).json({ status: false, code: 400, message: 'URL required' });

  try {
    const clientCookie = getClientTeraBoxCookie(req);
    const data = await getTeraboxLinks(url.trim(), { resolver, cookie: clientCookie });
    const anyDlink = (data.files || []).some(f => f.dlink);
    return res.status(200).json({
      status: true,
      message: anyDlink
        ? 'ok'
        : 'partial — TeraBox verify_v2 gate engaged; signed block returned for client-side completion',
      response: data.response,
      success: true, surl: data.surl, share_title: data.share_title,
      total_files: data.total_files, files: data.files, download_links: data.download_links,
      signed: data.signed,
      verify_v2_required: !anyDlink,
      download_ready: anyDlink,
      download_requires_cookie: !anyDlink,
      // Mirror Flow Video Player's response shape (file_name, file_size, ...)
      message_human: anyDlink
        ? `Resolved ${data.total_files} file(s) with direct download links`
        : `Resolved ${data.total_files} file(s) metadata; dlink requires browser-cookie session — client should call signed_info with ndus cookie`
    });
  } catch (err) {
    return res.status(500).json({ status: false, success: false, code: 500, message: err.message });
  }
};

// A TeraBox share page normally gives metadata without authentication, but
// /share/download now requires the caller's browser session (the `ndus`
// cookie). Never use the app's own Cookie header here: it belongs to the
// Vercel request and may contain unrelated application cookies. Callers that
// have a TeraBox browser session can pass it explicitly in X-TeraBox-Cookie,
// or pass only the token in X-TeraBox-Ndus.
function getClientTeraBoxCookie(req) {
  const headerCookie = req.headers?.['x-terabox-cookie'];
  const headerNdus = req.headers?.['x-terabox-ndus'];
  const body = req.method === 'POST' && req.body ? req.body : {};
  const query = req.query || {};
  const rawCookie = headerCookie || body.terabox_cookie || query.terabox_cookie || '';
  const ndus = headerNdus || body.ndus || query.ndus || '';

  const cookie = typeof rawCookie === 'string' ? rawCookie.trim() : '';
  if (cookie) return ndus ? `${cookie}; ndus=${String(ndus).trim()}` : cookie;
  return ndus ? `ndus=${String(ndus).trim()}` : '';
}

// ─── URL parsing ──────────────────────────────────────────────────────────
function extractSurl(rawUrl) {
  if (!rawUrl.startsWith('http')) rawUrl = 'https://' + rawUrl;
  const u = new URL(rawUrl);
  const m = u.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const s = u.searchParams.get('surl');
  if (s) return s;
  throw new Error('Cannot extract share token from URL');
}

function cookieObjFromHeader(raw) {
  const out = {}; if (!raw) return out;
  for (const part of raw.split(/,(?=\s*[a-zA-Z_-]+=)/)) {
    const [kv] = part.split(';');
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return out;
}
function cookieStr(obj) { return Object.entries(obj).map(([k,v]) => `${k}=${v}`).join('; '); }
function mergeCookies(...headers) {
  const merged = {};
  for (const header of headers) {
    Object.assign(merged, cookieObjFromHeader(header));
  }
  return cookieStr(merged);
}

async function fetchChain(startUrl, baseHeaders) {
  let url = startUrl, cookies = {}, html = '', finalUrl = startUrl;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, { headers: { ...baseHeaders, Cookie: cookieStr(cookies) }, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) Object.assign(cookies, cookieObjFromHeader(sc));
    if (res.status >= 300 && res.status < 400) {
      let loc = res.headers.get('location') || '';
      if (!loc) break;
      if (!loc.startsWith('http')) loc = new URL(loc, url).href;
      url = loc; continue;
    }
    html = await res.text(); finalUrl = url; break;
  }
  return { cookies: cookieStr(cookies), cookieObj: cookies, html, finalUrl };
}

// v6 BUG FIX #1 — jsToken extraction.
function extractJsToken(html) {
  const m = html.match(/eval\s*\(\s*decodeURIComponent\s*\(\s*`([\s\S]{0,4000}?)`\s*\)\s*\)/);
  if (m) {
    try {
      const decoded = decodeURIComponent(m[1]);
      const inner  = decoded.match(/window\.jsToken\s*=\s*['"]([A-Za-z0-9_+/=]+)['"]/);
      if (inner) return inner[1];
      const inner2 = decoded.match(/fn\s*\(\s*['"]([A-Za-z0-9%_+/=]+)['"]\s*\)/);
      if (inner2) return decodeURIComponent(inner2[1]);
    } catch (_) {}
  }
  try {
    const m1 = html.match(/fn%28%22([A-Za-z0-9%_+/=\-]{16,})%22%29/);
    if (m1) return decodeURIComponent(m1[1]);
  } catch (_) {}
  const m2 = html.match(/fn\s*\(\s*['"]([A-Za-z0-9%_+/=\-]{16,})['"]\s*\)/);
  if (m2) { try { return decodeURIComponent(m2[1]); } catch { return m2[1]; } }
  const m3 = html.match(/window\.jsToken\s*=\s*['"]?([A-Za-z0-9%_+/=\-]{16,})/i);
  if (m3) { try { return decodeURIComponent(m3[1]); } catch { return m3[1]; } }
  return '';
}

function isDir(f) {
  const v = f.isdir ?? f.is_dir;
  return v === '1' || v === 1 || v === true || v === 'true';
}

async function tryJson(url, headers) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    return await res.json();
  } catch { return null; }
}

async function tryJsonRequest(url, options) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    return await res.json();
  } catch { return null; }
}

// v6/v7 BUG FIX #2 — full signed-token quartet; v7 expands the endpoint pool to 6.
async function getDlink(f, ctx) {
  if (f.dlink) return f.dlink;
  const fidlist = encodeURIComponent(JSON.stringify([String(f.fs_id)]));
  const base =
    `app_id=250528&shorturl=${encodeURIComponent(ctx.surl)}` +
    `&jsToken=${encodeURIComponent(ctx.jsToken)}` +
    `&shareid=${encodeURIComponent(ctx.shareid)}` +
    `&uk=${encodeURIComponent(ctx.uk)}` +
    `&sign=${encodeURIComponent(ctx.sign)}` +
    `&timestamp=${encodeURIComponent(ctx.timestamp)}` +
    `&fid_list=${fidlist}`;

  const endpointPool = [
    `https://${ctx.finalHost}/share/download?${base}&primaryid=${encodeURIComponent(ctx.shareid)}&channel=chunlei&clienttype=0&web=1&vuk=${ctx.uk}`,
    `https://${ctx.finalHost}/api/download?${base}&primaryid=${encodeURIComponent(ctx.shareid)}&channel=chunlei&clienttype=0&web=1&vuk=${ctx.uk}`,
    `https://${ctx.finalHost}/api/sharedownload?${base}&primaryid=${encodeURIComponent(ctx.shareid)}`,
    `https://${ctx.finalHost}/share/download?app_id=250528&channel=chunlei&clienttype=0&sign=${encodeURIComponent(ctx.sign)}&timestamp=${encodeURIComponent(ctx.timestamp)}&fid_list=${fidlist}&primaryid=${encodeURIComponent(ctx.shareid)}&uk=${encodeURIComponent(ctx.uk)}&shareid=${encodeURIComponent(ctx.shareid)}&shorturl=${encodeURIComponent(ctx.surl)}&jsToken=${encodeURIComponent(ctx.jsToken)}`,
    `https://${ctx.finalHost}/share/list?app_id=250528&channel=chunlei&clienttype=0&num=1&page=1&order=time&desc=1&showempty=0&sign=${encodeURIComponent(ctx.sign)}&timestamp=${encodeURIComponent(ctx.timestamp)}&fid_list=${fidlist}&shareid=${encodeURIComponent(ctx.shareid)}&uk=${encodeURIComponent(ctx.uk)}&jsToken=${encodeURIComponent(ctx.jsToken)}&root=0`,
    `https://${ctx.finalHost}/share/download?app_id=250528&channel=chunlei&clienttype=0&sign=${encodeURIComponent(ctx.sign)}&timestamp=${encodeURIComponent(ctx.timestamp)}&fid_list=${fidlist}&shareid=${encodeURIComponent(ctx.shareid)}&uk=${encodeURIComponent(ctx.uk)}&jsToken=${encodeURIComponent(ctx.jsToken)}`
  ];

  for (const url of endpointPool) {
    const d = await tryJson(url, ctx.apiHeaders);
    if (d && (d.dlink || d.download_url)) return d.dlink || d.download_url;
  }

  // The current web API also accepts form-encoded requests. The old code sent
  // JSON here, which is silently rejected by some TeraBox mirrors.
  for (const path of ['/share/download', '/api/download']) {
    const form = new URLSearchParams({
      app_id: '250528',
      channel: 'chunlei',
      clienttype: '0',
      web: '1',
      sign: String(ctx.sign),
      timestamp: String(ctx.timestamp),
      jsToken: String(ctx.jsToken),
      fid_list: JSON.stringify([String(f.fs_id)]),
      primaryid: String(ctx.shareid),
      shareid: String(ctx.shareid),
      shorturl: String(ctx.surl),
      uk: String(ctx.uk),
      vuk: String(ctx.uk),
    });
    const d = await tryJsonRequest(`https://${ctx.finalHost}${path}`, {
      method: 'POST',
      headers: { ...ctx.apiHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (d && (d.dlink || d.download_url)) return d.dlink || d.download_url;
  }

  // filemetas is the fallback used by the official web client and by the
  // current terabox-api package. It needs the same ndus session when the
  // share/download gate is active, but is worth trying before giving up.
  const meta = await tryJsonRequest(`https://${ctx.finalHost}/api/filemetas`, {
    method: 'POST',
    headers: { ...ctx.apiHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      dlink: '1',
      origin: 'dlna',
      target: JSON.stringify([{
        fs_id: String(f.fs_id),
        path: f.path || '',
        server_filename: f.server_filename || '',
      }]),
    }).toString(),
  });
  const metaDlink = meta?.dlink || meta?.download_url || meta?.data?.dlink ||
    meta?.data?.download_url || meta?.data?.list?.[0]?.dlink;
  if (metaDlink) return metaDlink;

  // POST attempts (mobile client style) kept as a final compatibility
  // fallback for older mirrors.
  for (const path of ['/share/download', '/api/download']) {
    const d = await tryJsonRequest(
      `https://${ctx.finalHost}${path}?app_id=250528&channel=chunlei&clienttype=0&sign=${encodeURIComponent(ctx.sign)}&timestamp=${encodeURIComponent(ctx.timestamp)}&jsToken=${encodeURIComponent(ctx.jsToken)}`,
      {
        method: 'POST',
        headers: { ...ctx.apiHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fid_list: [String(f.fs_id)], primaryid: ctx.shareid, uk: ctx.uk,
          shareid: ctx.shareid, shorturl: ctx.surl, vuk: ctx.uk
        })
      }
    );
    if (d && (d.dlink || d.download_url)) return d.dlink || d.download_url;
  }

  // Resolver-chain fallback (third-party service already has ndus)
  if (ctx.resolver) {
    try {
      const rc = ctx.resolver;
      const r = await fetch(`https://${rc.host}${rc.path}`, {
        method: rc.method,
        headers: { 'Content-Type':'application/json','Accept':'application/json',
                   'User-Agent': UA_DESKTOP, 'X-Requested-With':'XMLHttpRequest' },
        body: JSON.stringify(rc.bodyShape({ surl: ctx.surl, fs_id: String(f.fs_id),
                                            fast_stream_url: ctx.finalUrl, download_url: ctx.finalUrl }))
      });
      if (r.ok) {
        const d = await r.json();
        if (d && (d.dlink || d.download_url)) return d.dlink || d.download_url;
      }
    } catch (_) {}
  }
  return null;
}

// v6 BUG FIX #3 — resolve nested folders before stamping dlinks
async function resolveFolders(list, ctx, depth = 0) {
  if (depth > 3) return list;
  const out = [];
  for (const f of list) {
    if (isDir(f) && f.path) {
      const dirPath = encodeURIComponent(f.path);
      const d = await tryJson(
        `https://${ctx.finalHost}/share/list?app_id=250528` +
        `&shorturl=${encodeURIComponent(ctx.surl)}&root=0` +
        `&dir=${dirPath}&page=1&num=100&order=time&desc=1` +
        `&jsToken=${encodeURIComponent(ctx.jsToken)}` +
        `&shareid=${encodeURIComponent(ctx.shareid)}` +
        `&uk=${encodeURIComponent(ctx.uk)}`,
        ctx.apiHeaders
      );
      if (d && d.errno === 0 && Array.isArray(d.list) && d.list.length) {
        out.push(...await resolveFolders(d.list, ctx, depth + 1));
      } else {
        out.push({ ...f, _unresolved: true });
      }
    } else {
      out.push(f);
    }
  }
  return out;
}

async function getTeraboxLinks(shareUrl, opts = {}) {
  const surl = extractSurl(shareUrl);
  let html = '', cookies = '', finalUrl = '', jsToken = '';

  for (const host of TB_HOSTS) {
    try {
      const r = await fetchChain(`https://${host}/s/${surl}`, {
        'User-Agent': UA_DESKTOP,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
      }, opts.cookie || '');
      if (r.html.length > 5000) {
        html = r.html; cookies = r.cookies; finalUrl = r.finalUrl;
        jsToken = extractJsToken(html);
        if (jsToken) break;
      }
    } catch (_) {}
  }

  if (!jsToken) throw new Error(`jsToken extraction failed (html ${html.length} chars)`);
  const finalHost = new URL(finalUrl).hostname;

  const apiHeaders = {
    'User-Agent': UA_DESKTOP,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: finalUrl, Cookie: mergeCookies(cookies, opts.cookie || ''),
    'X-Requested-With': 'XMLHttpRequest',
  };

  const info = await tryJson(
    `https://${finalHost}/api/shorturlinfo?app_id=250528&shorturl=${surl}&root=1` +
    `&jsToken=${encodeURIComponent(jsToken)}`,
    apiHeaders
  );
  if (!info || info.errno !== 0) {
    throw new Error(`TeraBox errno ${info?.errno}: ${info?.errmsg}`);
  }

  const ctx = {
    finalHost, apiHeaders, surl, jsToken,
    shareid: info.shareid || '', uk: info.uk || '',
    sign: info.sign || '', timestamp: String(info.timestamp || ''),
    finalUrl,
    resolver: opts.resolver || null,
  };

  const resolved = await resolveFolders(info.list || [], ctx);
  const files = [];
  for (const f of resolved) {
    const item = { ...f };
    if (!isDir(f)) item.dlink = await getDlink(f, ctx);
    files.push(item);
  }

  // v7 — full signed block, even when dlink=null
  const signed = {
    shareid: ctx.shareid, uk: ctx.uk, sign: ctx.sign, timestamp: ctx.timestamp,
    jsToken: ctx.jsToken, shorturl: ctx.surl, final_host: ctx.finalHost, final_url: ctx.finalUrl,
    fid_list: files.filter(f => !isDir(f)).map(f => String(f.fs_id)),
    suggested_endpoint: `GET https://${ctx.finalHost}/share/download?app_id=250528&channel=chunlei&clienttype=0&web=1&sign=${encodeURIComponent(ctx.sign)}&timestamp=${encodeURIComponent(ctx.timestamp)}&fid_list=[<fs_id>]&primaryid=${encodeURIComponent(ctx.shareid)}&uk=${encodeURIComponent(ctx.uk)}&shareid=${encodeURIComponent(ctx.shareid)}&shorturl=${encodeURIComponent(ctx.surl)}&jsToken=${encodeURIComponent(ctx.jsToken)} (must have ndus cookie)`
  };
  return shapeForFlow(info, files, surl, signed);
}

function shapeForFlow(info, files, surl, signed) {
  const response = files.map((f) => ({
    file_name:       f.server_filename,
    file_size:       formatBytes(f.size),
    fast_stream_url: f.dlink || null,
    download_url:    f.dlink || null,
    thumbnail:       f.thumbs?.url3 || f.thumbs?.url1 || null,
    duration:        null,
    is_dir:          isDir(f),
    fs_id:           String(f.fs_id || ''),
    signed_info:     signed || null
  }));
  const download_links = files.filter(f => !isDir(f) && f.dlink)
    .map(f => ({ filename: f.server_filename, size: formatBytes(f.size), download_url: f.dlink }));
  return { surl, share_title: info.share_title || '', total_files: files.length, files, download_links, response, signed };
}

function formatBytes(b) {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b)/Math.log(1024));
  return (b/Math.pow(1024,i)).toFixed(2) + ' ' + u[i];
}
