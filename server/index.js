// Loads variables from .env (like PORT) into process.env
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();

// Wrap the Express app in a plain HTTP server so Socket.io can attach to it
const server = http.createServer(app);

// Socket.io piggybacks on the same HTTP server (and port) as Express
const io = new Server(server);

// Serve everything in /public directly (e.g. /host.html, /player.html)
app.use(express.static(path.join(__dirname, '..', 'public')));

// In-memory room store: roomCode -> { players: Map<socketId, nickname> }
// Everything resets if the server restarts - that's fine for now.
const rooms = new Map();

function generateRoomCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// Turns a room's player Map into a plain array for sending over the socket
function getPlayerList(room) {
  return Array.from(room.players.entries()).map(([id, nickname]) => ({ id, nickname }));
}

// Builds the Basic auth header Spotify wants for token requests
function spotifyBasicAuthHeader() {
  const credentials = `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`;
  return 'Basic ' + Buffer.from(credentials).toString('base64');
}

// Pulls the playlist ID out of either a share link or a spotify:playlist:... URI
function extractPlaylistId(input) {
  const trimmed = (input || '').trim();

  const uriMatch = trimmed.match(/^spotify:playlist:([a-zA-Z0-9]+)/);
  if (uriMatch) return uriMatch[1];

  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split('/').filter(Boolean);
    const index = parts.indexOf('playlist');
    if (index !== -1 && parts[index + 1]) return parts[index + 1];
  } catch (err) {
    // Not a valid URL - fall through to returning null
  }

  return null;
}

// Returns a room's current access token, refreshing it first if it has expired
async function getValidAccessToken(room) {
  const { accessToken, refreshToken, expiresAt } = room.spotify;

  // Refresh a bit early (60s buffer) so we don't get caught mid-request
  if (Date.now() < expiresAt - 60 * 1000) {
    return accessToken;
  }

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: spotifyBasicAuthHeader() } }
  );

  room.spotify.accessToken = response.data.access_token;
  room.spotify.expiresAt = Date.now() + response.data.expires_in * 1000;
  if (response.data.refresh_token) {
    room.spotify.refreshToken = response.data.refresh_token;
  }

  return room.spotify.accessToken;
}

// Fetches every track in a playlist, following Spotify's pagination until it's done
async function fetchAllPlaylistTracks(playlistId, accessToken) {
  const songs = [];
  // Spotify retired GET /playlists/{id}/tracks (returns 403 as of their March 2026
  // migration) in favor of /items, which also renames each entry's "track" to "item".
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;

  while (url) {
    const response = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    for (const item of response.data.items) {
      const track = item.item;
      if (!track || !track.uri) continue; // skip removed/local tracks

      songs.push({
        name: track.name,
        artists: track.artists.map((artist) => artist.name).join(', '),
        year: track.album && track.album.release_date ? track.album.release_date.slice(0, 4) : null,
        uri: track.uri,
        played: false,
      });
    }

    url = response.data.next; // Spotify gives us the next page's URL directly, or null when done
  }

  return songs;
}

// Fisher-Yates shuffle - returns a new shuffled array, doesn't mutate the input
function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-modify-playback-state',
  'user-read-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

// Sends the host's browser to Spotify's login page, with the room code tucked into "state"
app.get('/login', (req, res) => {
  const roomCode = req.query.room;

  if (!roomCode || !rooms.has(roomCode)) {
    return res.redirect('/host.html?spotify=error');
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPES,
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    state: roomCode,
    // Forces Spotify to always show the consent screen instead of silently
    // reusing a previous authorization, which can otherwise carry stale scopes.
    show_dialog: 'true',
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

// Spotify redirects here after login. We trade the code for tokens and stash them on the room.
app.get('/callback', async (req, res) => {
  const { code, state: roomCode, error } = req.query;

  if (error || !code || !roomCode || !rooms.has(roomCode)) {
    return res.redirect(`/host.html?spotify=error${roomCode ? `&room=${roomCode}` : ''}`);
  }

  try {
    const tokenResponse = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: spotifyBasicAuthHeader() } }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const room = rooms.get(roomCode);
    room.spotify = {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
    };

    res.redirect(`/host.html?room=${roomCode}&spotify=connected`);
  } catch (err) {
    console.error('Spotify token exchange failed:', err.response ? err.response.data : err.message);
    res.redirect(`/host.html?room=${roomCode}&spotify=error`);
  }
});

// Called by the Web Playback SDK whenever it needs an access token. Refreshes
// automatically via getValidAccessToken if the stored one has expired.
app.get('/token', async (req, res) => {
  const room = rooms.get(req.query.room);

  if (!room || !room.spotify) {
    return res.status(400).json({ error: 'Room not found or Spotify not connected.' });
  }

  try {
    const accessToken = await getValidAccessToken(room);
    res.json({ accessToken });
  } catch (err) {
    console.error('Failed to get access token:', err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Failed to get access token.' });
  }
});

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('createRoom', (callback) => {
    const code = generateRoomCode();
    rooms.set(code, { players: new Map(), spotify: null, songPool: [] });

    socket.join(code);
    socket.data.roomCode = code;

    callback({ code });
  });

  // The host's page fully reloads after the Spotify redirect, which means a brand-new
  // socket connection. This puts that new socket back into the room's Socket.io channel
  // so the host keeps receiving live playerListUpdate broadcasts.
  socket.on('hostRejoin', (roomCode, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    callback({ players: getPlayerList(room) });
  });

  socket.on('loadPlaylist', async ({ roomCode, playlistUrl }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    if (!room.spotify) {
      callback({ error: 'Connect Spotify before loading a playlist.' });
      return;
    }

    const playlistId = extractPlaylistId(playlistUrl);
    if (!playlistId) {
      callback({ error: "Couldn't read that playlist link." });
      return;
    }

    try {
      const accessToken = await getValidAccessToken(room);
      const songs = await fetchAllPlaylistTracks(playlistId, accessToken);
      room.songPool = shuffle(songs);
      callback({ count: room.songPool.length });
    } catch (err) {
      console.error('Failed to load playlist:', err.response ? err.response.data : err.message);

      if (err.response && err.response.status === 403) {
        callback({ error: "This playlist isn't accessible — try one you own, or a copy of it." });
      } else {
        callback({ error: 'Failed to load playlist from Spotify.' });
      }
    }
  });

  // Picks a random song the room hasn't played yet, marks it played, and hands
  // back only the URI - the name/artist stay server-side until reveal is built.
  socket.on('playRandomSong', ({ roomCode }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    const unplayed = room.songPool.filter((song) => !song.played);
    if (unplayed.length === 0) {
      callback({ error: 'No songs left in the pool.' });
      return;
    }

    const song = unplayed[Math.floor(Math.random() * unplayed.length)];
    song.played = true;

    callback({ uri: song.uri });
  });

  socket.on('joinRoom', ({ code, nickname }, callback) => {
    const roomCode = (code || '').trim().toUpperCase();
    const trimmedNickname = (nickname || '').trim();

    if (!trimmedNickname) {
      callback({ error: 'Nickname is required.' });
      return;
    }

    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found. Check the code and try again.' });
      return;
    }

    room.players.set(socket.id, trimmedNickname);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    io.to(roomCode).emit('playerListUpdate', getPlayerList(room));
    callback({ success: true, code: roomCode });
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);

    const roomCode = socket.data.roomCode;
    const room = roomCode && rooms.get(roomCode);

    if (room && room.players.has(socket.id)) {
      room.players.delete(socket.id);
      io.to(roomCode).emit('playerListUpdate', getPlayerList(room));
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
