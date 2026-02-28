// ===== server.js — KitsuneID API v6.1 =====
// Arsitektur: Jikan (ongoing/jadwal) + Sanka Vollerei Otakudesu (semua lainnya)
// Zero SIPUTZX, Zero ScraperAPI!
const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

const JIKAN = 'https://api.jikan.moe/v4';
const SANKA = 'https://www.sankavollerei.com/anime';

app.use(cors());
app.use(express.json());

// ── CACHE ─────────────────────────────────────
const cache = new Map();
const TTL = {
  ongoing:  15 * 60 * 1000,
  complete: 15 * 60 * 1000,
  schedule: 60 * 60 * 1000,
  search:    5 * 60 * 1000,
  anime:    60 * 60 * 1000,
  episode:  30 * 60 * 1000,
  server:   60 * 60 * 1000,
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

// ── HTTP ──────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    const req = mod.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'KitsuneID/6.1' },
      timeout: 15000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error('JSON parse: ' + e.message)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Jikan rate limiter (3 req/detik) ─────────
let jikanQueue = [], jikanBusy = false;
function jikan(path) {
  return new Promise((res, rej) => {
    jikanQueue.push({ fn: () => fetchJSON(`${JIKAN}${path}`), res, rej });
    if (!jikanBusy) processJikanQueue();
  });
}
async function processJikanQueue() {
  if (!jikanQueue.length) { jikanBusy = false; return; }
  jikanBusy = true;
  const { fn, res, rej } = jikanQueue.shift();
  try { res(await fn()); } catch(e) { rej(e); }
  setTimeout(processJikanQueue, 340);
}

// ── Title to Jikan slug ───────────────────────
function titleToSlug(title) {
  return (title || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-').replace(/-+/g, '-').trim();
}

// ══════════════════════════════════════════════
//   JIKAN — Ongoing & Schedule (data akurat MAL)
// ══════════════════════════════════════════════

function formatJikan(a) {
  if (!a) return null;
  return {
    mal_id:  a.mal_id,
    title:   a.title || '',
    slug:    titleToSlug(a.title || ''),
    thumb:   a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '',
    synopsis: a.synopsis || '',
    rating:  a.score ? String(a.score) : null,
    status:  a.status === 'Currently Airing' ? 'Ongoing' :
             a.status === 'Finished Airing'   ? 'Complete' : (a.status || ''),
    type:    a.type || 'TV',
    episode: a.episodes ? String(a.episodes) : '?',
    genres:  a.genres?.map(g => g.name) || [],
    // Flag: slug ini adalah MAL slug, bukan Otakudesu animeId
    _source: 'jikan',
  };
}

async function getOngoing(page = 1) {
  const k = `ongoing_${page}`;
  const cached = getCache(k);
  if (cached) return cached;
  const d = await jikan(`/seasons/now?filter=tv&limit=24&page=${page}`);
  const animes = (d.data || []).map(formatJikan).filter(Boolean);
  setCache(k, animes, TTL.ongoing);
  return animes;
}

async function getComplete(page = 1) {
  const k = `complete_${page}`;
  const cached = getCache(k);
  if (cached) return cached;
  const now = new Date();
  const yr  = now.getFullYear();
  const mo  = now.getMonth();
  const seasons = ['winter','spring','summer','fall'];
  const cur  = Math.floor(mo / 3);
  const prev = cur === 0
    ? { year: yr - 1, season: 'fall' }
    : { year: yr, season: seasons[cur - 1] };
  const d = await jikan(`/seasons/${prev.year}/${prev.season}?filter=tv&limit=24&page=${page}`);
  const animes = (d.data || []).map(formatJikan).filter(Boolean).map(a => ({ ...a, status: 'Complete' }));
  setCache(k, animes, TTL.complete);
  return animes;
}

async function getSchedule() {
  const k = 'schedule';
  const cached = getCache(k);
  if (cached) return cached;
  const days  = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const dayId = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];
  const results = await Promise.allSettled(
    days.map(d => jikan(`/schedules?filter=${d}&limit=25`))
  );
  const schedules = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') return;
    const seen = new Set();
    const list = (r.value.data || [])
      .filter(a => a.title && !seen.has(a.mal_id) && seen.add(a.mal_id))
      .map(a => ({
        mal_id:  a.mal_id,
        title:   a.title,
        slug:    titleToSlug(a.title),
        thumb:   a.images?.jpg?.image_url || '',
        episode: a.episodes ? String(a.episodes) : '?',
        _source: 'jikan',
      }));
    if (list.length) schedules.push({ day: dayId[i], animeList: list });
  });
  setCache(k, schedules, TTL.schedule);
  return schedules;
}

