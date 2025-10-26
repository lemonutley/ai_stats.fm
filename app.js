// State
let allEntries = [];
let filteredEntries = [];
let currentPeriod = 'all';
let charts = {};
let imageCache = {};
let db = null;
let spotifyAccessToken = null;
let spotifyRefreshToken = null;
let userAccessToken = null;
let autoSyncInterval = null;
let genreCache = {};
let isRendering = false;

// Spotify API credentials
const SPOTIFY_CLIENT_ID = '975915ce02eb42a18f959d24e36c6099'; // Replace with your client ID
const SPOTIFY_CLIENT_SECRET = '37ff828db2294fbc8ad4caa1de44d13e'; // Replace with your client secret
const REDIRECT_URI = 'https://lemonutley.github.io/ai_stats.fm/'; // Replace with your redirect URI

// Initialize IndexedDB for images, data, and tokens
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('SpotifyDataDB', 2);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
            if (!db.objectStoreNames.contains('images')) {
                db.createObjectStore('images', { keyPath: 'uri' });
            }
            
            if (!db.objectStoreNames.contains('spotifyData')) {
                db.createObjectStore('spotifyData', { keyPath: 'id' });
            }
        };
    });
}

// Image cache functions
async function getImageFromDB(uri) {
    if (!db) await initDB();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['images'], 'readonly');
        const store = transaction.objectStore('images');
        const request = store.get(uri);
        
        request.onsuccess = () => {
            resolve(request.result?.url || null);
        };
        request.onerror = () => reject(request.error);
    });
}

async function saveImageToDB(uri, url) {
    if (!db) await initDB();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['images'], 'readwrite');
        const store = transaction.objectStore('images');
        const request = store.put({ uri, url, timestamp: Date.now() });
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Spotify data storage functions
async function saveSpotifyData(entries) {
    if (!db) await initDB();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['spotifyData'], 'readwrite');
        const store = transaction.objectStore('spotifyData');
        
        const dataToSave = {
            id: 'main',
            entries: entries,
            savedAt: new Date().toISOString(),
            count: entries.length
        };
        
        const request = store.put(dataToSave);
        
        request.onsuccess = () => {
            console.log(`Saved ${entries.length.toLocaleString()} entries to IndexedDB`);
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

async function loadSpotifyData() {
    if (!db) await initDB();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['spotifyData'], 'readonly');
        const store = transaction.objectStore('spotifyData');
        const request = store.get('main');
        
        request.onsuccess = () => {
            const result = request.result;
            if (result && result.entries) {
                console.log(`Loaded ${result.count.toLocaleString()} entries from IndexedDB (saved ${new Date(result.savedAt).toLocaleString()})`);
                resolve(result.entries);
            } else {
                resolve(null);
            }
        };
        request.onerror = () => reject(request.error);
    });
}

async function clearSpotifyData() {
    if (!db) await initDB();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['spotifyData'], 'readwrite');
        const store = transaction.objectStore('spotifyData');
        const request = store.delete('main');
        
        request.onsuccess = () => {
            console.log('Cleared saved Spotify data');
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

// Token storage functions
async function saveTokens(accessToken, refreshToken) {
    if (!db) await initDB();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['spotifyData'], 'readwrite');
        const store = transaction.objectStore('spotifyData');
        const request = store.put({
            id: 'tokens',
            accessToken,
            refreshToken,
            savedAt: Date.now()
        });
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function loadTokens() {
    if (!db) await initDB();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['spotifyData'], 'readonly');
        const store = transaction.objectStore('spotifyData');
        const request = store.get('tokens');
        
        request.onsuccess = () => {
            resolve(request.result || null);
        };
        request.onerror = () => reject(request.error);
    });
}

// Spotify Authentication
function loginWithSpotify() {
    const scopes = 'user-read-recently-played user-read-playback-state user-top-read';
    const authUrl = `https://accounts.spotify.com/authorize?client_id=${SPOTIFY_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}`;
    window.location.href = authUrl;
}

