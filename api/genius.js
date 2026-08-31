// api/genius.js
import axios from 'axios';
import * as cheerio from 'cheerio';

const GENIUS_API_BASE = 'https://api.genius.com';
const GENIUS_ACCESS_TOKEN = process.env.GENIUS_ACCESS_TOKEN;

// Cache sederhana (dalam memori) untuk lirik yang sudah di-scrape
// Berguna untuk mengurangi permintaan berulang pada satu instance serverless
const lyricsCache = new Map();

console.log('=== GENIUS API INIT ===');
console.log('Token exists?', !!GENIUS_ACCESS_TOKEN);
console.log('Token length:', GENIUS_ACCESS_TOKEN ? GENIUS_ACCESS_TOKEN.length : 0);

if (!GENIUS_ACCESS_TOKEN) {
    console.error('❌ GENIUS_ACCESS_TOKEN is not set in environment variables');
}

/**
 * Melakukan request authenticated ke Genius API
 */
async function geniusRequest(endpoint, params = {}) {
    console.log(`➡️ Requesting ${endpoint} with params:`, params);
    try {
        const response = await axios.get(`${GENIUS_API_BASE}${endpoint}`, {
            params,
            headers: {
                Authorization: `Bearer ${GENIUS_ACCESS_TOKEN}`,
                'User-Agent': 'Vercel Genius API Server/1.0',
                Accept: 'application/json',
            },
            timeout: 10000,
        });
        console.log(`✅ Response status: ${response.status}`);
        return response.data;
    } catch (error) {
        console.error('❌ Axios error:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', JSON.stringify(error.response.data));
            throw {
                status: error.response.status,
                message: error.response.data?.error || error.response.statusText,
                data: error.response.data,
            };
        }
        throw {
            status: 500,
            message: error.message || 'Internal server error',
        };
    }
}

/**
 * Scrape lirik dari halaman Genius dengan beberapa selector dan fallback
 */
async function scrapeLyrics(songUrl, retries = 1) {
    if (lyricsCache.has(songUrl)) {
        console.log(`📦 Using cached lyrics for ${songUrl}`);
        return lyricsCache.get(songUrl);
    }

    console.log(`📄 Scraping lyrics from: ${songUrl}`);
    let lastError = null;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            const response = await axios.get(songUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                timeout: 15000,
            });

            const $ = cheerio.load(response.data);

            // Daftar selector yang mungkin berisi lirik (diurutkan berdasarkan spesifisitas)
            const selectors = [
                '[data-lyrics-container="true"]',
                '.Lyrics__Container-sc-1ynbvzw-1',
                '.Lyrics__Container',
                '.song_body-lyrics',
                '.lyrics',
                '.SongPage__Lyrics-sc-1x6x1dt-1',
            ];

            let lyricsText = null;
            let foundSelector = null;

            for (const selector of selectors) {
                const elements = $(selector);
                if (elements.length > 0) {
                    foundSelector = selector;
                    // Ambil teks dari setiap elemen, gabungkan dengan newline
                    lyricsText = elements
                        .map((_, el) => $(el).text())
                        .get()
                        .join('\n')
                        .trim();
                    if (lyricsText) break;
                }
            }

            // Jika tidak ditemukan dengan selector di atas, coba cari semua div dengan class yang mengandung "Lyrics"
            if (!lyricsText) {
                const allDivs = $('div[class*="Lyrics"]');
                if (allDivs.length > 0) {
                    lyricsText = allDivs
                        .map((_, el) => $(el).text())
                        .get()
                        .join('\n')
                        .trim();
                    foundSelector = 'fallback (div[class*="Lyrics"])';
                }
            }

            if (lyricsText) {
                // Bersihkan teks: hapus spasi berlebih, baris kosong ganda
                lyricsText = lyricsText
                    .replace(/\n{3,}/g, '\n\n')
                    .replace(/[ \t]+/g, ' ')
                    .trim();

                console.log(`✅ Scraped lyrics (${foundSelector}): ${lyricsText.length} chars`);
                lyricsCache.set(songUrl, lyricsText);
                return lyricsText;
            }

            console.log(`⚠️ No lyrics found with any selector (attempt ${attempt})`);
            lastError = new Error('No lyrics container found');
        } catch (error) {
            console.error(`❌ Scraping attempt ${attempt} failed:`, error.message);
            lastError = error;
            if (attempt <= retries) {
                console.log(`🔄 Retrying (${attempt}/${retries})...`);
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }

    console.error('❌ All scraping attempts failed');
    return null;
}

/**
 * Format data lagu (dengan atau tanpa lirik)
 */
