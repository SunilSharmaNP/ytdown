// api/terabox.js — v6 (Flow-contract compatible, multi-provider)
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const TB_HOSTS = [
  'www.1024tera.com','1024terabox.com','www.terabox.com','terabox.app',
  'teraboxapp.com','nephobox.com','mirrobox.com','freeterabox.com',
  '4funbox.com','tibibox.com','momerybox.com'
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = req.method === 'POST' ? req.body?.url : req.query?.url;
  if (!url) return res.status(400).json({ status: false, code: 400, message: 'URL required' });

  try {
    const data = await getTeraboxLinks(url.trim());
    return res.status(200).json({
      status: true, message: 'ok', response: data.response,
      // back-compat — your old bot still works
      success: true, surl: data.surl, share_title: data.share_title,
      total_files: data.total_files, files: data.files, download_links: data.download_links
    });
  } catch (err) {
    return res.status(500).json({ status: false, success: false, code: 500, message: err.message });
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

// BUG FIX #1 — jsToken extraction
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

// BUG FIX #2 — full signed-token quartet on per-file download call
async function getDlink(f, ctx) {
  if (f.dlink) return f.dlink;
  const fidlist = encodeURIComponent(JSON.stringify([String(f.fs_id)]));
  const baseParams =
    `app_id=250528&shorturl=${encodeURIComponent(ctx.surl)}` +
    `&jsToken=${encodeURIComponent(ctx.jsToken)}` +
    `&shareid=${encodeURIComponent(ctx.shareid)}` +
    `&uk=${encodeURIComponent(ctx.uk)}` +
    `&sign=${encodeURIComponent(ctx.sign)}` +
    `&timestamp=${encodeURIComponent(ctx.timestamp)}` +
    `&fidlist=${fidlist}`;
  for (const path of ['/share/download', '/api/download']) {
    const d = await tryJson(`https://${ctx.finalHost}${path}?${baseParams}`, ctx.apiHeaders);
    if (d && (d.dlink || d.download_url)) return d.dlink || d.download_url;
  }
  return null;
}

// BUG FIX #3 — resolve nested folders before stamping dlinks
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

async function getTeraboxLinks(shareUrl) {
  const surl = extractSurl(shareUrl);
  let html = '', cookies = '', finalUrl = '', jsToken = '';

  for (const host of TB_HOSTS) {
    try {
      const r = await fetchChain(`https://${host}/s/${surl}`, {
        'User-Agent': UA_DESKTOP,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
      });
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
    Referer: finalUrl, Cookie: cookies,
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
    sign: info.sign || '', timestamp: String(info.timestamp || '')
  };

  const resolved = await resolveFolders(info.list || [], ctx);
  const files = [];
  for (const f of resolved) {
    const item = { ...f };
    if (!isDir(f)) item.dlink = await getDlink(f, ctx);
    files.push(item);
  }
  return shapeForFlow(info, files, surl);
}

function shapeForFlow(info, files, surl) {
  const response = files.map((f) => ({
    file_name:      f.server_filename,
    file_size:      formatBytes(f.size),
    fast_stream_url: f.dlink || null,
    download_url:   f.dlink || null,
    thumbnail:      f.thumbs?.url3 || f.thumbs?.url1 || null,
    duration:       null,
    is_dir:         isDir(f),
    fs_id:          String(f.fs_id || ''),
  }));
  const download_links = files.filter(f => !isDir(f) && f.dlink)
    .map(f => ({ filename: f.server_filename, size: formatBytes(f.size), download_url: f.dlink }));
  return { surl, share_title: info.share_title || '', total_files: files.length, files, download_links, response };
}

function formatBytes(b) {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(2) + ' ' + u[i];
}
