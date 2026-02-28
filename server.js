// ===== server.js — KitsuneID API v5.1 =====
// Arsitektur: Jikan (info) + SIPUTZX (episode list) + Sanka Vollerei (video)
const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Sumber data ───────────────────────────────
const JIKAN   = 'https://api.jikan.moe/v4';
const SIPUTZX = 'https://app.siputzx.my.id/api/anime';
const SANKA   = 'https://www.sankavollerei.com';

app.use(cors());
app.use(express.json());

// ── CACHE ─────────────────────────────────────
const cache = new Map();
const TTL = {
  ongoing:  15 * 60 * 1000,
  complete: 15 * 60 * 1000,
  schedule: 60 * 60 * 1000,
  search:   10 * 60 * 1000,
  anime:    60 * 60 * 1000,
  eplist:   30 * 60 * 1000,
  episode:  30 * 60 * 1000,
  server:   60 * 60 * 1000,
  slugmap:  60 * 60 * 1000,
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
function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    const req = mod.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'KitsuneID/5.1', ...headers },
      timeout: 15000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location, headers).then(resolve).catch(reject);
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

// Jikan rate limiter (max 3 req/detik)
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

// ══════════════════════════════════════════════
//   SLUG MAPPING: Jikan title → Samehadaku slug
// ══════════════════════════════════════════════
// Mapping {normalizedTitle → samehadakuSlug}
// Dibangun dari SIPUTZX release schedule (sudah terbukti akurat)

let slugMap = {}; // { "jujutsu kaisen season 3": "jujutsu-kaisen-season-3", ... }

async function buildSlugMap() {
  const cached = getCache('slugmap');
  if (cached) { slugMap = cached; return; }
  try {
    const d = await fetchJSON(`${SIPUTZX}/samehadaku/release`);
    if (!d.status || !d.data) return;
    const newMap = {};
    Object.values(d.data).forEach(dayList => {
      (dayList || []).forEach(anime => {
        if (!anime.title || !anime.slug) return;
        // key: normalize judul (lowercase, tanpa tanda baca)
        const key = normalizeTitle(anime.title);
        newMap[key] = anime.slug;
        // Juga simpan dengan variasi umum (tanpa "sub indo")
        newMap[normalizeTitle(anime.title.replace(/\s+sub\s+indo/gi, ''))] = anime.slug;
      });
    });
    slugMap = newMap;
    setCache('slugmap', newMap, TTL.slugmap);
    console.log(`[slugmap] Built with ${Object.keys(newMap).length} entries`);
  } catch(e) {
    console.log('[slugmap] Error:', e.message);
  }
}

function normalizeTitle(title) {
  return (title || '').toLowerCase()
    .replace(/[^\w\s]/g, '') // hapus tanda baca
    .replace(/\s+/g, ' ')
    .trim();
}

// Cari slug Samehadaku yang tepat untuk anime dari Jikan
function findSamehadakuSlug(jikanTitle) {
  const key = normalizeTitle(jikanTitle);
  if (slugMap[key]) return slugMap[key];

  // Fallback: generate slug manual dari judul
  return jikanTitle.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function titleToSlug(title) {
  return (title || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// ══════════════════════════════════════════════
//   JIKAN — Info anime
// ══════════════════════════════════════════════

function formatAnime(a) {
  if (!a) return null;
  const jikanTitle = a.title || a.title_english || 'Unknown';
  return {
    mal_id:   a.mal_id,
    title:    jikanTitle,
    titleEn:  a.title_english || '',
    slug:     findSamehadakuSlug(jikanTitle), // pakai slug mapping!
    thumb:    a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '',
    synopsis: a.synopsis || 'Tidak ada sinopsis.',
    rating:   a.score ? String(a.score) : null,
    status:   a.status === 'Currently Airing' ? 'Ongoing' :
              a.status === 'Finished Airing'   ? 'Complete' : (a.status || ''),
    type:     a.type || 'TV',
    episode:  a.episodes ? String(a.episodes) : '?',
    duration: a.duration || null,
    aired:    a.aired?.string || null,
    studio:   a.studios?.[0]?.name || null,
    genres:   a.genres?.map(g => g.name) || [],
    episodes: [],
  };
}

async function getOngoing(page = 1) {
  const k = `ongoing_${page}`;
  const cached = getCache(k);
  if (cached) return cached;
  const d = await jikan(`/seasons/now?filter=tv&limit=24&page=${page}`);
  const animes = (d.data || []).map(formatAnime).filter(Boolean);
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
  const animes = (d.data || []).map(formatAnime).filter(Boolean).map(a => ({ ...a, status: 'Complete' }));
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
        slug:    findSamehadakuSlug(a.title),
        thumb:   a.images?.jpg?.image_url || '',
        episode: a.episodes ? String(a.episodes) : '?',
      }));
    if (list.length) schedules.push({ day: dayId[i], animeList: list });
  });
  setCache(k, schedules, TTL.schedule);
  return schedules;
}

