// ===== server.js — KitsuneID API v4 =====
// Arsitektur: Jikan API (info) + Samehadaku (episode/video)
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Sumber data ───────────────────────────────
const JIKAN       = 'https://api.jikan.moe/v4';
const SAMEHADAKU  = 'https://v1.samehadaku.how';
const SCRAPER_KEY = '2ae12f2df6c0a613015482e8131a38ab';

app.use(cors());
app.use(express.json());

// ── CACHE in-memory ───────────────────────────
const cache = new Map();
const TTL = {
  ongoing:  15 * 60 * 1000,  // 15 menit
  complete: 15 * 60 * 1000,
  schedule: 60 * 60 * 1000,  // 1 jam — jadwal jarang berubah
  search:   10 * 60 * 1000,
  anime:   120 * 60 * 1000,  // 2 jam — info anime stabil
  episode:  30 * 60 * 1000,  // 30 menit
};

function getCache(k) {
  const it = cache.get(k);
  if (!it) return null;
  if (Date.now() > it.exp) { cache.delete(k); return null; }
  return it.data;
}
function setCache(k, data, ttl) { cache.set(k, { data, exp: Date.now() + ttl }); }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (now > v.exp) cache.delete(k);
}, 5 * 60 * 1000);

// ── HTTP helpers ──────────────────────────────

// Jikan: fetch biasa (tidak perlu ScraperAPI)
function fetchJikan(path) {
  return new Promise((resolve, reject) => {
    const url = `${JIKAN}${path}`;
    https.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'KitsuneID/4.0' },
      timeout: 15000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
      res.on('error', reject);
    }).on('error', reject)
      .on('timeout', function() { this.destroy(); reject(new Error('Jikan timeout')); });
  });
}