async function handleSpotifyCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    
    if (code) {
        try {
            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + btoa(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET)
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: REDIRECT_URI
                })
            });
            
            const data = await response.json();
            userAccessToken = data.access_token;
            spotifyRefreshToken = data.refresh_token;
            
            await saveTokens(userAccessToken, spotifyRefreshToken);
            
            window.history.replaceState({}, document.title, window.location.pathname);
            
            startAutoSync();
            
            alert('Successfully connected to Spotify! Your listening history will now sync automatically.');
            updateSyncStatus();
            
        } catch (error) {
            console.error('Error exchanging code for token:', error);
            alert('Failed to connect to Spotify. Please try again.');
        }
    }
}

async function refreshAccessToken() {
    if (!spotifyRefreshToken) return false;
    
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + btoa(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET)
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: spotifyRefreshToken
            })
        });
        
        const data = await response.json();
        userAccessToken = data.access_token;
        
        if (data.refresh_token) {
            spotifyRefreshToken = data.refresh_token;
        }
        
        await saveTokens(userAccessToken, spotifyRefreshToken);
        return true;
    } catch (error) {
        console.error('Error refreshing token:', error);
        return false;
    }
}

async function getSpotifyAccessToken() {
    if (spotifyAccessToken) return spotifyAccessToken;
    
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + btoa(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET)
            },
            body: 'grant_type=client_credentials'
        });
        
        const data = await response.json();
        spotifyAccessToken = data.access_token;
        
        setTimeout(() => {
            spotifyAccessToken = null;
        }, data.expires_in * 1000);
        
        return spotifyAccessToken;
    } catch (error) {
        console.error('Error getting Spotify access token:', error);
        return null;
    }
}

// Fetch recently played tracks
async function fetchRecentlyPlayed(limit = 50) {
    if (!userAccessToken) {
        const tokens = await loadTokens();
        if (tokens) {
            userAccessToken = tokens.accessToken;
            spotifyRefreshToken = tokens.refreshToken;
        } else {
            return null;
        }
    }
    
    try {
        const response = await fetch(
            `https://api.spotify.com/v1/me/player/recently-played?limit=${limit}`,
            {
                headers: {
                    'Authorization': `Bearer ${userAccessToken}`
                }
            }
        );
        
        if (response.status === 401) {
            const refreshed = await refreshAccessToken();
            if (refreshed) {
                return fetchRecentlyPlayed(limit);
            }
            return null;
        }
        
        const data = await response.json();
        return data.items || [];
    } catch (error) {
        console.error('Error fetching recently played:', error);
        return null;
    }
}

// Convert Spotify API format to data format
function convertToDataFormat(spotifyTrack) {
    return {
        ts: spotifyTrack.played_at,
        platform: 'Spotify Web Player',
        ms_played: spotifyTrack.track.duration_ms,
        conn_country: 'Unknown',
        master_metadata_track_name: spotifyTrack.track.name,
        master_metadata_album_artist_name: spotifyTrack.track.artists[0]?.name || 'Unknown Artist',
        master_metadata_album_album_name: spotifyTrack.track.album.name,
        spotify_track_uri: spotifyTrack.track.uri,
        reason_start: 'unknown',
        reason_end: 'unknown',
        shuffle: null,
        skipped: null,
        offline: false
    };
}

// Sync new tracks
async function syncNewTracks() {
    console.log('Syncing new tracks...');
    
    const recentTracks = await fetchRecentlyPlayed(50);
    if (!recentTracks || recentTracks.length === 0) {
        console.log('No new tracks to sync');
        return 0;
    }
    
    const newEntries = recentTracks.map(convertToDataFormat);
    
    const existingKeys = new Set(
        allEntries.map(e => `${e.ts}-${e.spotify_track_uri}`)
    );
    
    const uniqueNewEntries = newEntries.filter(entry => {
        const key = `${entry.ts}-${entry.spotify_track_uri}`;
        return !existingKeys.has(key);
    });
    
    if (uniqueNewEntries.length > 0) {
        allEntries.unshift(...uniqueNewEntries);
        
        await saveSpotifyData(allEntries);
        
        console.log(`Added ${uniqueNewEntries.length} new tracks`);
        
        // Only refresh UI if on recent period and not currently rendering
        if ((currentPeriod === 'all' || currentPeriod === 'month') && !isRendering) {
            // Add a small delay to avoid rapid re-renders
            setTimeout(() => {
                filterAndRender();
            }, 1000);
        }
        
        return uniqueNewEntries.length;
    }
    
    console.log('No new unique tracks found');
    return 0;
}