// ══════════════════════════════════════════════
//   SANKA — Search, Detail, Episode, Server
// ══════════════════════════════════════════════

// Format card dari Sanka search/ongoing
function formatSankaCard(a) {
  return {
    title:   a.title || '',
    slug:    a.animeId || '',       // Ini adalah Otakudesu animeId!
    thumb:   a.poster || a.cover || '',
    rating:  a.score  || null,
    status:  a.status || '',
    genres:  (a.genreList || []).map(g => g.title),
    _source: 'otakudesu',
  };
}

// Search anime via Sanka (Otakudesu)
async function searchAnime(query) {
  const k = `search_${query.toLowerCase().trim()}`;
  const cached = getCache(k);
  if (cached) return cached;

  const d = await fetchJSON(`${SANKA}/search/${encodeURIComponent(query)}`);
  if (d.status !== 'success') throw new Error('Search failed');

  const results = (d.data?.animeList || []).map(formatSankaCard).filter(a => a.title);
  setCache(k, results, TTL.search);
  return results;
}

// ── Cari animeId Otakudesu dari judul/slug Jikan ─
// Semua query dijalankan PARALLEL → ambil hasil terbaik tercepat
const resolveCache = new Map(); // cache slug hasil resolve

async function resolveOtakudesuId(jikanSlug) {
  // Cek cache dulu — kalau sudah pernah resolve, langsung return
  if (resolveCache.has(jikanSlug)) {
    console.log(`[resolve] Cache hit: ${jikanSlug} → ${resolveCache.get(jikanSlug)}`);
    return resolveCache.get(jikanSlug);
  }

  const baseTitle = jikanSlug.replace(/-/g, ' ');

  const shortTitle = baseTitle
    .replace(/\b(season|part|the|a|an|no|wa|ga|wo|ni|to)\b/gi, '')
    .replace(/\s+/g, ' ').trim();

  const mainTitle = baseTitle.split(/\s+(season|part|s\d|episode)\s*/i)[0].trim();

  const queries = [
    baseTitle,
    shortTitle,
    mainTitle,
    baseTitle.split(' ').slice(0, 3).join(' '),
  ].filter((q, i, arr) => q.length > 2 && arr.indexOf(q) === i);

  // Jalankan semua query secara PARALLEL
  const searchPromises = queries.map(async (query) => {
    try {
      const d = await fetchJSON(`${SANKA}/search/${encodeURIComponent(query)}`);
      if (d.status !== 'success' || !d.data?.animeList?.length) return null;
      const best = findBestMatch(baseTitle, d.data.animeList);
      return best ? { animeId: best.animeId, title: best.title, score: best._score } : null;
    } catch(e) {
      return null;
    }
  });

  // Tunggu semua selesai, ambil yang score tertinggi
  const results = await Promise.all(searchPromises);
  const best = results
    .filter(Boolean)
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0];

  if (best) {
    console.log(`[resolve] ${jikanSlug} → ${best.animeId} (score: ${best.score})`);
    resolveCache.set(jikanSlug, best.animeId); // simpan ke cache
    return best.animeId;
  }

  resolveCache.set(jikanSlug, null); // cache miss juga biar tidak retry terus
  return null;
}