async function searchAnime(query) {
  const k = `search_${query.toLowerCase().trim()}`;
  const cached = getCache(k);
  if (cached) return cached;
  const d = await jikan(`/anime?q=${encodeURIComponent(query)}&limit=10&type=tv`);
  const results = (d.data || []).map(a => ({
    mal_id:  a.mal_id,
    title:   a.title || '',
    slug:    findSamehadakuSlug(a.title || ''),
    thumb:   a.images?.jpg?.image_url || '',
    status:  a.status === 'Currently Airing' ? 'Ongoing' : 'Complete',
    type:    a.type || 'TV',
    rating:  a.score ? String(a.score) : null,
  }));
  setCache(k, results, TTL.search);
  return results;
}

async function getAnimeDetail(slugOrId) {
  const k = `anime_${slugOrId}`;
  const cached = getCache(k);
  if (cached) return cached;

  let data;
  if (/^\d+$/.test(slugOrId)) {
    const d = await jikan(`/anime/${slugOrId}/full`);
    data = d.data;
  } else {
    const query = slugOrId.replace(/-/g, ' ');
    const d = await jikan(`/anime?q=${encodeURIComponent(query)}&limit=5`);
    data = d.data?.[0];
  }
  if (!data) return null;

  const anime = formatAnime(data);
  // anime.slug sekarang sudah pakai slug Samehadaku yang benar!

  // Ambil episode list dari SIPUTZX (lebih reliable, full list)
  try {
    anime.episodes = await getEpisodeListSiputzx(anime.slug);
    console.log(`[SIPUTZX] Episodes for ${anime.slug}: ${anime.episodes.length}`);
  } catch(e) {
    console.log(`[SIPUTZX] Episode list error for ${anime.slug}: ${e.message}`);
    anime.episodes = [];
  }

  setCache(k, anime, TTL.anime);
  return anime;
}

// ══════════════════════════════════════════════
//   SIPUTZX — Episode list (full, akurat)
// ══════════════════════════════════════════════

async function getEpisodeListSiputzx(samehadakuSlug) {
  const k = `eplist_${samehadakuSlug}`;
  const cached = getCache(k);
  if (cached) return cached;

  const url = `https://v1.samehadaku.how/anime/${samehadakuSlug}/`;
  const d   = await fetchJSON(
    `${SIPUTZX}/samehadaku/detail?link=${encodeURIComponent(url)}`
  );

  if (!d.status || !d.data?.episodes?.length) {
    throw new Error(`No episodes found for slug: ${samehadakuSlug}`);
  }

  // SIPUTZX episode format: { title, date, link }
  // link: "https://v1.samehadaku.how/EPISODE-SLUG/"
  // Kita extract episodeId dari link untuk Sanka
  const episodes = d.data.episodes.map(ep => {
    const epSlug = ep.link.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
    // Nomor episode dari title: "Blue Lock Season 2 Episode 1" → "1"
    const num = ep.title?.match(/episode\s+(\d+[\w.-]*)/i)?.[1] ||
                epSlug.match(/episode-(\d+[\w-]*)/)?.[1] || '?';
    return {
      title:   ep.title || `Episode ${num}`,
      episode: num,
      slug:    epSlug,          // format: "anime-title-episode-1"
      date:    ep.date || '',
    };
  }).reverse(); // SIPUTZX urutkan dari terbaru, reverse ke EP1 dulu

  setCache(k, episodes, TTL.eplist);
  return episodes;
}

