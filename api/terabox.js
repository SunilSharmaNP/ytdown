
// api/terabox.js
// TeraBox Direct Download Link Generator — Vercel Serverless Function

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = req.method === 'POST' ? req.body?.url : req.query?.url;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'URL required. Use ?url=<terabox_link> or POST { "url": "..." }',
    });
  }

  try {
    const data = await getTeraboxLinks(url.trim());
    res.status(200).json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ── Extract surl from any TeraBox domain ──────────────────────────────────────
function extractSurl(rawUrl) {
  if (!rawUrl.startsWith('http')) rawUrl = 'https://' + rawUrl;
  const u = new URL(rawUrl);
  const m = u.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const s = u.searchParams.get('surl');
  if (s) return s;
  throw new Error('Cannot extract share token from URL. Supported formats: /s/<token> or ?surl=<token>');
}

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.terabox.com/',
  Origin: 'https://www.terabox.com',
};

// ── Main logic ────────────────────────────────────────────────────────────────
async function getTeraboxLinks(shareUrl) {
  const surl = extractSurl(shareUrl);

  // TeraBox public share-info endpoint (no auth required)
  const apiUrl =
    `https://www.terabox.com/api/shorturlinfo?app_id=250528&shorturl=${surl}&root=1`;

  const res = await fetch(apiUrl, { headers: HEADERS });
  if (!res.ok) throw new Error(`TeraBox API responded with HTTP ${res.status}`);

  const data = await res.json();

  if (data.errno !== 0) {
    throw new Error(
      `TeraBox error ${data.errno}: ${data.errmsg || 'Link may be expired or private'}`
    );
  }

  if (!data.list?.length) throw new Error('No files found in this link');

  // Build file list
  const files = data.list.map((f) => ({
    filename: f.server_filename,
    size: formatBytes(f.size),
    size_bytes: f.size,
    is_dir: !!f.isdir,
    fs_id: String(f.fs_id),
    dlink: f.dlink || null,                 // direct download link
    thumbnail: f.thumbs?.url3 || null,
    category: f.category,                   // 1=video, 3=image, 4=doc, etc.
  }));

  // Only non-folder files with a dlink
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
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}