// Auto-sync functionality
function startAutoSync() {
    syncNewTracks();
    
    if (autoSyncInterval) {
        clearInterval(autoSyncInterval);
    }
    
    autoSyncInterval = setInterval(() => {
        syncNewTracks();
    }, 5 * 60 * 1000);
    
    console.log('Auto-sync started (every 5 minutes)');
}

function stopAutoSync() {
    if (autoSyncInterval) {
        clearInterval(autoSyncInterval);
        autoSyncInterval = null;
        console.log('Auto-sync stopped');
    }
}

async function disconnectSpotify() {
    if (confirm('Disconnect from Spotify? This will stop automatic syncing.')) {
        stopAutoSync();
        userAccessToken = null;
        spotifyRefreshToken = null;
        
        if (!db) await initDB();
        const transaction = db.transaction(['spotifyData'], 'readwrite');
        const store = transaction.objectStore('spotifyData');
        await store.delete('tokens');
        
        alert('Disconnected from Spotify');
        updateSyncStatus();
    }
}

function updateSyncStatus() {
    const statusElement = document.getElementById('syncStatus');
    if (statusElement) {
        if (userAccessToken || spotifyRefreshToken) {
            statusElement.innerHTML = `
                <span style="color: #1ed760;">● Connected</span>
                <button onclick="syncNewTracks()" style="margin-left: 10px; background: #282828; border: 1px solid #333; color: #fff; padding: 4px 12px; border-radius: 12px; cursor: pointer; font-size: 0.8rem;">Sync Now</button>
                <button onclick="disconnectSpotify()" style="margin-left: 5px; background: transparent; border: 1px solid #333; color: #999; padding: 4px 12px; border-radius: 12px; cursor: pointer; font-size: 0.8rem;">Disconnect</button>
            `;
        } else {
            statusElement.innerHTML = `
                <span style="color: #999;">Not connected</span>
                <button onclick="loginWithSpotify()" style="margin-left: 10px; background: #1ed760; border: none; color: #000; padding: 4px 12px; border-radius: 12px; cursor: pointer; font-size: 0.8rem; font-weight: 600;">Connect Spotify</button>
            `;
        }
    }
}

// Initialize
(async function() {
    await initDB();
    
    await handleSpotifyCallback();
    
    const tokens = await loadTokens();
    if (tokens) {
        userAccessToken = tokens.accessToken;
        spotifyRefreshToken = tokens.refreshToken;
        startAutoSync();
    }
    
    try {
        const savedEntries = await loadSpotifyData();
        if (savedEntries && savedEntries.length > 0) {
            allEntries = savedEntries;
            allEntries.sort((a, b) => new Date(b.ts) - new Date(a.ts));
            
            document.getElementById('uploadPrompt').style.display = 'none';
            document.getElementById('content').classList.add('active');
            
            filterAndRender();
        }
    } catch (error) {
        console.error('Error loading saved data:', error);
    }
    
    updateSyncStatus();
})();

document.getElementById('fileInput').addEventListener('change', handleFileUpload);

document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentPeriod = btn.dataset.period;
        filterAndRender();
    });
});

// File Upload Handler
async function handleFileUpload(e) {
    const files = e.target.files;
    if (files.length === 0) return;

    document.getElementById('uploadPrompt').innerHTML = '<h2>Loading your data...</h2><p>This may take a moment for large files</p>';

    allEntries = [];

    for (let file of files) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            allEntries.push(...data);
        } catch (error) {
            console.error('Error parsing file:', file.name, error);
        }
    }

    if (allEntries.length > 0) {
        allEntries.sort((a, b) => new Date(b.ts) - new Date(a.ts));
        
        try {
            await saveSpotifyData(allEntries);
            console.log('Data saved successfully!');
        } catch (error) {
            console.error('Error saving data:', error);
            alert('Warning: Could not save your data. You may need to re-upload next time.');
        }
        
        document.getElementById('uploadPrompt').style.display = 'none';
        document.getElementById('content').classList.add('active');
        filterAndRender();
    }
}

