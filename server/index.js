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

// A guess index is correct if inserting the new song there wouldn't break
// chronological order - ties with a neighboring card's year are allowed on
// either side, since the timeline can't distinguish same-year ordering.
function isValidGuess(timeline, year, guessIndex) {
  const songYear = Number(year);
  const before = timeline[guessIndex - 1];
  const after = timeline[guessIndex];

  const beforeOk = !before || Number(before.year) <= songYear;
  const afterOk = !after || songYear <= Number(after.year);

  return beforeOk && afterOk;
}

const DEFAULT_WIN_LENGTH = 10;
const ALLOWED_WIN_LENGTHS = [3, 5, 8, 10];

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
    rooms.set(code, {
      players: new Map(),
      spotify: null,
      songPool: [],
      hostId: socket.id,
      game: { currentSong: null, timelines: new Map(), guesses: new Map(), winners: [], winLength: DEFAULT_WIN_LENGTH },
    });

    socket.join(code);
    socket.data.roomCode = code;

    callback({ code });
  });

  // Host-only: how many songs a player needs on their timeline to win. Kept
  // to a fixed set of options so testers can shorten games without breaking
  // the scoring math in unexpected ways.
  socket.on('setWinLength', ({ roomCode, winLength }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    if (socket.id !== room.hostId) {
      callback({ error: 'Only the host can change the win length.' });
      return;
    }

    if (!ALLOWED_WIN_LENGTHS.includes(Number(winLength))) {
      callback({ error: `Win length must be one of: ${ALLOWED_WIN_LENGTHS.join(', ')}.` });
      return;
    }

    room.game.winLength = Number(winLength);
    io.to(roomCode).emit('winLengthUpdated', { winLength: room.game.winLength });
    callback({ success: true });
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
    room.hostId = socket.id;

    callback({ players: getPlayerList(room), winLength: room.game.winLength });
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

      // Stack onto the existing pool rather than replacing it, skipping any
      // track already in the bank (e.g. the same playlist loaded twice).
      const existingUris = new Set(room.songPool.map((song) => song.uri));
      const newSongs = songs.filter((song) => !existingUris.has(song.uri));
      room.songPool = shuffle([...room.songPool, ...newSongs]);

      callback({ count: room.songPool.length, added: newSongs.length });
    } catch (err) {
      console.error('Failed to load playlist:', err.response ? err.response.data : err.message);

      if (err.response && err.response.status === 403) {
        callback({ error: "This playlist isn't accessible — try one you own, or a copy of it." });
      } else {
        callback({ error: 'Failed to load playlist from Spotify.' });
      }
    }
  });

  // Host-only: wipes the room's entire song bank, e.g. to start a fresh set
  // of playlists mid-game. Doesn't touch players, timelines, or scores.
  socket.on('clearPlaylist', ({ roomCode }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    if (socket.id !== room.hostId) {
      callback({ error: 'Only the host can clear the playlist.' });
      return;
    }

    room.songPool = [];
    callback({ success: true });
  });

  // Picks a random song the room hasn't played yet, marks it played, and hands
  // back only the URI - the name/artist stay server-side until reveal is built.
  socket.on('playRandomSong', ({ roomCode }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    if (socket.id !== room.hostId) {
      callback({ error: 'Only the host can play a song.' });
      return;
    }

    if (room.game.winners.length > 0) {
      callback({ error: `Game already won by ${room.game.winners.join(' & ')}. Start a new game to keep playing.` });
      return;
    }

    // Guards against a double-click (or a second tab) starting a second round
    // before the first is revealed - without this, two overlapping playback
    // requests can race, and whichever reaches Spotify last is what actually
    // plays while the server keeps scoring against the other one.
    if (room.game.currentSong) {
      callback({ error: 'A song is already playing - reveal it before playing another.' });
      return;
    }

    // Songs without a release year can't be placed on a timeline, so skip them.
    const unplayed = room.songPool.filter((song) => !song.played && song.year);
    if (unplayed.length === 0) {
      callback({ error: 'No songs left in the pool.' });
      return;
    }

    const song = unplayed[Math.floor(Math.random() * unplayed.length)];
    song.played = true;

    room.game.currentSong = song;
    room.game.guesses = new Map();

    callback({ uri: song.uri });
    io.to(roomCode).emit('roundStarted');
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

    // If this socket already joined a different room, leave it cleanly first -
    // otherwise it'd stay listed there as a ghost player forever.
    const previousRoomCode = socket.data.roomCode;
    if (previousRoomCode && previousRoomCode !== roomCode) {
      const previousRoom = rooms.get(previousRoomCode);
      if (previousRoom && previousRoom.players.has(socket.id)) {
        previousRoom.players.delete(socket.id);
        previousRoom.game.timelines.delete(socket.id);
        previousRoom.game.guesses.delete(socket.id);
        socket.leave(previousRoomCode);
        io.to(previousRoomCode).emit('playerListUpdate', getPlayerList(previousRoom));
      }
    }

    room.players.set(socket.id, trimmedNickname);
    room.game.timelines.set(socket.id, []);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    io.to(roomCode).emit('playerListUpdate', getPlayerList(room));
    callback({ success: true, code: roomCode, timeline: [] });
  });

  // A player locks in where they think the currently-playing song belongs on
  // their own timeline. `position` is an insertion index into that timeline.
  socket.on('submitGuess', ({ roomCode, position }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    if (!room.players.has(socket.id)) {
      callback({ error: 'Only players can guess.' });
      return;
    }

    if (!room.game.currentSong) {
      callback({ error: 'No song is currently playing.' });
      return;
    }

    if (room.game.guesses.has(socket.id)) {
      callback({ error: 'You already guessed this round.' });
      return;
    }

    const timeline = room.game.timelines.get(socket.id) || [];
    const clamped = Math.max(0, Math.min(Number(position), timeline.length));
    room.game.guesses.set(socket.id, clamped);

    if (room.hostId) {
      io.to(room.hostId).emit('guessProgress', {
        guessedCount: room.game.guesses.size,
        totalPlayers: room.players.size,
      });
    }

    callback({ success: true });
  });

  // Host-triggered: scores every player's guess against the actual song, grows
  // each correct player's timeline, and broadcasts the outcome to the room.
  socket.on('revealSong', ({ roomCode }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    if (socket.id !== room.hostId) {
      callback({ error: 'Only the host can reveal.' });
      return;
    }

    const song = room.game.currentSong;
    if (!song) {
      callback({ error: 'No song is currently playing.' });
      return;
    }

    const results = [];
    const winners = [];
    for (const [playerId, nickname] of room.players.entries()) {
      const timeline = room.game.timelines.get(playerId) || [];
      const guess = room.game.guesses.has(playerId) ? room.game.guesses.get(playerId) : null;
      const correct = guess !== null && isValidGuess(timeline, song.year, guess);

      if (correct) {
        const updatedTimeline = [...timeline];
        updatedTimeline.splice(guess, 0, { name: song.name, artists: song.artists, year: song.year });
        room.game.timelines.set(playerId, updatedTimeline);

        // Everyone who crosses the line in the same round wins together - no
        // "first past the post" tiebreak among simultaneous winners.
        if (updatedTimeline.length >= room.game.winLength) {
          winners.push(nickname);
        }
      }

      results.push({
        playerId,
        nickname,
        guess,
        correct,
        timeline: room.game.timelines.get(playerId) || [],
      });
    }

    room.game.currentSong = null;
    room.game.guesses = new Map();
    if (winners.length > 0) room.game.winners = winners;

    io.to(roomCode).emit('roundResult', {
      song: { name: song.name, artists: song.artists, year: song.year },
      results,
      winners,
    });

    callback({ success: true });
  });

  // Host-only: resets scores/timelines and re-opens the whole song bank so the
  // same room can play another game without redoing Spotify login or playlists.
  socket.on('startNewGame', ({ roomCode }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    if (socket.id !== room.hostId) {
      callback({ error: 'Only the host can start a new game.' });
      return;
    }

    room.songPool.forEach((song) => {
      song.played = false;
    });

    room.game.currentSong = null;
    room.game.guesses = new Map();
    room.game.winners = [];

    const freshTimelines = new Map();
    for (const playerId of room.players.keys()) {
      freshTimelines.set(playerId, []);
    }
    room.game.timelines = freshTimelines;

    io.to(roomCode).emit('newGameStarted');
    callback({ success: true });
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
