// ===== server.js — KitsuneID API v6 =====
// Arsitektur: SIPUTZX Otakudesu (info) + Sanka Vollerei Otakudesu (video)
// Zero Jikan, Zero ScraperAPI — semua gratis!
const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

const SIPUTZX = 'https://app.siputzx.my.id/api/anime/otakudesu';
const SANKA   = 'https://www.sankavollerei.com/anime';

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
      headers: { 'Accept': 'application/json', 'User-Agent': 'KitsuneID/6.0' },
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

// ══════════════════════════════════════════════
//   SIPUTZX — Otakudesu info
// ══════════════════════════════════════════════

// Format anime card (dari ongoing/search SIPUTZX)
function formatCard(a) {
  return {
    title:   a.title  || a.judul || '',
    slug:    a.slug   || a.endpoint?.replace(/\//g, '') || '',
    thumb:   a.thumb  || a.cover || a.poster || '',
    episode: a.episode ? String(a.episode) : '?',
    status:  a.status || 'Ongoing',
    rating:  a.rating || null,
    type:    a.type   || 'TV',
  };
}

async function getOngoing(page = 1) {
  const k = `ongoing_${page}`;
  const cached = getCache(k);
  if (cached) return cached;

  const d = await fetchJSON(`${SIPUTZX}/ongoing?page=${page}`);
  if (!d.status) throw new Error('SIPUTZX ongoing failed');

  // SIPUTZX bisa return array langsung atau { data: [...] }
  const list = Array.isArray(d.data) ? d.data : (d.data?.animeList || d.animeList || []);
  const animes = list.map(formatCard).filter(a => a.title);

  setCache(k, animes, TTL.ongoing);
  return animes;
}

async function getComplete(page = 1) {
  const k = `complete_${page}`;
  const cached = getCache(k);
  if (cached) return cached;

  // SIPUTZX tidak punya /complete langsung — pakai ongoing tapi filter Complete
  // atau coba endpoint complete kalau ada
  let animes = [];
  try {
    const d = await fetchJSON(`${SIPUTZX}/complete?page=${page}`);
    const list = Array.isArray(d.data) ? d.data : (d.data?.animeList || []);
    animes = list.map(a => ({ ...formatCard(a), status: 'Complete' })).filter(a => a.title);
  } catch(e) {
    // fallback: ongoing page berikutnya
    console.log('[complete] fallback to ongoing page 2');
    animes = await getOngoing(page + 1);
  }

  setCache(k, animes, TTL.complete);
  return animes;
}

async function searchAnime(query) {
  const k = `search_${query.toLowerCase().trim()}`;
  const cached = getCache(k);
  if (cached) return cached;

  const d = await fetchJSON(`${SIPUTZX}/search?q=${encodeURIComponent(query)}`);
  const list = Array.isArray(d.data) ? d.data : (d.data?.animeList || []);
  const results = list.map(formatCard).filter(a => a.title);

  setCache(k, results, TTL.search);
  return results;
}

async function getAnimeDetail(slug) {
  const k = `anime_${slug}`;
  const cached = getCache(k);
  if (cached) return cached;

  // SIPUTZX detail endpoint
  const d = await fetchJSON(`${SIPUTZX}/detail?slug=${encodeURIComponent(slug)}`);
  if (!d.status || !d.data) throw new Error('Anime tidak ditemukan');

  const raw = d.data;

  // Format episode list dari SIPUTZX detail
  // SIPUTZX episode format: { title, slug/endpoint, ... }
  const episodes = (raw.episodeList || raw.episodes || []).map(ep => {
    const epSlug = ep.slug || ep.endpoint?.replace(/\//g, '') || ep.episodeId || '';
    const num    = ep.eps || ep.episode ||
                   epSlug.match(/episode-?(\d+)/i)?.[1] ||
                   ep.title?.match(/\d+/)?.[0] || '?';
    return {
      title:   ep.title || `Episode ${num}`,
      episode: String(num),
      slug:    epSlug,
    };
  }).reverse(); // SIPUTZX urutkan terbaru dulu

  const anime = {
    title:    raw.title || raw.judul || slug,
    slug,
    thumb:    raw.thumb || raw.cover || raw.poster || '',
    synopsis: raw.synopsis || raw.sinopsis || raw.desc || 'Tidak ada sinopsis.',
    rating:   raw.rating || raw.score || null,
    status:   raw.status || 'Ongoing',
    type:     raw.type || 'TV',
    episode:  raw.totalEpisode || raw.episode || String(episodes.length),
    studio:   raw.studio || null,
    genres:   raw.genreList?.map(g => g.title || g) ||
              raw.genres?.map(g => g.title || g) || [],
    episodes,
  };

  setCache(k, anime, TTL.anime);
  return anime;
}

// Jadwal dari SIPUTZX (jika ada) atau generate dari ongoing
async function getSchedule() {
  const k = 'schedule';
  const cached = getCache(k);
  if (cached) return cached;

  // Coba endpoint jadwal Otakudesu (Otakudesu punya halaman jadwal)
  // Kalau tidak ada di SIPUTZX, kita susun dari ongoing grouped by hari
  try {
    const d = await fetchJSON(`${SIPUTZX}/schedule`);
    if (d.status && d.data) {
      const schedules = [];
      const dayNames = {
        senin: 'Senin', selasa: 'Selasa', rabu: 'Rabu',
        kamis: 'Kamis', jumat: 'Jumat', sabtu: 'Sabtu', minggu: 'Minggu',
        monday: 'Senin', tuesday: 'Selasa', wednesday: 'Rabu',
        thursday: 'Kamis', friday: 'Jumat', saturday: 'Sabtu', sunday: 'Minggu',
      };
      Object.entries(d.data).forEach(([day, list]) => {
        const dayId = dayNames[day.toLowerCase()] || day;
        const animeList = (list || []).map(formatCard).filter(a => a.title);
        if (animeList.length) schedules.push({ day: dayId, animeList });
      });
      setCache(k, schedules, TTL.schedule);
      return schedules;
    }
  } catch(e) {
    console.log('[schedule] SIPUTZX endpoint not found, using SIPUTZX Samehadaku release');
  }

  // Fallback: pakai SIPUTZX Samehadaku release (sudah terbukti ada)
  const d2 = await fetchJSON('https://app.siputzx.my.id/api/anime/samehadaku/release');
  if (!d2.status || !d2.data) throw new Error('Schedule not available');

  const dayNames = {
    sunday: 'Minggu', monday: 'Senin', tuesday: 'Selasa',
    wednesday: 'Rabu', thursday: 'Kamis', friday: 'Jumat', saturday: 'Sabtu'
  };
  const schedules = [];
  Object.entries(d2.data).forEach(([day, list]) => {
    const dayId = dayNames[day] || day;
    const animeList = (list || []).map(a => ({
      title:   a.title || '',
      slug:    a.slug  || '',
      thumb:   a.featured_img_src || '',
      episode: '?',
      status:  'Ongoing',
      rating:  a.east_score || null,
    })).filter(a => a.title);
    if (animeList.length) schedules.push({ day: dayId, animeList });
  });

  setCache(k, schedules, TTL.schedule);
  return schedules;
}

// ══════════════════════════════════════════════
//   SANKA VOLLEREI — Otakudesu video
// ══════════════════════════════════════════════

async function getSankaEpisode(episodeId) {
  const k = `ep_${episodeId}`;
  const cached = getCache(k);
  if (cached) return cached;

  const d = await fetchJSON(`${SANKA}/episode/${episodeId}`);
  if (d.status !== 'success' || !d.data) throw new Error('Episode not found');

  const ep = d.data;

  // Susun kualitas dari server.qualities
  const qualities = [];
  (ep.server?.qualities || []).forEach(q => {
    (q.serverList || []).forEach(s => {
      if (s.serverId) {
        qualities.push({
          quality:  q.title,      // "480p", "720p"
          name:     s.title,      // "otakuwatch5", "vidhide"
          serverId: s.serverId,
        });
      }
    });
  });

  // Episode list dari info.episodeList (sudah lengkap!)
  const episodeList = (ep.info?.episodeList || []).map(e => ({
    title:   e.title || `Episode ${e.eps}`,
    episode: String(e.eps),
    slug:    e.episodeId,
  })).sort((a, b) => parseFloat(a.episode) - parseFloat(b.episode));

  const result = {
    title:       ep.title,
    animeId:     ep.animeId,
    defaultUrl:  ep.defaultStreamingUrl || null,
    qualities,
    episodeList, // bonus: list episode lengkap untuk sync
    prevEp:      ep.prevEpisode?.episodeId || null,
    nextEp:      ep.nextEpisode?.episodeId || null,
    downloads:   buildDownloads(ep.downloadUrl),
  };

  setCache(k, result, TTL.episode);
  return result;
}

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

function buildDownloads(downloadUrl) {
  if (!downloadUrl?.qualities) return [];
  const result = [];
  (downloadUrl.qualities || []).forEach(q => {
    (q.urls || []).slice(0, 3).forEach(u => {
      result.push({
        quality: q.title.trim(),
        size:    q.size || '',
        host:    u.title,
        url:     u.url,
      });
    });
  });
  return result;
}

// ══════════════════════════════════════════════
//   ROUTES
// ══════════════════════════════════════════════

app.get('/', (req, res) => res.json({
  name: 'KitsuneID API', version: '6.0.0', status: 'running 🦊',
  sources: { info: 'SIPUTZX (Otakudesu)', video: 'Sanka Vollerei (Otakudesu)' },
  cache: cache.size,
  endpoints: ['/ongoing','/complete','/schedule','/search','/anime','/episode','/server'],
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
    const slug = req.query.slug || req.query.id;
    if (!slug) return res.status(400).json({ error: 'Parameter slug diperlukan' });
    const data = await getAnimeDetail(slug);
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

// ── START ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🦊 KitsuneID API v6.0 running on port ${PORT}`);
  console.log('   SIPUTZX (Otakudesu info) + Sanka Vollerei (video)');

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