// Clear all saved data
async function clearSavedData() {
    if (confirm('Are you sure you want to clear all saved data? You will need to re-upload your files.')) {
        try {
            await clearSpotifyData();
            genreCache = {};
            allEntries = [];
            filteredEntries = [];
            
            // Properly destroy all charts
            Object.keys(charts).forEach(key => {
                if (charts[key]) {
                    charts[key].destroy();
                    charts[key] = null;
                }
            });
            charts = {};
            
            document.getElementById('uploadPrompt').style.display = 'block';
            document.getElementById('content').classList.remove('active');
            
            document.getElementById('uploadPrompt').innerHTML = `
                <h2>Upload Your Spotify Data</h2>
                <p>Select your Spotify extended streaming history JSON files to see your stats</p>
                <button class="upload-btn" onclick="document.getElementById('fileInput').click()">
                    Choose Files
                </button>
            `;
            
            alert('Data cleared successfully!');
        } catch (error) {
            console.error('Error clearing data:', error);
            alert('Error clearing data. Please try again or clear your browser data manually.');
        }
    }
}

// Data Processing Functions
function processData(entries, period) {
    const now = new Date();
    let cutoffDate;

    switch(period) {
        case 'month':
            cutoffDate = new Date(now.setDate(now.getDate() - 28));
            break;
        case '6months':
            cutoffDate = new Date(now.setMonth(now.getMonth() - 6));
            break;
        case 'year':
            cutoffDate = new Date(now.setFullYear(now.getFullYear() - 1));
            break;
        default:
            cutoffDate = new Date(0);
    }

    return entries.filter(e => e.ts && new Date(e.ts) >= cutoffDate);
}

function calculateStats(entries) {
    const totalMs = entries.reduce((sum, e) => sum + (e.ms_played || 0), 0);
    const totalMinutes = Math.round(totalMs / (1000 * 60));
    const totalHours = Math.round(totalMs / (1000 * 60 * 60));
    
    const uniqueTracks = new Set(
        entries.filter(e => e.master_metadata_track_name).map(e => e.master_metadata_track_name)
    ).size;
    
    const uniqueArtists = new Set(
        entries.filter(e => e.master_metadata_album_artist_name).map(e => e.master_metadata_album_artist_name)
    ).size;

    const uniqueAlbums = new Set(
        entries.filter(e => e.master_metadata_album_album_name).map(e => e.master_metadata_album_album_name)
    ).size;

    return { totalMinutes, totalHours, totalStreams: entries.length, uniqueTracks, uniqueArtists, uniqueAlbums };
}

function getHourlyData(entries) {
    const hourlyStreams = new Array(24).fill(0);
    const hourlyMinutes = new Array(24).fill(0);

    entries.forEach(entry => {
        if (entry.ts) {
            const hour = new Date(entry.ts).getHours();
            hourlyStreams[hour]++;
            hourlyMinutes[hour] += (entry.ms_played || 0) / (1000 * 60);
        }
    });

    return { hourlyStreams, hourlyMinutes };
}

function getTopItems(entries) {
    const trackData = {};
    entries.forEach(e => {
        const track = e.master_metadata_track_name;
        const artist = e.master_metadata_album_artist_name;
        const uri = e.spotify_track_uri;
        if (track && artist) {
            const key = JSON.stringify({track, artist});
            if (!trackData[key]) {
                trackData[key] = { minutes: 0, plays: 0, track, artist, uri };
            }
            trackData[key].minutes += (e.ms_played || 0) / (1000 * 60);
            trackData[key].plays += 1;
            if (uri && !trackData[key].uri) trackData[key].uri = uri;
        }
    });

    const artistData = {};
    entries.forEach(e => {
        const artist = e.master_metadata_album_artist_name;
        const trackUri = e.spotify_track_uri;
        if (artist) {
            if (!artistData[artist]) {
                artistData[artist] = { minutes: 0, plays: 0, trackUri: null };
            }
            artistData[artist].minutes += (e.ms_played || 0) / (1000 * 60);
            artistData[artist].plays += 1;
            if (trackUri && !artistData[artist].trackUri) {
                artistData[artist].trackUri = trackUri;
            }
        }
    });

    const albumData = {};
    entries.forEach(e => {
        const album = e.master_metadata_album_album_name;
        const artist = e.master_metadata_album_artist_name;
        const uri = e.spotify_track_uri;
        if (album && artist) {
            const key = JSON.stringify({album, artist});
            if (!albumData[key]) {
                albumData[key] = { minutes: 0, plays: 0, album, artist, uri };
            }
            albumData[key].minutes += (e.ms_played || 0) / (1000 * 60);
            albumData[key].plays += 1;
            if (uri && !albumData[key].uri) albumData[key].uri = uri;
        }
    });

    return {
        topTracks: Object.values(trackData).sort((a, b) => b.minutes - a.minutes).slice(0, 20),
        topArtists: Object.entries(artistData).map(([name, data]) => ({name, ...data})).sort((a, b) => b.minutes - a.minutes).slice(0, 20),
        topAlbums: Object.values(albumData).sort((a, b) => b.minutes - a.minutes).slice(0, 20)
    };
}