// ══════════════════════════════════════════════
//   SANKA VOLLEREI — Video player
// ══════════════════════════════════════════════

async function getSankaEpisode(episodeId) {
  const k = `ep_${episodeId}`;
  const cached = getCache(k);
  if (cached) return cached;

  const d = await fetchJSON(`${SANKA}/anime/samehadaku/episode/${episodeId}`);
  if (d.status !== 'success' || !d.data) throw new Error('Episode not found');

  const qualities = [];
  (d.data.server?.qualities || []).forEach(q => {
    if (!q.serverList?.length) return;
    q.serverList.forEach(s => {
      qualities.push({
        quality:  q.title,
        name:     s.title,
        serverId: s.serverId,
      });
    });
  });

  const result = {
    title:      d.data.title,
    animeId:    d.data.animeId,
    defaultUrl: d.data.defaultStreamingUrl || null,
    qualities,
    prevEp:     d.data.prevEpisode?.episodeId || null,
    nextEp:     d.data.nextEpisode?.episodeId || null,
    downloads:  buildDownloads(d.data.downloadUrl),
  };

  setCache(k, result, TTL.episode);
  return result;
}

async function getSankaServer(serverId) {
  const k = `server_${serverId}`;
  const cached = getCache(k);
  if (cached) return cached;

  const d = await fetchJSON(`${SANKA}/anime/samehadaku/server/${serverId}`);
  if (d.status !== 'success') throw new Error('Server error');

  const url = d.data?.url || null;
  if (url) setCache(k, { url }, TTL.server);
  return { url };
}

function buildDownloads(downloadUrl) {
  if (!downloadUrl?.formats) return [];
  const result = [];
  downloadUrl.formats.forEach(fmt => {
    (fmt.qualities || []).forEach(q => {
      (q.urls || []).slice(0, 3).forEach(u => {
        result.push({ quality: q.title.trim(), host: u.title, url: u.url });
      });
    });
  });
  return result;
}

// ══════════════════════════════════════════════
//   ROUTES
// ══════════════════════════════════════════════

app.get('/', (req, res) => res.json({
  name: 'KitsuneID API', version: '5.1.0', status: 'running 🦊',
  sources: { info: 'Jikan', episodes: 'SIPUTZX', video: 'Sanka Vollerei' },
  slugMapSize: Object.keys(slugMap).length,
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
    const id = req.query.id || req.query.slug;
    if (!id) return res.status(400).json({ error: 'Parameter slug atau id diperlukan' });
    const data = await getAnimeDetail(id);
    if (!data) return res.status(404).json({ error: 'Anime tidak ditemukan' });
    res.json(data);
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

// Debug: lihat slug mapping
app.get('/debug/slug', (req, res) => {
  const q = req.query.q || '';
  if (q) {
    const key = normalizeTitle(q);
    res.json({ query: q, key, result: slugMap[key] || 'NOT FOUND', mapSize: Object.keys(slugMap).length });
  } else {
    const sample = Object.entries(slugMap).slice(0, 20);
    res.json({ mapSize: Object.keys(slugMap).length, sample });
  }
});

// ── START ─────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🦊 KitsuneID API v5.1 running on port ${PORT}`);
  console.log('   Jikan + SIPUTZX (episodes) + Sanka Vollerei (video)');

  // Keep-alive
  const SELF = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/ping`
    : `http://localhost:${PORT}/ping`;
  setInterval(() => {
    const mod = SELF.startsWith('https') ? https : require('http');
    mod.get(SELF, r => console.log(`[ping] ${r.statusCode}`))
       .on('error', e => console.log('[ping] err:', e.message));
  }, 4 * 60 * 1000);

  // Warm-up: build slug map dulu, baru load data
  setTimeout(async () => {
    try {
      console.log('[warm-up] Building slug map...');
      await buildSlugMap();
      console.log('[warm-up] Loading ongoing...');
      await getOngoing(1);
      console.log('[warm-up] Loading schedule...');
      await getSchedule();
      console.log('[warm-up] ✅ Done!');
    } catch(e) { console.log('[warm-up] Error:', e.message); }
  }, 2000);
});