// Fuzzy match: cari anime dengan judul paling mirip
function findBestMatch(targetTitle, animeList) {
  const target = targetTitle.toLowerCase();

  // Score tiap hasil
  const scored = animeList.map(a => {
    const t = (a.title || '').toLowerCase()
      .replace(/\s+subtitle\s+indonesia/i, '')
      .replace(/\(episode.*?\)/i, '')
      .trim();

    let score = 0;

    // Exact match setelah normalisasi
    if (t === target) score += 100;

    // Semua kata target ada di judul
    const targetWords = target.split(/\s+/).filter(w => w.length > 2);
    const matchedWords = targetWords.filter(w => t.includes(w));
    score += (matchedWords.length / targetWords.length) * 50;

    // Panjang judul mirip (tidak terlalu jauh)
    const lenDiff = Math.abs(t.length - target.length);
    score -= lenDiff * 0.5;

    // Bonus jika mengandung kata kunci season/part yang sama
    const seasonTarget = target.match(/season\s*(\d+)|part\s*(\d+)|s(\d+)/i)?.[0] || '';
    const seasonA      = t.match(/season\s*(\d+)|part\s*(\d+)|s(\d+)/i)?.[0] || '';
    if (seasonTarget && seasonA && seasonTarget === seasonA) score += 30;
    if (seasonTarget && !seasonA) score -= 20; // target punya season, hasil tidak

    return { ...a, _score: score };
  });

  // Ambil yang score tertinggi, minimal score 20
  scored.sort((a, b) => b._score - a._score);
  return scored[0]?._score >= 20 ? scored[0] : null;
}

// Anime detail via Sanka (Otakudesu)
async function getAnimeDetail(animeId) {
  const k = `anime_${animeId}`;
  const cached = getCache(k);
  if (cached) return cached;

  let resolvedId = animeId;

  // Kalau bukan Otakudesu ID (tidak ada -sub-indo) → resolve dulu
  if (!animeId.includes('-sub-indo') && !animeId.match(/^\d+$/)) {
    const found = await resolveOtakudesuId(animeId);
    if (found) {
      resolvedId = found;
    } else {
      console.log(`[anime] Could not resolve "${animeId}" to Otakudesu ID`);
      throw new Error('Anime tidak ditemukan di Otakudesu');
    }
  }

  // Ambil detail dari Sanka
  const d = await fetchJSON(`${SANKA}/anime/${resolvedId}`);
  if (d.status !== 'success' || !d.data) throw new Error('Anime tidak ditemukan');

  const raw = d.data;

  // Episode list dari Sanka detail
  const rawEps = raw.episodeList || raw.info?.episodeList || [];
  const episodes = rawEps.map(ep => ({
    title:   ep.title || `Episode ${ep.eps}`,
    episode: String(ep.eps || ep.episode || '?'),
    slug:    ep.episodeId || ep.slug || '',
  })).sort((a, b) => parseFloat(a.episode) - parseFloat(b.episode));

  // synopsis bisa berupa object {paragraphs:[]} atau string
  let synopsis = '';
  if (typeof raw.synopsis === 'string') {
    synopsis = raw.synopsis;
  } else if (Array.isArray(raw.synopsis?.paragraphs)) {
    synopsis = raw.synopsis.paragraphs.join(' ');
  } else if (raw.sinopsis) {
    synopsis = raw.sinopsis;
  }

  const anime = {
    title:    raw.title || animeId,
    slug:     resolvedId,
    thumb:    raw.poster || raw.cover || raw.thumb || '',
    synopsis: synopsis || 'Tidak ada sinopsis.',
    rating:   raw.score || null,
    status:   raw.status || '',
    type:     raw.type || 'TV',
    episode:  String(raw.episodes || episodes.length || '?'),
    duration: raw.duration || null,
    aired:    raw.aired || null,
    genres:   (raw.genreList || []).map(g => g.title || g),
    studio:   raw.studios || raw.studio || null,
    episodes,
    _source:  'otakudesu',
  };

  setCache(k, anime, TTL.anime);
  return anime;
}