function getRecentStreams(entries) {
    return entries.slice(0, 50);
}

// Extract genres from Spotify API
async function extractGenres(entries) {
    const cacheKey = `genres_${currentPeriod}`;
    if (genreCache[cacheKey]) {
        return genreCache[cacheKey];
    }

    try {
        const token = await getSpotifyAccessToken();
        if (!token) {
            console.log('No Spotify token, skipping genres');
            return [];
        }
        
        const artistData = {};
        entries.forEach(e => {
            const artist = e.master_metadata_album_artist_name;
            if (artist) {
                artistData[artist] = (artistData[artist] || 0) + 1;
            }
        });
        
        const topArtists = Object.entries(artistData)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 50)
            .map(([name]) => name);
        
        const genreCounts = {};
        let processedCount = 0;
        
        for (const artistName of topArtists) {
            try {
                const searchResponse = await fetch(
                    `https://api.spotify.com/v1/search?q=${encodeURIComponent(artistName)}&type=artist&limit=1`,
                    {
                        headers: {
                            'Authorization': `Bearer ${token}`
                        }
                    }
                );
                
                const searchData = await searchResponse.json();
                
                if (searchData.artists?.items?.[0]) {
                    const artist = searchData.artists.items[0];
                    const genres = artist.genres || [];
                    
                    const weight = artistData[artistName];
                    genres.forEach(genre => {
                        genreCounts[genre] = (genreCounts[genre] || 0) + weight;
                    });
                }
                
                processedCount++;
                
                const genreContainer = document.getElementById('genreTags');
                if (genreContainer) {
                    genreContainer.innerHTML = `<div style="color: #666;">Loading genres... ${processedCount}/${topArtists.length}</div>`;
                }
                
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                console.error(`Error fetching genres for ${artistName}:`, error);
            }
        }
        
        const topGenres = Object.entries(genreCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 13)
            .map(([genre]) => genre);
        
        genreCache[cacheKey] = topGenres;
        
        return topGenres;
            
    } catch (error) {
        console.error('Error extracting genres:', error);
        return [];
    }
}

// Render Functions
async function filterAndRender() {
    if (isRendering) {
        console.log('Already rendering, skipping...');
        return;
    }
    
    isRendering = true;
    
    try {
        filteredEntries = processData(allEntries, currentPeriod);
        
        const periodText = getPeriodText(currentPeriod);
        document.querySelectorAll('#genrePeriod, #trackPeriod, #artistPeriod, #albumPeriod, #clockPeriod').forEach(el => {
            el.textContent = periodText;
        });
        
        updateStats(calculateStats(filteredEntries));
        createTopItems(getTopItems(filteredEntries));
        createListeningClocks(getHourlyData(filteredEntries));
        createRecentStreams(getRecentStreams(filteredEntries));
        
        const genreContainer = document.getElementById('genreTags');
        if (genreContainer) {
            genreContainer.innerHTML = '<div style="color: #666;">Loading genres...</div>';
        }
        
        const genres = await extractGenres(filteredEntries);
        createGenreTags(genres);
    } finally {
        isRendering = false;
    }
}
function getPeriodText(period) {
    switch(period) {
        case 'month': return '4 weeks';
        case '6months': return '6 months';
        case 'year': return 'year';
        default: return 'lifetime';
    }
}