function formatSong(songData, lyrics = null) {
    const song = songData.song;
    return {
        id: song.id,
        title: song.title,
        full_title: song.full_title,
        url: song.url,
        image_url: song.song_art_image_url,
        artist: song.primary_artist?.name || 'Unknown Artist',
        artist_id: song.primary_artist?.id || null,
        album: song.album?.name || null,
        release_date: song.release_date_for_display || null,
        featured_artists: song.featured_artists?.map(a => a.name) || [],
        duration: song.duration || null,
        lyrics_state: song.lyrics_state || null,
        instrumental: song.instrumental || false,
        preview_url: song.media?.find(m => m.provider === 'youtube')?.url || null,
        lyrics: lyrics || null,
    };
}

/**
 * Handler utama untuk Vercel
 */
export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({
            error: 'Method not allowed. Use GET.',
            status: 405,
        });
    }

    const { action, ...params } = req.query;
    console.log(`🔍 Incoming request: action=${action}, params=`, params);

    if (!action) {
        return res.status(400).json({
            error: 'Missing required parameter: action',
            status: 400,
            available_actions: ['search', 'song', 'artist', 'album', 'lyrics', 'lyrics-by-title', 'songs-by-artist'],
            usage: {
                search: '/api/genius?action=search&q=bohemian+rhapsody',
                song: '/api/genius?action=song&id=12345',
                artist: '/api/genius?action=artist&id=67890',
                album: '/api/genius?action=album&id=11111',
                lyrics: '/api/genius?action=lyrics&id=12345',
                'lyrics-by-title': '/api/genius?action=lyrics-by-title&title=bohemian+rhapsody&artist=queen',
                'songs-by-artist': '/api/genius?action=songs-by-artist&id=67890&per_page=10',
            },
        });
    }

    // Cek token
    if (!GENIUS_ACCESS_TOKEN) {
        console.error('❌ Token missing in handler');
        return res.status(503).json({
            error: 'Genius API token not configured on server',
            status: 503,
            message: 'Please set GENIUS_ACCESS_TOKEN environment variable',
        });
    }

    try {
        let result;
        let status = 200;

        switch (action) {
            case 'search': {
                const { q, per_page = 10, page = 1 } = params;
                if (!q) {
                    return res.status(400).json({ error: 'Missing query parameter: q', status: 400 });
                }
                const data = await geniusRequest('/search', { q, per_page, page });
                const hits = data.response.hits.map(hit => ({
                    id: hit.result.id,
                    title: hit.result.title,
                    full_title: hit.result.full_title,
                    url: hit.result.url,
                    image_url: hit.result.song_art_image_url,
                    artist: hit.result.primary_artist?.name || 'Unknown',
                    artist_id: hit.result.primary_artist?.id || null,
                    album: hit.result.album?.name || null,
                    release_date: hit.result.release_date_for_display || null,
                    lyrics_state: hit.result.lyrics_state || null,
                }));
                result = {
                    action: 'search',
                    query: q,
                    page: parseInt(page),
                    per_page: parseInt(per_page),
                    total: data.response.meta?.total || hits.length,
                    hits,
                };
                break;
            }

            case 'song': {
                const { id } = params;
                if (!id) {
                    return res.status(400).json({ error: 'Missing song id', status: 400 });
                }
                const data = await geniusRequest(`/songs/${id}`);
                const song = formatSong(data.response);
                result = {
                    action: 'song',
                    song,
                };
                break;
            }

            case 'lyrics': {
                const { id } = params;
                if (!id) {
                    return res.status(400).json({ error: 'Missing song id', status: 400 });
                }
                const songData = await geniusRequest(`/songs/${id}`);
                const songUrl = songData.response.song.url;
                const lyrics = await scrapeLyrics(songUrl);
                const song = formatSong(songData.response, lyrics);
                result = {
                    action: 'lyrics',
                    song,
                    lyrics_available: !!lyrics,
                };
                break;
            }

            // 🔥 FITUR BARU: cari lirik berdasarkan judul & artis
            case 'lyrics-by-title': {
                const { title, artist } = params;
                if (!title) {
                    return res.status(400).json({ error: 'Missing title parameter', status: 400 });
                }

                // 1. Cari lagu
                const searchQuery = artist ? `${title} ${artist}` : title;
                const searchData = await geniusRequest('/search', { q: searchQuery, per_page: 5 });

                // Cari hit yang paling cocok (prioritaskan yang artisnya sama)
                let bestHit = null;
                const hits = searchData.response.hits;

                if (artist) {
                    // Cari yang artisnya cocok persis (case-insensitive)
                    const artistLower = artist.toLowerCase();
                    bestHit = hits.find(h =>
                        h.result.primary_artist?.name?.toLowerCase() === artistLower ||
                        h.result.artist_names?.toLowerCase().includes(artistLower)
                    );
                }

                // Jika tidak ada yang cocok, ambil hit pertama
                if (!bestHit && hits.length > 0) {
                    bestHit = hits[0];
                }

                if (!bestHit) {
                    return res.status(404).json({
                        error: 'Song not found',
                        status: 404,
                        message: `No song found for title: "${title}"${artist ? `, artist: "${artist}"` : ''}`,
                    });
                }

                // 2. Ambil lirik
                const songId = bestHit.result.id;
                const songUrl = bestHit.result.url;
                const lyrics = await scrapeLyrics(songUrl);

                // 3. Format hasil
                const song = {
                    id: bestHit.result.id,
                    title: bestHit.result.title,
                    full_title: bestHit.result.full_title,
                    url: songUrl,
                    image_url: bestHit.result.song_art_image_url,
                    artist: bestHit.result.primary_artist?.name || 'Unknown',
                    artist_id: bestHit.result.primary_artist?.id || null,
                    album: bestHit.result.album?.name || null,
                    release_date: bestHit.result.release_date_for_display || null,
                    lyrics: lyrics || null,
                };

                result = {
                    action: 'lyrics-by-title',
                    query: { title, artist: artist || null },
                    song,
                    lyrics_available: !!lyrics,
                };
                break;
            }

            case 'artist': {
                const { id } = params;
                if (!id) {
                    return res.status(400).json({ error: 'Missing artist id', status: 400 });
                }
                const data = await geniusRequest(`/artists/${id}`);
                const artist = data.response.artist;
                result = {
                    action: 'artist',
                    artist: {
                        id: artist.id,
                        name: artist.name,
                        image_url: artist.image_url,
                        header_image_url: artist.header_image_url,
                        url: artist.url,
                        description: artist.description?.dom?.replace(/<[^>]*>/g, '') || null,
                        fb_url: artist.facebook_name ? `https://facebook.com/${artist.facebook_name}` : null,
                        twitter_url: artist.twitter_name ? `https://twitter.com/${artist.twitter_name}` : null,
                        instagram_url: artist.instagram_name ? `https://instagram.com/${artist.instagram_name}` : null,
                        followers_count: artist.follower_count || 0,
                        verified: artist.verified || false,
                    },
                };
                break;
            }

            case 'songs-by-artist': {
                const { id, per_page = 20, page = 1, sort = 'title' } = params;
                if (!id) {
                    return res.status(400).json({ error: 'Missing artist id', status: 400 });
                }
                const data = await geniusRequest(`/artists/${id}/songs`, {
                    per_page,
                    page,
                    sort,
                });
                const songs = data.response.songs.map(song => ({
                    id: song.id,
                    title: song.title,
                    full_title: song.full_title,
                    url: song.url,
                    image_url: song.song_art_image_url,
                    artist: song.primary_artist?.name || 'Unknown',
                    release_date: song.release_date_for_display || null,
                    lyrics_state: song.lyrics_state || null,
                }));
                result = {
                    action: 'songs-by-artist',
                    artist_id: parseInt(id),
                    page: parseInt(page),
                    per_page: parseInt(per_page),
                    total: data.response?.meta?.total || songs.length,
                    songs,
                };
                break;
            }

            case 'album': {
                const { id } = params;
                if (!id) {
                    return res.status(400).json({ error: 'Missing album id', status: 400 });
                }
                const data = await geniusRequest(`/albums/${id}`);
                const album = data.response.album;
                result = {
                    action: 'album',
                    album: {
                        id: album.id,
                        name: album.name,
                        url: album.url,
                        image_url: album.cover_art_url,
                        artist: album.artist?.name || 'Unknown',
                        artist_id: album.artist?.id || null,
                        release_date: album.release_date || null,
                        track_count: album.track_count || 0,
                        tracks: album.tracklist?.map(t => ({
                            id: t.id,
                            title: t.title,
                            url: t.url,
                            artist: t.artist?.name || null,
                            number: t.track_number || null,
                        })) || [],
                    },
                };
                break;
            }

            default:
                return res.status(400).json({
                    error: `Unknown action: ${action}`,
                    status: 400,
                    available_actions: ['search', 'song', 'artist', 'album', 'lyrics', 'lyrics-by-title', 'songs-by-artist'],
                });
        }

        console.log(`✅ Request successful, sending response`);
        return res.status(status).json(result);
    } catch (error) {
        console.error('❌ API Error:', error);
        const status = error.status || 500;
        const message = error.message || 'Internal server error';
        return res.status(status).json({
            error: message,
            status,
            ...(error.data && { details: error.data }),
        });
    }
}