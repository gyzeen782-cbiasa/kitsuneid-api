// ===== server.js — KitsuneID API (Railway) v3 =====
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

// ── CACHE (in-memory) ────────────────────────
// Menyimpan hasil scrape agar request berikutnya langsung balik tanpa tunggu
const cache = new Map();
const CACHE_TTL = {
  ongoing:  5 * 60 * 1000,  // 5 menit
  complete: 10 * 60 * 1000, // 10 menit
  schedule: 30 * 60 * 1000, // 30 menit
  search:   5 * 60 * 1000,  // 5 menit
  anime:    15 * 60 * 1000, // 15 menit
  episode:  10 * 60 * 1000, // 10 menit
};

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) { cache.delete(key); return null; }
  return item.data;
}

function setCache(key, data, ttl) {
  cache.set(key, { data, expires: Date.now() + ttl });
}

// Bersihkan cache yang expired setiap 5 menit
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of cache.entries()) {
    if (now > item.expires) cache.delete(key);
  }
}, 5 * 60 * 1000);

// ── HTTP helpers ─────────────────────────────
function fetchHTML(url, render = false) {
  return new Promise((resolve, reject) => {
    const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render=${render}`;
    http.get(proxyUrl, { timeout: 45000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTML(res.headers.location, render).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject).setTimeout(45000, function() {
      this.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

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

function parseEpNum(title, fallback) {
  if (!title) return fallback;
  const epMatch = title.match(/episode\s+(\d+)/i) || title.match(/\bep\.?\s*(\d+)/i);
  if (epMatch) return epMatch[1];
  const nums = title.match(/\d+/g);
  return nums ? nums[nums.length - 1] : fallback;
}

// ── SCRAPERS ─────────────────────────────────

async function scrapeOngoing(page = 1) {
  const cacheKey = `ongoing_${page}`;
  const cached = getCache(cacheKey);
  if (cached) { console.log('Cache hit:', cacheKey); return cached; }

  const url = page > 1 ? `${BASE}/ongoing-anime/page/${page}/` : `${BASE}/ongoing-anime/`;
  const doc = parse(await fetchHTML(url, true));
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

  setCache(cacheKey, animes, CACHE_TTL.ongoing);
  return animes;
}

async function scrapeComplete(page = 1) {
  const cacheKey = `complete_${page}`;
  const cached = getCache(cacheKey);
  if (cached) { console.log('Cache hit:', cacheKey); return cached; }

  const url = page > 1 ? `${BASE}/complete-anime/page/${page}/` : `${BASE}/complete-anime/`;
  const doc = parse(await fetchHTML(url, true));
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

  setCache(cacheKey, animes, CACHE_TTL.complete);
  return animes;
}

async function scrapeSchedule() {
  const cached = getCache('schedule');
  if (cached) { console.log('Cache hit: schedule'); return cached; }

  const html = await fetchHTML(`${BASE}/jadwal-rilis/`);
  const doc = parse(html);
  const schedules = [];

  // .kglist321 terbukti ada dari debug — pakai ini
  const blocks = doc.querySelectorAll('.kglist321');
  console.log(`Schedule: found ${blocks.length} .kglist321 blocks`);

  blocks.forEach(block => {
    const day = txt(block.querySelector('h2') || block.querySelector('h3'));
    if (!day) return;

    const animeList = [];
    // Ambil semua link di dalam block — tidak filter /anime/ karena jadwal pakai link /anime/
    block.querySelectorAll('ul li a').forEach(a2 => {
      const href = getHref(a2);
      const title = txt(a2);
      if (href && title) {
        animeList.push({ title, slug: toSlug(href), url: href });
      }
    });

    // Fallback: kalau ul li a kosong, coba semua a
    if (!animeList.length) {
      block.querySelectorAll('a').forEach(a2 => {
        const href = getHref(a2);
        const title = txt(a2);
        if (href && title) {
          animeList.push({ title, slug: toSlug(href), url: href });
        }
      });
    }

    console.log(`  Day: "${day}" → ${animeList.length} anime`);
    schedules.push({ day, animeList });
  });

  if (!schedules.length) {
    // Fallback: scan semua a[href*="/anime/"] di halaman
    console.log('Schedule: .kglist321 empty, scanning all anime links...');
    const allLinks = doc.querySelectorAll('a');
    const dayMap = {};
    let curDay = null;

    // Cari h2 yang berisi nama hari
    const dayNames = ['senin','selasa','rabu','kamis','jumat','sabtu','minggu'];
    doc.querySelectorAll('h2').forEach(h => {
      const t = txt(h).toLowerCase().trim();
      if (dayNames.some(d => t.includes(d))) {
        curDay = txt(h);
        dayMap[curDay] = [];
        // Ambil semua link di parent/sibling
        const parent = h.parentNode;
        if (parent) {
          parent.querySelectorAll('a').forEach(a2 => {
            const href = getHref(a2);
            const title = txt(a2);
            if (href && title && href !== '#') {
              dayMap[curDay].push({ title, slug: toSlug(href), url: href });
            }
          });
        }
      }
    });

    Object.entries(dayMap).forEach(([day, list]) => {
      if (list.length) schedules.push({ day, animeList: list });
    });
    console.log('Schedule fallback result:', schedules.length, 'days');
  }

  setCache('schedule', schedules, CACHE_TTL.schedule);
  return schedules;
}

async function scrapeSearch(query) {
  const cacheKey = `search_${query.toLowerCase().trim()}`;
  const cached = getCache(cacheKey);
  if (cached) { console.log('Cache hit:', cacheKey); return cached; }

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

  setCache(cacheKey, results, CACHE_TTL.search);
  return results;
}

async function scrapeAnimeDetail(slug) {
  const cacheKey = `anime_${slug}`;
  const cached = getCache(cacheKey);
  if (cached) { console.log('Cache hit:', cacheKey); return cached; }

  const html = await fetchHTML(`${BASE}/anime/${slug}/`, true);
  const doc = parse(html);

  // Title - multi-selector fallback
  const title = txt(doc.querySelector('h1.entry-title'))
    || txt(doc.querySelector('h1.title'))
    || txt(doc.querySelector('.animposx h1'))
    || txt(doc.querySelector('.entry-title'))
    || txt(doc.querySelector('h1'))
    || attr(doc.querySelector('meta[property="og:title"]'), 'content')
    || 'Tidak diketahui';

  // Thumb - multi-selector fallback
  const thumb = getSrc(doc.querySelector('.fotoanime img'))
    || getSrc(doc.querySelector('.imgdesc img'))
    || getSrc(doc.querySelector('.animeinfo img'))
    || getSrc(doc.querySelector('.thumb img'))
    || getSrc(doc.querySelector('img.attachment-post-thumbnail'))
    || attr(doc.querySelector('meta[property="og:image"]'), 'content')
    || '';

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

  const episodes = [];

  // Approach 1: selector lama .smokelister
  for (const block of doc.querySelectorAll('.smokelister')) {
    const bt = block.text.toLowerCase();
    if (bt.includes('episode') && !bt.includes('batch')) {
      const epLinks = block.nextElementSibling?.querySelectorAll('li a') || [];
      epLinks.forEach((link, i) => {
        const epUrl = getHref(link);
        const epTitle = txt(link);
        const epSlug = toSlug(epUrl);
        if (epSlug) {
          episodes.push({ title: epTitle, slug: epSlug, url: epUrl,
            episode: parseEpNum(epTitle, String(i + 1)) });
        }
      });
      if (episodes.length) break;
    }
  }

  // Approach 2: cari semua link /episode/ dari halaman
  if (!episodes.length) {
    const epSelectors = [
      '.episodelist li a', '.episode-list li a', '.eps li a',
      '[class*="episode"] li a', '[class*="eps"] li a',
      '.eplister li a', '.eplist li a'
    ];
    for (const sel of epSelectors) {
      const links = doc.querySelectorAll(sel);
      if (!links.length) continue;
      links.forEach((link, i) => {
        const epUrl = getHref(link);
        const epTitle = txt(link);
        const epSlug = toSlug(epUrl);
        if (epSlug && epUrl.includes('/episode/')) {
          episodes.push({ title: epTitle, slug: epSlug, url: epUrl,
            episode: parseEpNum(epTitle, String(i + 1)) });
        }
      });
      if (episodes.length) { console.log(`Episodes: found via "${sel}"`); break; }
    }
  }

  // Approach 3: scan SEMUA link /episode/ di halaman
  if (!episodes.length) {
    const allLinks = doc.querySelectorAll('a[href*="/episode/"]');
    allLinks.forEach((link, i) => {
      const epUrl = getHref(link);
      const epTitle = txt(link);
      const epSlug = toSlug(epUrl);
      if (epSlug && !episodes.find(e => e.slug === epSlug)) {
        episodes.push({ title: epTitle || `Episode ${i+1}`, slug: epSlug, url: epUrl,
          episode: parseEpNum(epTitle, String(i + 1)) });
      }
    });
    if (episodes.length) console.log(`Episodes: found ${episodes.length} via all-links scan`);
  }

  episodes.reverse();

  const result = {
    title, thumb, synopsis,
    rating: getInfo(2), status: getInfo(5), type: getInfo(4),
    episode: getInfo(6) || String(episodes.length) || '?',
    duration: getInfo(7), aired: getInfo(8), studio: getInfo(9),
    genres, episodes, slug,
  };

  setCache(cacheKey, result, CACHE_TTL.anime);
  return result;
}

async function scrapeEpisode(epSlug) {
  const cacheKey = `episode_${epSlug}`;
  const cached = getCache(cacheKey);
  if (cached) { console.log('Cache hit:', cacheKey); return cached; }

  const url = `${BASE}/episode/${epSlug}/`;
  console.log('Fetching episode:', epSlug);

  // Pakai render=true agar JavaScript player ter-render (penting untuk video)
  const html = await fetchHTML(url, true);
  const doc = parse(html);
  const innerText = doc.innerText || doc.text || '';

  // Ambil action credentials dari inline JS
  const credentials = [...new Set(
    [...innerText.matchAll(/action:"([^"]+)"/g)].map(m => m[1])
  )];
  // credentials[0] = main action, credentials[1] = nonce action

  // Ambil nonce
  let nonce = '';
  if (credentials[1]) {
    try {
      const nonceBody = new URLSearchParams({ action: credentials[1] }).toString();
      const nonceRes = await fetchPost(`${BASE}/wp-admin/admin-ajax.php`, nonceBody, url);
      const nonceJson = JSON.parse(nonceRes);
      nonce = nonceJson.data || '';
      console.log('Nonce:', nonce ? '✓' : '✗');
    } catch(e) { console.error('Nonce error:', e.message); }
  }

  const servers = [];

  // Default player iframe — ini yang paling sering langsung bisa diputar
  const defaultIframe = doc.querySelector('.player-embed iframe')
    || doc.querySelector('#pembed iframe')
    || doc.querySelector('iframe[src]');
  if (defaultIframe) {
    const iSrc = getSrc(defaultIframe);
    if (iSrc && iSrc.startsWith('http')) {
      servers.push({ name: 'Default', url: iSrc });
      console.log('Default iframe found:', iSrc.slice(0, 60));
    }
  }

  // Mirror servers — sebagai opsi tambahan
  doc.querySelectorAll('.mirrorstream > ul').forEach(ul => {
    const quality = txt(ul.previousElementSibling) || 'HD';
    ul.querySelectorAll('li a[data-content]').forEach(link => {
      const serverId = attr(link, 'data-content');
      const serverName = txt(link);
      if (!serverId) return;
      try {
        const decoded = JSON.parse(Buffer.from(serverId, 'base64').toString('utf-8'));
        const enriched = {
          ...decoded,
          nonce,
          action: credentials[0] || decoded.action || '',
          referer: url,
        };
        const encodedId = Buffer.from(JSON.stringify(enriched)).toString('base64');
        servers.push({ name: `${quality} - ${serverName}`, serverId: encodedId, needsPost: true });
      } catch(e) {
        servers.push({ name: `${quality} - ${serverName}`, serverId, needsPost: true });
      }
    });
  });

  // Navigasi prev/next episode
  let prevEp = null, nextEp = null;
  doc.querySelectorAll('.flir a').forEach(link => {
    const t = txt(link).toLowerCase();
    if (t.includes('prev') || t.includes('sebelum')) prevEp = { slug: toSlug(getHref(link)), url: getHref(link) };
    else if (t.includes('next') || t.includes('selanjut')) nextEp = { slug: toSlug(getHref(link)), url: getHref(link) };
  });

  const result = { servers, prevEp, nextEp };
  setCache(cacheKey, result, CACHE_TTL.episode);
  console.log(`Episode ${epSlug}: ${servers.length} server(s) found`);
  return result;
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
  const stats = { total: cache.size, keys: [...cache.keys()] };
  res.json({ name: 'KitsuneID API', version: '3.0.0', status: 'running', cache: stats,
    endpoints: ['/ongoing', '/complete', '/schedule', '/search', '/anime', '/episode', '/server', '/cache/clear'] });
});

// Clear cache endpoint (untuk admin)
// Ping endpoint untuk keep-alive
app.get('/ping', (req, res) => {
  res.json({ pong: true, time: new Date().toISOString(), cache: cache.size });
});

// Debug endpoint - lihat HTML mentah dari halaman otakudesu
app.get('/debug', async (req, res) => {
  const page = req.query.page || 'schedule'; // ?page=schedule atau ?page=anime&slug=xxx
  try {
    let url;
    if (page === 'anime' && req.query.slug) {
      url = `${BASE}/anime/${req.query.slug}/`;
    } else if (page === 'episode' && req.query.slug) {
      url = `${BASE}/episode/${req.query.slug}/`;
    } else {
      url = `${BASE}/jadwal-rilis/`;
    }
    const html = await fetchHTML(url);
    // Kirim hanya 3000 karakter awal untuk preview
    res.json({
      url,
      length: html.length,
      preview: html.slice(0, 3000),
      // Cari semua class unik dari halaman
      classes: [...new Set(html.match(/class="([^"]+)"/g) || [])].slice(0, 50)
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/cache/clear', (req, res) => {
  const count = cache.size;
  cache.clear();
  res.json({ message: `Cache cleared: ${count} items removed` });
});

app.get('/ongoing', async (req, res) => {
  try { res.json({ animes: await scrapeOngoing(parseInt(req.query.page) || 1) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/complete', async (req, res) => {
  try { res.json({ animes: await scrapeComplete(parseInt(req.query.page) || 1) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/schedule', async (req, res) => {
  try { res.json({ schedules: await scrapeSchedule() }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'query diperlukan' });
    res.json({ results: await scrapeSearch(q) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/anime', async (req, res) => {
  try {
    const slug = req.query.slug;
    if (!slug) return res.status(400).json({ error: 'slug diperlukan' });
    res.json(await scrapeAnimeDetail(slug));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/episode', async (req, res) => {
  try {
    const slug = req.query.slug;
    if (!slug) return res.status(400).json({ error: 'slug diperlukan' });
    res.json(await scrapeEpisode(slug));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/server', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id diperlukan' });
    res.json({ url: await fetchServerUrl(id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`🦊 KitsuneID API v3 running on port ${PORT}`);

  // ── KEEP-ALIVE: ping diri sendiri setiap 4 menit ──
  // Railway tidur setelah ~5 menit idle — ping ini mencegahnya
  const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/ping`
    : `http://localhost:${PORT}/ping`;

  setInterval(() => {
    const mod = SELF_URL.startsWith('https') ? https : http;
    mod.get(SELF_URL, res => {
      console.log(`[keep-alive] ping → ${res.statusCode}`);
    }).on('error', e => {
      console.log('[keep-alive] ping error:', e.message);
    });
  }, 4 * 60 * 1000); // setiap 4 menit

  // ── WARM-UP: pre-load cache ongoing & schedule saat startup ──
  setTimeout(async () => {
    try {
      console.log('[warm-up] Pre-loading ongoing cache...');
      await scrapeOngoing(1);
      console.log('[warm-up] Pre-loading schedule cache...');
      await scrapeSchedule();
      console.log('[warm-up] Done!');
    } catch(e) {
      console.log('[warm-up] Error:', e.message);
    }
  }, 3000); // tunggu 3 detik setelah server ready
});