// Spotify API Functions
async function getSpotifyImageFromUri(uri, type = 'track') {
    if (!uri) return null;
    
    const cacheKey = uri;
    if (imageCache[cacheKey]) {
        return imageCache[cacheKey];
    }
    
    try {
        const cachedUrl = await getImageFromDB(uri);
        if (cachedUrl) {
            imageCache[cacheKey] = cachedUrl;
            return cachedUrl;
        }
    } catch (error) {
        console.error('Error reading from IndexedDB:', error);
    }
    
    try {
        const id = uri.split(':')[2];
        if (!id) return null;
        
        const embedUrl = `https://open.spotify.com/oembed?url=spotify:${type}:${id}`;
        const response = await fetch(embedUrl);
        const data = await response.json();
        const imageUrl = data.thumbnail_url;
        
        if (imageUrl) {
            imageCache[cacheKey] = imageUrl;
            try {
                await saveImageToDB(uri, imageUrl);
            } catch (error) {
                console.error('Error saving to IndexedDB:', error);
            }
        }
        
        return imageUrl;
    } catch (error) {
        console.error('Error fetching Spotify image:', error);
        return null;
    }
}

function updateStats(stats) {
    document.getElementById('totalMinutes').textContent = stats.totalMinutes.toLocaleString();
    document.getElementById('totalHours').textContent = stats.totalHours.toLocaleString();
    document.getElementById('totalStreams').textContent = stats.totalStreams.toLocaleString();
    document.getElementById('uniqueArtists').textContent = stats.uniqueArtists.toLocaleString();
    document.getElementById('uniqueTracks').textContent = stats.uniqueTracks.toLocaleString();
    document.getElementById('uniqueAlbums').textContent = stats.uniqueAlbums.toLocaleString();
}

function createGenreTags(genres) {
    const container = document.getElementById('genreTags');
    if (genres.length === 0) {
        container.innerHTML = '<div style="color: #666;">No genres found</div>';
        return;
    }
    container.innerHTML = genres.map(genre => 
        `<div class="genre-tag">${genre}</div>`
    ).join('');
}

function createTopItems(topData) {
    const tracksContainer = document.getElementById('topTracksCarousel');
    tracksContainer.innerHTML = topData.topTracks.map((item, i) => `
        <div class="carousel-item">
            <div class="item-cover" data-uri="${item.uri || ''}" data-type="track"></div>
            <div class="item-title">${i + 1}. ${item.track}</div>
            <div class="item-subtitle">${item.artist}</div>
            <div class="item-stats">${Math.round(item.minutes)} minutes • ${item.plays} streams</div>
        </div>
    `).join('');

    const artistsContainer = document.getElementById('topArtistsCarousel');
    artistsContainer.innerHTML = topData.topArtists.map((item, i) => `
        <div class="carousel-item">
            <div class="item-cover" data-uri="${item.trackUri || ''}" data-type="track"></div>
            <div class="item-title">${i + 1}. ${item.name}</div>
            <div class="item-stats">${Math.round(item.minutes)} minutes • ${item.plays} streams</div>
        </div>
    `).join('');

    const albumsContainer = document.getElementById('topAlbumsCarousel');
    albumsContainer.innerHTML = topData.topAlbums.map((item, i) => `
        <div class="carousel-item">
            <div class="item-cover" data-uri="${item.uri || ''}" data-type="track"></div>
            <div class="item-title">${i + 1}. ${item.album}</div>
            <div class="item-subtitle">${item.artist}</div>
            <div class="item-stats">${Math.round(item.minutes)} minutes • ${item.plays} streams</div>
        </div>
    `).join('');
    
    loadImages();
}

async function loadImages() {
    const imageElements = document.querySelectorAll('.item-cover[data-uri], .stream-cover[data-uri]');
    
    for (const element of imageElements) {
        const uri = element.dataset.uri;
        const type = element.dataset.type;
        
        if (!uri) continue;
        
        const imageUrl = await getSpotifyImageFromUri(uri, type);
        
        if (imageUrl) {
            element.style.backgroundImage = `url(${imageUrl})`;
        }
    }
}