// Episode video dari Sanka (Otakudesu)
async function getSankaEpisode(episodeId) {
  const k = `ep_${episodeId}`;
  const cached = getCache(k);
  if (cached) return cached;

  const d = await fetchJSON(`${SANKA}/episode/${episodeId}`);
  if (d.status !== 'success' || !d.data) throw new Error('Episode tidak ditemukan');

  const ep = d.data;

  // Kualitas video
  const qualities = [];
  (ep.server?.qualities || []).forEach(q => {
    (q.serverList || []).forEach(s => {
      if (s.serverId) qualities.push({
        quality:  q.title,
        name:     s.title,
        serverId: s.serverId,
      });
    });
  });

  // Episode list dari info (full list, akurat)
  const episodeList = (ep.info?.episodeList || [])
    .map(e => ({
      title:   e.title || `Episode ${e.eps}`,
      episode: String(e.eps),
      slug:    e.episodeId,
    }))
    .sort((a, b) => parseFloat(a.episode) - parseFloat(b.episode));

  // Download links
  const downloads = [];
  (ep.downloadUrl?.qualities || []).forEach(q => {
    (q.urls || []).slice(0, 3).forEach(u => {
      downloads.push({ quality: q.title.trim(), size: q.size || '', host: u.title, url: u.url });
    });
  });

  const result = {
    title:       ep.title,
    animeId:     ep.animeId,
    defaultUrl:  ep.defaultStreamingUrl || null,
    qualities,
    episodeList, // sync episode list dari sini jika perlu
    prevEp:      ep.prevEpisode?.episodeId || null,
    nextEp:      ep.nextEpisode?.episodeId || null,
    downloads,
  };

  setCache(k, result, TTL.episode);
  return result;
}

// MP4/embed URL dari serverId
async function getSankaServer(serverId) {
  const k = `server_${serverId}`;
  const cached = getCache(k);
  if (cached) return cached;

  const d = await fetchJSON(`${SANKA}/server/${serverId}`);
  if (d.status !== 'success') throw new Error('Server error');

  const url = d.data?.url || null;
  if (url) setCache(k, { url }, TTL.server);
  return { url };
}

// ══════════════════════════════════════════════
//   ROUTES
// ══════════════════════════════════════════════

app.get('/', (req, res) => res.json({
  name: 'KitsuneID API', version: '6.1.0', status: '🦊 running',
  sources: {
    ongoing: 'Jikan (MAL)',
    search:  'Sanka Vollerei (Otakudesu)',
    video:   'Sanka Vollerei (Otakudesu)',
  },
  cache: cache.size,
}));

app.get('/ping',        (req, res) => res.json({ pong: true, time: new Date().toISOString() }));
app.get('/cache/clear', (req, res) => { const n = cache.size; cache.clear(); res.json({ cleared: n }); });

app.get('/ongoing', async (req, res) => {
  try { res.json({ animes: await getOngoing(+req.query.page || 1) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/complete', async (req, res) => {
  try { res.json({ animes: await getComplete(+req.query.page || 1) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/schedule', async (req, res) => {
  try { res.json({ schedules: await getSchedule() }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Parameter q diperlukan' });
    res.json({ results: await searchAnime(q) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/anime', async (req, res) => {
  try {
    const id = req.query.slug || req.query.id;
    if (!id) return res.status(400).json({ error: 'Parameter slug diperlukan' });
    res.json(await getAnimeDetail(id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/episode', async (req, res) => {
  try {
    const id = req.query.id || req.query.slug;
    if (!id) return res.status(400).json({ error: 'Parameter id diperlukan' });
    res.json(await getSankaEpisode(id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/server', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Parameter id diperlukan' });
    res.json(await getSankaServer(id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🦊 KitsuneID API v6.1 running on port ${PORT}`);
  console.log('   Jikan (ongoing) + Sanka Vollerei Otakudesu (video)');

  const SELF = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/ping`
    : `http://localhost:${PORT}/ping`;
  setInterval(() => {
    const mod = SELF.startsWith('https') ? https : require('http');
    mod.get(SELF, r => console.log(`[ping] ${r.statusCode}`))
       .on('error', e => console.log('[ping] err:', e.message));
  }, 4 * 60 * 1000);

  setTimeout(async () => {
    try {
      console.log('[warm-up] Ongoing...');
      await getOngoing(1);
      console.log('[warm-up] ✅ Done!');
    } catch(e) { console.log('[warm-up] Error:', e.message); }
  }, 2000);
});
