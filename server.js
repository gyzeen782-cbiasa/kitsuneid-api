// ===== server.js — KitsuneID API v5 =====
// Arsitektur: Jikan API (info) + Sanka Vollerei (episode/video)
// Zero ScraperAPI — semua gratis!
const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Sumber data ───────────────────────────────
const JIKAN = 'https://api.jikan.moe/v4';
const SANKA = 'https://www.sankavollerei.com';

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

// Fetch JSON dari URL manapun
function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    const req = mod.get(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'KitsuneID/5.0',
        ...headers
      },
      timeout: 15000
    }, res => {
      // Ikuti redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ── Jikan rate limiter (max 3 req/detik) ─────
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

// ── Sanka Vollerei fetch ──────────────────────
function sanka(path) {
  return fetchJSON(`${SANKA}${path}`);
}

// ══════════════════════════════════════════════
//   JIKAN — Info anime
// ══════════════════════════════════════════════

function titleToSlug(title) {
  return (title || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function formatAnime(a) {
  if (!a) return null;
  return {
    mal_id:   a.mal_id,
    title:    a.title || a.title_english || 'Unknown',
    titleEn:  a.title_english || '',
    slug:     titleToSlug(a.title || ''),
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
    day:      a.broadcast?.day?.replace(' JST', '') || null,
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
  const days   = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const dayId  = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];
  const results = await Promise.allSettled(
    days.map(d => jikan(`/schedules?filter=${d}&limit=25`))
  );
  const schedules = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') return;
    const list = (r.value.data || []).map(a => ({
      mal_id: a.mal_id,
      title:  a.title || '',
      slug:   titleToSlug(a.title || ''),
      thumb:  a.images?.jpg?.image_url || '',
      episode: a.episodes ? String(a.episodes) : '?',
    })).filter(a => a.title);
    // Deduplicate
    const seen = new Set();
    const unique = list.filter(a => {
      if (seen.has(a.mal_id)) return false;
      seen.add(a.mal_id); return true;
    });
    if (unique.length) schedules.push({ day: dayId[i], animeList: unique });
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
    mal_id: a.mal_id,
    title:  a.title || '',
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
  if (cached) return cached;

  let data;
  if (/^\d+$/.test(slugOrId)) {
    const d = await jikan(`/anime/${slugOrId}/full`);
    data = d.data;
  } else {
    const query = slugOrId.replace(/-sub-indo/gi, '').replace(/-/g, ' ');
    const d = await jikan(`/anime?q=${encodeURIComponent(query)}&limit=5`);
    data = d.data?.[0];
  }
  if (!data) return null;

  const anime = formatAnime(data);

  // Ambil episode list dari Sanka Vollerei
  try {
    anime.episodes = await getSankaEpisodeList(anime.slug);
    console.log(`[Sanka] Episodes for ${anime.slug}: ${anime.episodes.length}`);
  } catch(e) {
    console.log(`[Sanka] Episode list error: ${e.message}`);
    anime.episodes = [];
  }

  setCache(k, anime, TTL.anime);
  return anime;
}

// ══════════════════════════════════════════════
//   SANKA VOLLEREI — Episode & Video
// ══════════════════════════════════════════════

// Ambil daftar episode dari Sanka Vollerei
async function getSankaEpisodeList(animeSlug) {
  const k = `eplist_${animeSlug}`;
  const cached = getCache(k);
  if (cached) return cached;

  // Coba ambil via episode pertama → dapat recommendedEpisodeList
  const epId = `${animeSlug}-episode-1`;
  const d = await sanka(`/anime/samehadaku/episode/${epId}`);

  if (d.status !== 'success' || !d.data) throw new Error('Sanka episode not found');

  // Bangun list dari recommendedEpisodeList + current episode
  const rawList = d.data.recommendedEpisodeList || [];

  // Tambah episode 1 sendiri jika belum ada
  const allEps = [];
  const seen = new Set();

  // Episode dari recommended list
  rawList.forEach(ep => {
    if (!ep.episodeId || seen.has(ep.episodeId)) return;
    seen.add(ep.episodeId);
    const num = ep.episodeId.match(/episode-(\d+[\w-]*)/)?.[1] || '?';
    allEps.push({
      title: ep.title || `Episode ${num}`,
      episode: num,
      slug: ep.episodeId,
    });
  });

  // Tambah ep 1 jika belum ada
  if (!seen.has(epId)) {
    allEps.push({
      title: d.data.title || `Episode 1`,
      episode: '1',
      slug: epId,
    });
  }

  // Sort berdasarkan nomor episode
  allEps.sort((a, b) => {
    const na = parseFloat(a.episode) || 0;
    const nb = parseFloat(b.episode) || 0;
    return na - nb;
  });

  setCache(k, allEps, TTL.eplist);
  return allEps;
}

// Ambil data video dari satu episode
async function getSankaEpisode(episodeId) {
  const k = `ep_${episodeId}`;
  const cached = getCache(k);
  if (cached) return cached;

  const d = await sanka(`/anime/samehadaku/episode/${episodeId}`);
  if (d.status !== 'success' || !d.data) throw new Error('Episode not found');

  const epData = d.data;

  // Susun daftar kualitas dari server.qualities
  const qualities = [];
  (epData.server?.qualities || []).forEach(q => {
    if (!q.serverList?.length) return;
    q.serverList.forEach(s => {
      qualities.push({
        quality: q.title,          // "360p", "480p", "720p", "1080p"
        name:    s.title,          // "Premium 1080p", "Vidhide 720p"
        serverId: s.serverId,      // "8DE8E-9-xhmyrq"
      });
    });
  });

  const result = {
    title:    epData.title,
    animeId:  epData.animeId,
    defaultUrl: epData.defaultStreamingUrl || null,
    qualities,
    // Navigasi
    prevEp: epData.prevEpisode?.episodeId || null,
    nextEp: epData.nextEpisode?.episodeId || null,
    // Download bonus
    downloads: buildDownloads(epData.downloadUrl),
  };

  setCache(k, result, TTL.episode);
  return result;
}

// Ambil embed/MP4 URL dari serverId
async function getSankaServer(serverId) {
  const k = `server_${serverId}`;
  const cached = getCache(k);
  if (cached) return cached;

  const d = await sanka(`/anime/samehadaku/server/${serverId}`);
  if (d.status !== 'success') throw new Error('Server error');

  const url = d.data?.url || null;
  if (url) setCache(k, { url }, TTL.server);
  return { url };
}

// Helper: susun download links yang bersih
function buildDownloads(downloadUrl) {
  if (!downloadUrl?.formats) return [];
  const result = [];
  downloadUrl.formats.forEach(fmt => {
    (fmt.qualities || []).forEach(q => {
      (q.urls || []).slice(0, 3).forEach(u => { // max 3 host per kualitas
        result.push({
          quality: q.title.trim(),
          host:    u.title,
          url:     u.url,
        });
      });
    });
  });
  return result;
}

// ══════════════════════════════════════════════
//   ROUTES
// ══════════════════════════════════════════════

app.get('/', (req, res) => res.json({
  name: 'KitsuneID API',
  version: '5.0.0',
  status: 'running 🦊',
  sources: { info: 'Jikan (MAL)', video: 'Sanka Vollerei (Samehadaku)' },
  cache: cache.size,
  endpoints: ['/ongoing','/complete','/schedule','/search','/anime',
              '/episode','/server','/ping','/cache/clear']
}));

app.get('/ping', (req, res) => res.json({ pong: true, time: new Date().toISOString() }));

app.get('/cache/clear', (req, res) => {
  const n = cache.size; cache.clear();
  res.json({ cleared: n });
});

// Ongoing
app.get('/ongoing', async (req, res) => {
  try { res.json({ animes: await getOngoing(+req.query.page || 1) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Complete
app.get('/complete', async (req, res) => {
  try { res.json({ animes: await getComplete(+req.query.page || 1) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Schedule
app.get('/schedule', async (req, res) => {
  try { res.json({ schedules: await getSchedule() }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Search
app.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Parameter q diperlukan' });
    res.json({ results: await searchAnime(q) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Anime detail
app.get('/anime', async (req, res) => {
  try {
    const id = req.query.id || req.query.slug;
    if (!id) return res.status(400).json({ error: 'Parameter slug atau id diperlukan' });
    const data = await getAnimeDetail(id);
    if (!data) return res.status(404).json({ error: 'Anime tidak ditemukan' });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Episode — data video + kualitas
app.get('/episode', async (req, res) => {
  try {
    const id = req.query.id || req.query.slug;
    if (!id) return res.status(400).json({ error: 'Parameter id diperlukan' });
    res.json(await getSankaEpisode(id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Server — dapat MP4 URL dari serverId
app.get('/server', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Parameter id diperlukan' });
    res.json(await getSankaServer(id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🦊 KitsuneID API v5.0 running on port ${PORT}`);
  console.log('   Jikan (info) + Sanka Vollerei (video) — Zero ScraperAPI!');

  // Keep-alive
  const SELF = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/ping`
    : `http://localhost:${PORT}/ping`;
  setInterval(() => {
    const mod = SELF.startsWith('https') ? https : require('http');
    mod.get(SELF, r => console.log(`[ping] ${r.statusCode}`))
       .on('error', e => console.log('[ping] err:', e.message));
  }, 4 * 60 * 1000);

  // Warm-up cache
  setTimeout(async () => {
    try {
      console.log('[warm-up] Ongoing...');
      await getOngoing(1);
      console.log('[warm-up] Schedule...');
      await getSchedule();
      console.log('[warm-up] ✅ Done!');
    } catch(e) { console.log('[warm-up] Error:', e.message); }
  }, 3000);
});
