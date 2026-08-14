// api/terabox.js — Fixed: handles verify_v2 by extracting session cookies + jsToken

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = req.method === 'POST' ? req.body?.url : req.query?.url;
  if (!url)
    return res.status(400).json({ success: false, error: 'URL required' });

  try {
    const data = await getTeraboxLinks(url.trim());
    res.status(200).json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ── Extract surl token ────────────────────────────────────────────────────────
function extractSurl(rawUrl) {
  if (!rawUrl.startsWith('http')) rawUrl = 'https://' + rawUrl;
  const u = new URL(rawUrl);
  const m = u.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const s = u.searchParams.get('surl');
  if (s) return s;
  throw new Error('Cannot extract share token from URL');
}

const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ── Parse Set-Cookie header into a flat cookie string ────────────────────────
function parseCookies(raw) {
  if (!raw) return '';
  const arr = Array.isArray(raw) ? raw : raw.split(/,(?=[^ ])/);
  return arr.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function getTeraboxLinks(shareUrl) {
  const surl = extractSurl(shareUrl);

  // ── Step 1: Visit the share page to collect session cookies + jsToken ──────
  const sharePage = `https://www.terabox.com/s/${surl}`;
  const pageRes = await fetch(sharePage, {
    headers: BASE_HEADERS,
    redirect: 'follow',
  });

  const cookieStr = parseCookies(pageRes.headers.get('set-cookie'));
  const html = await pageRes.text();

  // Extract jsToken (required for API calls)
  const jsTokenMatch =
    html.match(/window\.jsToken\s*=\s*["']?([A-Za-z0-9%_+=/-]{10,})/) ||
    html.match(/jsToken["'\s]*[:=]["'\s]*([A-Za-z0-9%_+=/-]{10,})/);
  const jsToken = jsTokenMatch ? decodeURIComponent(jsTokenMatch[1]) : '';

  // Extract bdstoken (optional but helps)
  const bdstokenMatch = html.match(/bdstoken["'\s:=]+([a-zA-Z0-9]{16,})/);
  const bdstoken = bdstokenMatch ? bdstokenMatch[1] : '';

  const apiHeaders = {
    'User-Agent': BASE_HEADERS['User-Agent'],
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: sharePage,
    Cookie: cookieStr,
  };

  // ── Step 2: Use share/list endpoint (avoids verify_v2) ───────────────────
  let data = await tryShareList(surl, jsToken, bdstoken, apiHeaders);

  // ── Fallback: shorturlinfo with session cookies ───────────────────────────
  if (!data) {
    data = await tryShortUrlInfo(surl, jsToken, apiHeaders);
  }

  if (!data) throw new Error('All endpoints failed. TeraBox may have blocked this region.');

  if (data.errno !== 0) {
    throw new Error(
      `TeraBox error ${data.errno}: ${data.errmsg || 'Link expired or private'}`
    );
  }

  const list = data.list || data.records || [];
  if (!list.length) throw new Error('No files found in this link');

  const files = list.map((f) => ({
    filename: f.server_filename,
    size: formatBytes(f.size),
    size_bytes: f.size,
    is_dir: !!f.isdir,
    fs_id: String(f.fs_id),
    dlink: f.dlink || null,
    thumbnail: f.thumbs?.url3 || null,
    category: f.category,
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
    share_title: data.share_title || data.title || '',
    total_files: files.length,
    files,
    download_links,
  };
}

// ── Endpoint A: share/list ────────────────────────────────────────────────────
async function tryShareList(surl, jsToken, bdstoken, headers) {
  try {
    const url =
      `https://www.terabox.com/share/list` +
      `?app_id=250528&shorturl=${surl}&root=1` +
      `&page=1&num=20&order=time&desc=1` +
      `&jsToken=${encodeURIComponent(jsToken)}` +
      `&bdstoken=${bdstoken}`;

    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const json = await res.json();
    // errno 0 or actual list = success; anything else fall through
    if (json.errno === 400210) return null; // still needs verify, try next
    return json;
  } catch {
    return null;
  }
}

// ── Endpoint B: shorturlinfo (with session cookies now) ───────────────────────
async function tryShortUrlInfo(surl, jsToken, headers) {
  try {
    const url =
      `https://www.terabox.com/api/shorturlinfo` +
      `?app_id=250528&shorturl=${surl}&root=1` +
      `&jsToken=${encodeURIComponent(jsToken)}`;

    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + u[i];
}