function createListeningClocks(hourlyData) {
    const createClockChart = (canvasId, data, label) => {
        const canvas = document.getElementById(canvasId);
        if (!canvas) {
            console.error(`Canvas ${canvasId} not found`);
            return;
        }
        
        // Properly destroy existing chart
        if (charts[canvasId]) {
            if (typeof charts[canvasId].destroy === 'function') {
                charts[canvasId].destroy();
            }
            charts[canvasId] = null;
        }
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            console.error(`Could not get context for ${canvasId}`);
            return;
        }
        
        // Check if data has valid numbers
        const hasValidData = data.some(d => d > 0 && isFinite(d));
        if (!hasValidData) {
            console.log(`No valid data for ${canvasId}`);
            // Draw empty clock
            drawEmptyClock(canvas, ctx);
            return;
        }

        // Get parent width for responsive sizing
        const parentWidth = canvas.parentElement.clientWidth;
        const size = Math.min(parentWidth, 500);
        
        // Set canvas size with device pixel ratio for sharp rendering
        const dpr = window.devicePixelRatio || 1;
        canvas.width = size * dpr;
        canvas.height = size * dpr;
        canvas.style.width = size + 'px';
        canvas.style.height = size + 'px';
        ctx.scale(dpr, dpr);
        
        const centerX = size / 2;
        const centerY = size / 2;
        const maxRadius = size * 0.35;
        const innerRadius = size * 0.05;
        
        // Find max value for scaling
        const maxValue = Math.max(...data);
        
        // Draw the clock
        ctx.clearRect(0, 0, size, size);
        
        // Draw each hour segment
        for (let i = 0; i < 24; i++) {
            const angle = (i * 15 - 90) * Math.PI / 180;
            const nextAngle = ((i + 1) * 15 - 90) * Math.PI / 180;
            
            // Calculate radius based on data value
            const normalizedValue = maxValue > 0 ? data[i] / maxValue : 0;
            const radius = innerRadius + (maxRadius * normalizedValue);
            
            // Draw the segment
            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.arc(centerX, centerY, radius, angle, nextAngle);
            ctx.lineTo(centerX, centerY);
            
            // Fill with color based on intensity
            const intensity = 0.3 + normalizedValue * 0.7;
            ctx.fillStyle = `rgba(30, 215, 96, ${intensity})`;
            ctx.fill();
            
            // Draw the radial line
            const lineEndX = centerX + Math.cos(angle) * (maxRadius + 15);
            const lineEndY = centerY + Math.sin(angle) * (maxRadius + 15);
            
            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.lineTo(lineEndX, lineEndY);
            ctx.strokeStyle = '#282828';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        
        // Draw hour labels
        ctx.fillStyle = '#666';
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        const labelRadius = maxRadius + 30;
        
        const keyHours = [0, 6, 12, 18]; // Show only 12AM, 6AM, 12PM, 6PM
        
        for (let i of keyHours) {
            const angle = (i * 15 - 90) * Math.PI / 180;
            const x = centerX + Math.cos(angle) * labelRadius;
            const y = centerY + Math.sin(angle) * labelRadius;
            
            let labelText;
            if (i === 0) labelText = '12AM';
            else if (i === 12) labelText = '12PM';
            else if (i < 12) labelText = `${i}AM`;
            else labelText = `${i - 12}PM`;
            
            ctx.fillText(labelText, x, y);
        }
        
        // Store canvas reference and cleanup function
        charts[canvasId] = {
            canvas: canvas,
            data: data,
            label: label,
            destroy: function() {
                if (this.canvas && this.canvas.parentElement) {
                    const tooltip = this.canvas.parentElement.querySelector('.clock-tooltip');
                    if (tooltip) tooltip.remove();
                }
                const ctx = this.canvas.getContext('2d');
                if (ctx) {
                    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                }
            }
        };
        
        // Add hover tooltip
        addClockTooltip(canvas, data, label, centerX, centerY, innerRadius, maxRadius);
    };
    
    function drawEmptyClock(canvas, ctx) {
        const parentWidth = canvas.parentElement.clientWidth;
        const size = Math.min(parentWidth, 500);
        
        const dpr = window.devicePixelRatio || 1;
        canvas.width = size * dpr;
        canvas.height = size * dpr;
        canvas.style.width = size + 'px';
        canvas.style.height = size + 'px';
        ctx.scale(dpr, dpr);
        
        const centerX = size / 2;
        const centerY = size / 2;
        const maxRadius = size * 0.35;
        
        ctx.clearRect(0, 0, size, size);
        
        // Draw placeholder text
        ctx.fillStyle = '#666';
        ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No data available', centerX, centerY);
    }
    
    function addClockTooltip(canvas, data, label, centerX, centerY, innerRadius, maxRadius) {
        // Remove existing tooltip if any
        const existingTooltip = canvas.parentElement.querySelector('.clock-tooltip');
        if (existingTooltip) existingTooltip.remove();
        
        const tooltip = document.createElement('div');
        tooltip.className = 'clock-tooltip';
        tooltip.style.cssText = `
            position: absolute;
            background: #1a1a1a;
            color: #fff;
            padding: 8px 12px;
            border-radius: 6px;
            border: 1px solid #282828;
            font-size: 0.85rem;
            pointer-events: none;
            display: none;
            z-index: 1000;
            white-space: nowrap;
        `;
        canvas.parentElement.style.position = 'relative';
        canvas.parentElement.appendChild(tooltip);
        
        function handleMouseMove(e) {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            // Convert to canvas coordinates
            const canvasX = (x / rect.width) * canvas.style.width.replace('px', '');
            const canvasY = (y / rect.height) * canvas.style.height.replace('px', '');
            
            const dx = canvasX - centerX;
            const dy = canvasY - centerY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (distance > innerRadius && distance < maxRadius + 20) {
                let angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
                if (angle < 0) angle += 360;
                
                const hour = Math.floor(angle / 15) % 24;
                const value = data[hour];
                
                let hourLabel;
                if (hour === 0) hourLabel = '12AM';
                else if (hour === 12) hourLabel = '12PM';
                else if (hour < 12) hourLabel = `${hour}AM`;
                else hourLabel = `${hour - 12}PM`;
                
                tooltip.textContent = `${hourLabel}: ${Math.round(value)} ${label}`;
                tooltip.style.display = 'block';
                tooltip.style.left = `${x + 10}px`;
                tooltip.style.top = `${y - 30}px`;
            } else {
                tooltip.style.display = 'none';
            }
        }
        
        canvas.addEventListener('mousemove', handleMouseMove);
        canvas.addEventListener('mouseleave', () => {
            tooltip.style.display = 'none';
        });
    }

    createClockChart('streamsClock', hourlyData.hourlyStreams, 'streams');
    createClockChart('minutesClock', hourlyData.hourlyMinutes, 'minutes');
}

