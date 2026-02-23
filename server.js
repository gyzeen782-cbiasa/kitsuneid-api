// ===== server.js — KitsuneID API (Railway) v2 =====
const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = 'https://otakudesu.best';
const SCRAPER_KEY = '2ae12f2df6c0a613015482e8131a38ab';

app.use(cors());
app.use(express.json());

// ── HTTP helpers ─────────────────────────────

// render=false → cepat, untuk listing/detail
function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render=false`;
    http.get(proxyUrl, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTML(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// render=true → untuk episode agar JS dieksekusi, player muncul
function fetchHTMLRendered(url) {
  return new Promise((resolve, reject) => {
    const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render=true`;
    http.get(proxyUrl, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTMLRendered(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function fetchPost(postUrl, body, referer) {
  return new Promise((resolve, reject) => {
    const u = new URL(postUrl);
    const buf = Buffer.from(body, 'utf-8');
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': buf.length,
        'Referer': referer,
        'Origin': BASE,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11; Redmi Note 10) AppleWebKit/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('POST Timeout')); });
    req.write(buf);
    req.end();
  });
}

// ── node-html-parser ─────────────────────────
const { parse } = require('node-html-parser');
const txt = el => el ? el.text.trim() : '';
const attr = (el, a) => el ? (el.getAttribute(a) || '') : '';
const getSrc = el => el ? (el.getAttribute('src') || el.getAttribute('data-src') || '') : '';
const getHref = el => el ? (el.getAttribute('href') || '') : '';
const toSlug = url => url
  .replace(BASE, '')
  .replace(/^\/(anime|episode)\//, '')
  .replace(/\/$/, '');

// FIX #1 — Parse nomor episode yang benar
// Cari "Episode X" dulu, fallback ke angka terakhir di judul
function parseEpNum(title, fallback) {
  if (!title) return fallback;
  const epMatch = title.match(/episode\s+(\d+)/i) || title.match(/\bep\.?\s*(\d+)/i);
  if (epMatch) return epMatch[1];
  const nums = title.match(/\d+/g);
  return nums ? nums[nums.length - 1] : fallback;
}

// ── SCRAPERS ─────────────────────────────────

async function scrapeOngoing(page = 1) {
  const url = page > 1
    ? `${BASE}/ongoing-anime/page/${page}/`
    : `${BASE}/ongoing-anime/`;
  const doc = parse(await fetchHTML(url));
  const animes = [];
  doc.querySelectorAll('.venz ul li').forEach(li => {
    const a = li.querySelector('a');
    const img = li.querySelector('img');
    const title = txt(li.querySelector('.jdlflm') || li.querySelector('h2') || a);
    const ep = txt(li.querySelector('.epz') || li.querySelector('.episode')).replace(/\D/g, '');
    const rating = txt(li.querySelector('.epztipe') || li.querySelector('.rattingflm')).replace(/[^0-9.]/g, '');
    const day = txt(li.querySelector('.epzdesc') || li.querySelector('.epsdate'));
    const animeUrl = getHref(a);
    if (!animeUrl.includes('/anime/')) return;
    const slug = toSlug(animeUrl);
    if (!slug || animes.find(x => x.slug === slug)) return;
    animes.push({ title, slug, url: animeUrl, thumb: getSrc(img), episode: ep || null, rating: rating || null, day: day || null, status: 'Ongoing', type: 'TV' });
  });
  return animes;
}

async function scrapeComplete(page = 1) {
  const url = page > 1
    ? `${BASE}/complete-anime/page/${page}/`
    : `${BASE}/complete-anime/`;
  const doc = parse(await fetchHTML(url));
  const animes = [];
  doc.querySelectorAll('.venz ul li').forEach(li => {
    const a = li.querySelector('a');
    const img = li.querySelector('img');
    const title = txt(li.querySelector('.jdlflm') || li.querySelector('h2') || a);
    const ep = txt(li.querySelector('.epz') || li.querySelector('.episode')).replace(/\D/g, '');
    const rating = txt(li.querySelector('.epztipe') || li.querySelector('.rattingflm')).replace(/[^0-9.]/g, '');
    const animeUrl = getHref(a);
    if (!animeUrl.includes('/anime/')) return;
    const slug = toSlug(animeUrl);
    if (!slug || animes.find(x => x.slug === slug)) return;
    animes.push({ title, slug, url: animeUrl, thumb: getSrc(img), episode: ep || null, rating: rating || null, status: 'Complete', type: 'TV' });
  });
  return animes;
}

async function scrapeSchedule() {
  const doc = parse(await fetchHTML(`${BASE}/jadwal-rilis/`));
  const schedules = [];
  doc.querySelectorAll('.kglist321').forEach(block => {
    const day = txt(block.querySelector('h2'));
    const animeList = block.querySelectorAll('ul li a').map(a2 => ({
      title: txt(a2), slug: toSlug(getHref(a2)), url: getHref(a2)
    }));
    if (day) schedules.push({ day, animeList });
  });
  return schedules;
}

async function scrapeSearch(query) {
  const doc = parse(await fetchHTML(`${BASE}/?s=${encodeURIComponent(query)}`));
  const results = [];
  doc.querySelectorAll('ul.chivsrc li').forEach(li => {
    const a = li.querySelector('a');
    const img = li.querySelector('img');
    const title = txt(li.querySelector('h2')) || txt(a);
    const animeUrl = getHref(a);
    if (!animeUrl) return;
    results.push({ title, slug: toSlug(animeUrl), url: animeUrl, thumb: getSrc(img), status: '' });
  });
  return results;
}

async function scrapeAnimeDetail(slug) {
  const html = await fetchHTML(`${BASE}/anime/${slug}/`);
  const doc = parse(html);

  const title = txt(doc.querySelector('h1.entry-title')) || txt(doc.querySelector('h1'));
  const thumb = getSrc(doc.querySelector('.fotoanime img'))
    || attr(doc.querySelector('meta[property="og:image"]'), 'content');

  // FIX #3 — Synopsis: coba lebih banyak selector
  let synopsis = '';
  const synSelectors = ['.sinopc p', '.sinopc', '.sinom p', '.sinom', '.entry-content p', '[itemprop="description"]'];
  for (const sel of synSelectors) {
    const els = doc.querySelectorAll(sel);
    if (els.length) {
      synopsis = els.map(e => txt(e)).filter(t => t.length > 20).join(' ');
      if (synopsis) break;
    }
  }
  if (!synopsis) synopsis = 'Tidak ada sinopsis.';

  const infoBolds = doc.querySelectorAll('.infozingle b');
  const getInfo = idx => {
    const b = infoBolds[idx];
    return b ? b.parentNode.text.replace(b.text, '').replace(':', '').trim() : null;
  };

  const genreEls = doc.querySelector('.infozingle')?.lastElementChild?.querySelectorAll('a') || [];
  const genres = genreEls.map(x => txt(x)).filter(Boolean);

  // FIX #1 — Nomor episode yang benar
  const episodes = [];
  for (const block of doc.querySelectorAll('.smokelister')) {
    const bt = block.text.toLowerCase();
    if (bt.includes('episode') && !bt.includes('batch')) {
      const epLinks = block.nextElementSibling?.querySelectorAll('li a') || [];
      epLinks.forEach((link, i) => {
        const epUrl = getHref(link);
        const epTitle = txt(link);
        const epSlug = toSlug(epUrl);
        if (epSlug) {
          episodes.push({
            title: epTitle,
            slug: epSlug,
            url: epUrl,
            episode: parseEpNum(epTitle, String(i + 1))
          });
        }
      });
      if (episodes.length > 0) break;
    }
  }
  episodes.reverse();

  return {
    title, thumb, synopsis,
    rating: getInfo(2), status: getInfo(5), type: getInfo(4),
    episode: getInfo(6) || String(episodes.length) || '?',
    duration: getInfo(7), aired: getInfo(8), studio: getInfo(9),
    genres, episodes, slug,
  };
}

async function scrapeEpisode(epSlug) {
  const url = `${BASE}/episode/${epSlug}/`;

  // FIX #2 — render=true agar JS dieksekusi dan player muncul
  console.log('Fetching episode with render=true:', epSlug);
  const html = await fetchHTMLRendered(url);
  const doc = parse(html);

  const scripts = doc.querySelectorAll('script').map(s => s.text).join('\n');
  const actionMatches = [...scripts.matchAll(/action\s*[:=]\s*["']([^"']+)["']/g)].map(m => m[1]);
  const uniqueActions = [...new Set(actionMatches)];

  let nonce = '';
  const nonceAction = uniqueActions.find(a => a.toLowerCase().includes('nonce'));
  const mainAction = uniqueActions.find(a => !a.toLowerCase().includes('nonce') && a !== nonceAction);

  if (nonceAction) {
    try {
      const nonceBody = new URLSearchParams({ action: nonceAction }).toString();
      const nonceRes = await fetchPost(`${BASE}/wp-admin/admin-ajax.php`, nonceBody, url);
      const nonceJson = JSON.parse(nonceRes);
      nonce = nonceJson.data || '';
      console.log('Nonce:', nonce ? '✓' : '✗');
    } catch(e) {
      console.error('Nonce error:', e.message);
    }
  }

  const servers = [];

  // Cek direct iframe dulu
  const defaultIframe = doc.querySelector('.player-embed iframe')
    || doc.querySelector('#pembed iframe')
    || doc.querySelector('iframe[src*="embed"]')
    || doc.querySelector('iframe[src*="video"]');
  if (defaultIframe) {
    const iSrc = getSrc(defaultIframe);
    if (iSrc && iSrc.startsWith('http')) {
      servers.push({ name: 'Default', url: iSrc, quality: 'HD', serverName: 'Default' });
    }
  }

  // FIX #4 — Parse kualitas resolusi dengan benar (720p, 480p, dll)
  doc.querySelectorAll('.mirrorstream > ul').forEach(ul => {
    const prevEl = ul.previousElementSibling;
    const qualityRaw = txt(prevEl) || '';
    // Ekstrak pola resolusi: 1080p, 720p, 480p, 360p
    const qualityMatch = qualityRaw.match(/(\d{3,4}p)/i);
    const quality = qualityMatch ? qualityMatch[1] : (qualityRaw || 'HD');

    ul.querySelectorAll('li a[data-content]').forEach(link => {
      const serverId = attr(link, 'data-content');
      const serverName = txt(link); // GDrive, Zippyshare, dll
      if (!serverId) return;
      try {
        const raw = JSON.parse(Buffer.from(serverId, 'base64').toString('utf-8'));
        const enriched = { ...raw, nonce, referer: url };
        if (mainAction && !enriched.action) enriched.action = mainAction;
        const encodedId = Buffer.from(JSON.stringify(enriched)).toString('base64');
        servers.push({
          name: `${quality} - ${serverName}`,
          quality,       // "720p"
          serverName,    // "GDrive"
          serverId: encodedId,
          needsPost: true,
        });
      } catch(e) {
        servers.push({
          name: `${quality} - ${serverName}`,
          quality, serverName, serverId, needsPost: true
        });
      }
    });
  });

  let prevEp = null, nextEp = null;
  doc.querySelectorAll('.flir a').forEach(link => {
    const t = txt(link).toLowerCase();
    if (t.includes('prev') || t.includes('sebelum')) {
      prevEp = { slug: toSlug(getHref(link)), url: getHref(link) };
    } else if (t.includes('next') || t.includes('selanjut')) {
      nextEp = { slug: toSlug(getHref(link)), url: getHref(link) };
    }
  });

  console.log(`Episode ${epSlug}: ${servers.length} servers found`);
  return { servers, prevEp, nextEp };
}

async function fetchServerUrl(encodedId) {
  try {
    const jsonStr = Buffer.from(encodedId, 'base64').toString('utf-8');
    const params = JSON.parse(jsonStr);
    const referer = params.referer || BASE;
    const { referer: _, ...postParams } = params;
    const body = new URLSearchParams(postParams).toString();

    console.log('Fetching server, action:', postParams.action);

    const res = await fetchPost(`${BASE}/wp-admin/admin-ajax.php`, body, referer);
    console.log('Server response:', res.slice(0, 100));

    const data = JSON.parse(res);
    if (!data.data) return null;

    const iframeHtml = Buffer.from(data.data, 'base64').toString('utf-8');
    const srcMatch = iframeHtml.match(/src=["']([^"']+)["']/);
    return srcMatch ? srcMatch[1] : null;
  } catch(e) {
    console.error('Server fetch error:', e.message);
    return null;
  }
}

// ── ROUTES ───────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    name: 'KitsuneID API',
    version: '2.0.0',
    status: 'running',
    endpoints: ['/ongoing', '/complete', '/schedule', '/search', '/anime', '/episode', '/server']
  });
});

app.get('/ongoing', async (req, res) => {
  try {
    const animes = await scrapeOngoing(parseInt(req.query.page) || 1);
    res.json({ animes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/complete', async (req, res) => {
  try {
    const animes = await scrapeComplete(parseInt(req.query.page) || 1);
    res.json({ animes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/schedule', async (req, res) => {
  try {
    const schedules = await scrapeSchedule();
    res.json({ schedules });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'query diperlukan' });
    const results = await scrapeSearch(q);
    res.json({ results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/anime', async (req, res) => {
  try {
    const slug = req.query.slug;
    if (!slug) return res.status(400).json({ error: 'slug diperlukan' });
    const data = await scrapeAnimeDetail(slug);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/episode', async (req, res) => {
  try {
    const slug = req.query.slug;
    if (!slug) return res.status(400).json({ error: 'slug diperlukan' });
    const data = await scrapeEpisode(slug);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/server', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id diperlukan' });
    const url = await fetchServerUrl(id);
    res.json({ url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🦊 KitsuneID API running on port ${PORT}`);
});
