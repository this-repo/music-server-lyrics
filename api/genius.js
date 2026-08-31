// api/genius.js
import axios from 'axios';
import * as cheerio from 'cheerio';

const GENIUS_API_BASE = 'https://api.genius.com';
const GENIUS_ACCESS_TOKEN = process.env.GENIUS_ACCESS_TOKEN;

if (!GENIUS_ACCESS_TOKEN) {
    console.error('❌ GENIUS_ACCESS_TOKEN is not set in environment variables');
}

/**
 * Make authenticated request to Genius API
 */
async function geniusRequest(endpoint, params = {}) {
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
        return response.data;
    } catch (error) {
        if (error.response) {
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
 * Scrape lyrics from Genius song page
 */
async function scrapeLyrics(songUrl) {
    try {
        const response = await axios.get(songUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            timeout: 15000,
        });

        const $ = cheerio.load(response.data);

        // Genius lyrics are in div with class "Lyrics__Container"
        const lyricsContainers = $('[class*="Lyrics__Container"]');
        if (lyricsContainers.length === 0) {
            // Try alternative selectors
            const altContainers = $('.lyrics, .song_body-lyrics, [data-lyrics-container="true"]');
            if (altContainers.length === 0) {
                return null;
            }
            const lyrics = altContainers
                .map((_, el) => $(el).text())
                .get()
                .join('\n')
                .trim();
            return lyrics || null;
        }

        const lyrics = lyricsContainers
            .map((_, el) => $(el).text())
            .get()
            .join('\n')
            .trim();

        return lyrics || null;
    } catch (error) {
        console.error('Lyrics scraping error:', error.message);
        return null;
    }
}

/**
 * Format song data with optional lyrics
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
 * Main API handler for Vercel serverless function
 */
export default async function handler(req, res) {
    // Enable CORS
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

    if (!action) {
        return res.status(400).json({
            error: 'Missing required parameter: action',
            status: 400,
            available_actions: ['search', 'song', 'artist', 'album', 'lyrics', 'songs-by-artist'],
            usage: {
                search: '/api/genius?action=search&q=bohemian+rhapsody',
                song: '/api/genius?action=song&id=12345',
                artist: '/api/genius?action=artist&id=67890',
                album: '/api/genius?action=album&id=11111',
                lyrics: '/api/genius?action=lyrics&id=12345',
                'songs-by-artist': '/api/genius?action=songs-by-artist&id=67890&per_page=10',
            },
        });
    }

    // Check for API token
    if (!GENIUS_ACCESS_TOKEN) {
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
                // First get song details to get the URL
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
                    available_actions: ['search', 'song', 'artist', 'album', 'lyrics', 'songs-by-artist'],
                });
        }

        return res.status(status).json(result);
    } catch (error) {
        console.error('API Error:', error);
        const status = error.status || 500;
        const message = error.message || 'Internal server error';
        return res.status(status).json({
            error: message,
            status,
            ...(error.data && { details: error.data }),
        });
    }
}