function createRecentStreams(streams) {
    const container = document.getElementById('recentStreams');
    
    const groupedByDate = {};
    streams.forEach(stream => {
        if (!stream.ts) return;
        const date = new Date(stream.ts);
        const dateStr = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        if (!groupedByDate[dateStr]) {
            groupedByDate[dateStr] = [];
        }
        groupedByDate[dateStr].push(stream);
    });

    container.innerHTML = Object.entries(groupedByDate).map(([date, dateStreams]) => `
        <div class="stream-date">${date}</div>
        ${dateStreams.map(stream => {
            const timeAgo = getTimeAgo(new Date(stream.ts));
            return `
                <div class="stream-item">
                    <div class="stream-cover" data-uri="${stream.spotify_track_uri || ''}" data-type="track"></div>
                    <div class="stream-info">
                        <div class="stream-title">${stream.master_metadata_track_name || 'Unknown Track'}</div>
                        <div class="stream-artist">${stream.master_metadata_album_artist_name || 'Unknown Artist'} • ${stream.master_metadata_album_album_name || 'Unknown Album'}</div>
                    </div>
                    <div class="stream-time">${timeAgo}</div>
                </div>
            `;
        }).join('')}
    `).join('');
    
    loadImages();
}

// Gallery toggle functionality
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('control-btn') && e.target.textContent === '⊞') {
        const section = e.target.closest('.section');
        const carousel = section.querySelector('.items-carousel');
        
        if (carousel) {
            carousel.classList.toggle('gallery-view');
            e.target.classList.toggle('active');
        }
    }
});

// Carousel scroll controls
document.addEventListener('click', (e) => {
    const btn = e.target;
    
    if (btn.classList.contains('control-btn')) {
        const section = btn.closest('.section');
        const carousel = section.querySelector('.items-carousel');
        
        if (!carousel || carousel.classList.contains('gallery-view')) return;
        
        if (btn.textContent === '‹') {
            carousel.scrollBy({ left: -300, behavior: 'smooth' });
        } else if (btn.textContent === '›') {
            carousel.scrollBy({ left: 300, behavior: 'smooth' });
        }
    }
});

function getTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
}