// Samehadaku: fetch via ScraperAPI (untuk episode/video saja)
function fetchSamehadaku(path) {
  return new Promise((resolve, reject) => {
    const target = `${SAMEHADAKU}${path}`;
    const proxy  = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(target)}&render=false`;
    http.get(proxy, { timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchSamehadaku(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject)
      .setTimeout(30000, function() { this.destroy(); reject(new Error('Scraper timeout')); });
  });
}

// Jikan rate limiter — max 3 request/detik
let jikanQueue = [], jikanBusy = false;
function jikanRateLimit(fn) {
  return new Promise((res, rej) => {
    jikanQueue.push({ fn, res, rej });
    if (!jikanBusy) processJikanQueue();
  });
}
async function processJikanQueue() {
  if (!jikanQueue.length) { jikanBusy = false; return; }
  jikanBusy = true;
  const { fn, res, rej } = jikanQueue.shift();
  try { res(await fn()); } catch(e) { rej(e); }
  setTimeout(processJikanQueue, 340); // ~3 req/detik
}

// Jikan fetch dengan rate limiter
function jikan(path) {
  return jikanRateLimit(() => fetchJikan(path));
}

// ── HTML parser sederhana (untuk Samehadaku) ──
const { parse } = require('node-html-parser');
function txt(el) { return el?.text?.trim().replace(/\s+/g, ' ') || ''; }
function attr(el, a) { return el?.getAttribute(a)?.trim() || ''; }
function getHref(el) { return attr(el, 'href'); }
function getSrc(el)  { return attr(el, 'src') || attr(el, 'data-src'); }

// ── Slug helpers ──────────────────────────────
// Konversi judul MAL ke slug Samehadaku
function titleToSlug(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// Format data anime dari Jikan response ke format KitsuneID
function formatAnime(a) {
  if (!a) return null;
  const slug = titleToSlug(a.title || a.title_english || '');
  return {
    mal_id:   a.mal_id,
    title:    a.title || a.title_english || 'Unknown',
    titleEn:  a.title_english || '',
    slug:     slug,
    thumb:    a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '',
    synopsis: a.synopsis || 'Tidak ada sinopsis.',
    rating:   a.score ? String(a.score) : null,
    status:   a.status === 'Currently Airing' ? 'Ongoing' :
              a.status === 'Finished Airing'   ? 'Complete' : (a.status || 'Unknown'),
    type:     a.type || 'TV',
    episode:  a.episodes ? String(a.episodes) : (a.aired_on ? '?' : null),
    duration: a.duration || null,
    aired:    a.aired?.string || null,
    studio:   a.studios?.[0]?.name || null,
    genres:   a.genres?.map(g => g.name) || [],
    day:      a.broadcast?.day?.replace(' JST','') || null,
    episodes: [], // diisi saat scrape Samehadaku
  };
}

// ═══════════════════════════════════════════
//   JIKAN SCRAPERS
// ═══════════════════════════════════════════

async function getOngoing(page = 1) {
  const k = `ongoing_${page}`;
  const cached = getCache(k);
  if (cached) { console.log('Cache hit:', k); return cached; }

  const d = await jikan(`/seasons/now?filter=tv&limit=24&page=${page}`);
  const animes = (d.data || []).map(formatAnime).filter(Boolean);
  setCache(k, animes, TTL.ongoing);
  return animes;
}

async function getComplete(page = 1) {
  const k = `complete_${page}`;
  const cached = getCache(k);
  if (cached) { console.log('Cache hit:', k); return cached; }

  // Ambil dari season sebelumnya
  const now  = new Date();
  const yr   = now.getFullYear();
  const mo   = now.getMonth(); // 0-11
  const seasons = ['winter','spring','summer','fall'];
  const curSeason = Math.floor(mo / 3);
  const prevSeason = curSeason === 0
    ? { year: yr - 1, season: 'fall' }
    : { year: yr, season: seasons[curSeason - 1] };

  const d = await jikan(`/seasons/${prevSeason.year}/${prevSeason.season}?filter=tv&limit=24&page=${page}`);
  const animes = (d.data || [])
    .map(formatAnime)
    .filter(Boolean)
    .map(a => ({ ...a, status: 'Complete' }));
  setCache(k, animes, TTL.complete);
  return animes;
}

async function getSchedule() {
  const k = 'schedule';
  const cached = getCache(k);
  if (cached) { console.log('Cache hit: schedule'); return cached; }

  const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const dayId = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];
  const schedules = [];

  // Fetch semua hari secara paralel (hemat waktu)
  const results = await Promise.allSettled(
    days.map(d => jikan(`/schedules?filter=${d}&limit=25`))
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') return;
    const animeList = (r.value.data || []).map(a => ({
      title: a.title || a.title_english || '',
      slug:  titleToSlug(a.title || ''),
      mal_id: a.mal_id,
      thumb: a.images?.jpg?.image_url || '',
      episode: a.episodes ? String(a.episodes) : '?',
    })).filter(a => a.title);
    if (animeList.length) schedules.push({ day: dayId[i], animeList });
  });

  setCache(k, schedules, TTL.schedule);
  return schedules;
}

async function searchAnime(query) {
  const k = `search_${query.toLowerCase().trim()}`;
  const cached = getCache(k);
  if (cached) { console.log('Cache hit:', k); return cached; }

  const d = await jikan(`/anime?q=${encodeURIComponent(query)}&limit=10&type=tv`);
  const results = (d.data || []).map(a => ({
    mal_id: a.mal_id,
    title:  a.title || a.title_english || '',
    slug:   titleToSlug(a.title || ''),
    thumb:  a.images?.jpg?.image_url || '',
    status: a.status === 'Currently Airing' ? 'Ongoing' : 'Complete',
    type:   a.type || 'TV',
    rating: a.score ? String(a.score) : null,
  }));
  setCache(k, results, TTL.search);
  return results;
}

async function getAnimeDetail(slugOrId) {
  const k = `anime_${slugOrId}`;
  const cached = getCache(k);
  if (cached) { console.log('Cache hit:', k); return cached; }

  let data;
  // Kalau berupa angka/MAL ID langsung
  if (/^\d+$/.test(slugOrId)) {
    const d = await jikan(`/anime/${slugOrId}/full`);
    data = d.data;
  } else {
    // Search berdasarkan slug → ambil hasil pertama
    const query = slugOrId.replace(/-sub-indo/gi, '').replace(/-/g, ' ');
    const d = await jikan(`/anime?q=${encodeURIComponent(query)}&limit=5`);
    data = d.data?.[0];
  }

  if (!data) return null;
  const anime = formatAnime(data);

  // Ambil episode list dari Samehadaku (scrape ringan)
  try {
    anime.episodes = await getSamehadakuEpisodes(anime.slug);
  } catch(e) {
    console.log('Episode scrape skip:', e.message);
    anime.episodes = [];
  }

  setCache(k, anime, TTL.anime);
  return anime;
}

// ═══════════════════════════════════════════
//   SAMEHADAKU SCRAPERS (hanya untuk episode/video)
// ═══════════════════════════════════════════

// Ambil daftar episode dari Samehadaku
async function getSamehadakuEpisodes(slug) {
  const k = `eplist_${slug}`;
  const cached = getCache(k);
  if (cached) return cached;

  // Samehadaku URL format: /anime/slug-sub-indo/
  const slugFull = slug.endsWith('-sub-indo') ? slug : `${slug}-sub-indo`;
  const html = await fetchSamehadaku(`/anime/${slugFull}/`);
  const doc  = parse(html);

  const episodes = [];

  // Selector Samehadaku — daftar episode biasanya di .episodelist atau .eps-list
  const epSelectors = [
    '.episodelist li a',
    '.episode-list li a',
    '#episodelist li a',
    '.eps li a',
    '[class*="episode"] li a',
    'ul.eps a',
    '.episodes-list a',
  ];

  for (const sel of epSelectors) {
    const links = doc.querySelectorAll(sel);
    if (!links.length) continue;
    links.forEach((a, i) => {
      const href  = getHref(a);
      const title = txt(a);
      if (!href || !title) return;
      const epSlug = href.replace(/.*\/episode\//, '').replace(/\/$/, '').trim();
      if (!epSlug) return;
      const num = title.match(/\d+(\.\d+)?/)?.[0] || String(i + 1);
      episodes.push({ title, slug: epSlug, url: href, episode: num });
    });
    if (episodes.length) { console.log(`Episodes: ${episodes.length} via "${sel}"`); break; }
  }

  // Fallback: scan semua link /episode/
  if (!episodes.length) {
    doc.querySelectorAll('a[href*="/episode/"]').forEach((a, i) => {
      const href  = getHref(a);
      const title = txt(a);
      if (!href || !title) return;
      const epSlug = href.split('/episode/')[1]?.replace(/\/$/, '') || '';
      if (!epSlug) return;
      const num = title.match(/\d+/)?.[0] || String(i + 1);
      episodes.push({ title, slug: epSlug, url: href, episode: num });
    });
  }

  // Urutkan dari episode 1
  episodes.reverse();
  setCache(k, episodes, TTL.episode);
  return episodes;
}

// Ambil server video dari episode Samehadaku
async function getSamehadakuEpisodeVideo(epSlug) {
  const k = `ep_${epSlug}`;
  const cached = getCache(k);
  if (cached) { console.log('Cache hit:', k); return cached; }

  const html = await fetchSamehadaku(`/episode/${epSlug}/`);
  const doc  = parse(html);

  const servers = [];

  // Cari semua iframe embed
  const iframes = doc.querySelectorAll('iframe');
  iframes.forEach((iframe, i) => {
    const src = getSrc(iframe) || attr(iframe, 'data-src');
    if (src && src.startsWith('http')) {
      servers.push({
        name: `Server ${i + 1}`,
        url:  src,
        type: 'iframe',
      });
    }
  });

  // Cari server links (mirror)
  const mirrorSels = [
    '.mirror-list a', '[class*="mirror"] a',
    '.server-list a', '.streaming a',
    '[class*="server"] a', '[class*="stream"] a',
  ];
  for (const sel of mirrorSels) {
    const links = doc.querySelectorAll(sel);
    if (!links.length) continue;
    links.forEach(a => {
      const url  = getHref(a);
      const name = txt(a) || 'Mirror';
      if (url && url.startsWith('http') && !servers.find(s => s.url === url)) {
        servers.push({ name, url, type: 'iframe' });
      }
    });
    if (servers.length) break;
  }

  // Cari embed dari JS inline (desu, nanistream, dll)
  const scripts = doc.querySelectorAll('script');
  scripts.forEach(s => {
    const code = txt(s);
    const matches = code.match(/(?:src|url|file)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/g);
    if (matches) {
      matches.forEach(m => {
        const url = m.match(/["'](https?:\/\/[^"']+)["']/)?.[1];
        if (url && !url.includes('.js') && !servers.find(x => x.url === url)) {
          servers.push({ name: 'Stream', url, type: 'iframe' });
        }
      });
    }
  });

  const result = { servers, slug: epSlug };
  setCache(k, result, TTL.episode);
  return result;
}

// ═══════════════════════════════════════════
//   ROUTES
// ═══════════════════════════════════════════

// Health + info
app.get('/', (req, res) => {
  res.json({
    name: 'KitsuneID API',
    version: '4.0.0',
    status: 'running',
    sources: { info: 'Jikan (MyAnimeList)', video: 'Samehadaku' },
    cache: { size: cache.size, keys: [...cache.keys()].slice(0, 20) },
    endpoints: ['/ongoing','/complete','/schedule','/search','/anime','/episode','/ping','/cache/clear']
  });
});

// Keep-alive ping
app.get('/ping', (req, res) => {
  res.json({ pong: true, time: new Date().toISOString(), cache: cache.size });
});

// Clear cache
app.get('/cache/clear', (req, res) => {
  const n = cache.size;
  cache.clear();
  res.json({ cleared: n });
});

// Debug — lihat HTML samehadaku (untuk troubleshoot)
app.get('/debug', async (req, res) => {
  const slug = req.query.slug || 'jujutsu-kaisen-season-3-sub-indo';
  const type = req.query.type || 'anime'; // anime | episode
  try {
    const html = type === 'episode'
      ? await fetchSamehadaku(`/episode/${slug}/`)
      : await fetchSamehadaku(`/anime/${slug}/`);
    const classes = [...new Set(html.match(/class="([^"]+)"/g) || [])].slice(0, 50);
    res.json({ slug, type, length: html.length, preview: html.slice(0, 2000), classes });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Ongoing
app.get('/ongoing', async (req, res) => {
  try {
    const animes = await getOngoing(parseInt(req.query.page) || 1);
    res.json({ animes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Complete
app.get('/complete', async (req, res) => {
  try {
    const animes = await getComplete(parseInt(req.query.page) || 1);
    res.json({ animes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Schedule
app.get('/schedule', async (req, res) => {
  try {
    const schedules = await getSchedule();
    res.json({ schedules });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Search
app.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Parameter q diperlukan' });
    res.json({ results: await searchAnime(q) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Anime detail (by slug atau MAL ID)
app.get('/anime', async (req, res) => {
  try {
    const slug = req.query.slug;
    const id   = req.query.id;
    if (!slug && !id) return res.status(400).json({ error: 'Parameter slug atau id diperlukan' });
    const data = await getAnimeDetail(id || slug);
    if (!data) return res.status(404).json({ error: 'Anime tidak ditemukan' });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Episode video (Samehadaku)
app.get('/episode', async (req, res) => {
  try {
    const slug = req.query.slug;
    if (!slug) return res.status(400).json({ error: 'Parameter slug diperlukan' });
    res.json(await getSamehadakuEpisodeVideo(slug));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🦊 KitsuneID API v4.0 running on port ${PORT}`);
  console.log('   Sources: Jikan (info) + Samehadaku (video)');

  // Keep-alive: ping diri sendiri setiap 4 menit
  const SELF = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/ping`
    : `http://localhost:${PORT}/ping`;

  setInterval(() => {
    const mod = SELF.startsWith('https') ? https : http;
    mod.get(SELF, r => console.log(`[keep-alive] ${r.statusCode}`))
       .on('error', e => console.log('[keep-alive] error:', e.message));
  }, 4 * 60 * 1000);

  // Warm-up: pre-load cache penting saat startup
  setTimeout(async () => {
    try {
      console.log('[warm-up] Loading ongoing...');
      await getOngoing(1);
      console.log('[warm-up] Loading schedule...');
      await getSchedule();
      console.log('[warm-up] ✅ Done!');
    } catch(e) {
      console.log('[warm-up] Error:', e.message);
    }
  }, 3000);
});
