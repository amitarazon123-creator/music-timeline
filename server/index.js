// Loads variables from .env (like PORT) into process.env
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
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
  return Array.from(room.players.entries()).map(([id, nickname]) => ({
    id,
    nickname,
    tokens: room.game.tokens.get(id) || 0,
    connected: room.playerSockets.has(id),
  }));
}

// Snapshot of the live round (if any) from one player's point of view, sent
// back on rejoin so their screen can jump straight to the right section
// instead of waiting for the next broadcast. Mirrors the payloads of
// 'roundStarted' / 'stealWindowOpened' since those are the events a
// still-connected player would already have seen.
function buildRoundSnapshot(room, playerId) {
  if (!room.game.currentSong || room.game.phase === 'waiting') {
    return { phase: 'waiting' };
  }

  const activePlayerId = room.game.activePlayerId;
  const activeNickname = room.players.get(activePlayerId) || 'Unknown';
  const isActive = playerId === activePlayerId;

  if (room.game.phase === 'primary') {
    return { phase: 'primary', activePlayerId, activeNickname, isActive };
  }

  // phase === 'steal'
  if (isActive) {
    return { phase: 'steal', activePlayerId, activeNickname, isActive };
  }

  const activeTimeline = room.game.timelines.get(activePlayerId) || [];
  const activeGuess = room.game.guesses.has(activePlayerId) ? room.game.guesses.get(activePlayerId) : null;
  const stealOptions = computeStealOptions(activeTimeline, activeGuess);
  const alreadyDecided = !room.game.pendingDecisions.has(playerId);

  return {
    phase: 'steal',
    activePlayerId,
    activeNickname,
    isActive,
    activeTimeline,
    stealOptions,
    alreadyDecided,
    tokens: room.game.tokens.get(playerId) || 0,
  };
}

// Same idea as buildRoundSnapshot, but for the host's omniscient view - sent
// back on hostRejoin so a host who refreshes mid-round doesn't strand
// themselves without the Reveal button (which otherwise only reappears on
// the next live 'stealProgress' broadcast, which may never come if every
// decision was already in before they reloaded).
function buildHostRoundSnapshot(room) {
  if (!room.game.currentSong || room.game.phase === 'waiting') {
    return { phase: 'waiting' };
  }

  const activeNickname = room.players.get(room.game.activePlayerId) || 'Unknown';

  if (room.game.phase === 'primary') {
    return { phase: 'primary', activeNickname };
  }

  const total = room.game.stealDecisionTotal;
  const decided = total - room.game.pendingDecisions.size;
  return { phase: 'steal', activeNickname, decided, total, complete: room.game.pendingDecisions.size === 0 };
}

// Opens the steal window right after the active player locks in their bet -
// everyone else gets one shot to decide (steal or pass) before anything is
// revealed. Also used as a safety valve if the active player disconnects
// mid-turn, so the round can't get stuck waiting on someone who's gone.
function openStealWindow(room, roomCode) {
  room.game.phase = 'steal';
  room.game.stealAttempts = new Map();

  const activeTimeline = room.game.timelines.get(room.game.activePlayerId) || [];
  const activeGuess = room.game.guesses.has(room.game.activePlayerId)
    ? room.game.guesses.get(room.game.activePlayerId)
    : null;
  const stealOptions = computeStealOptions(activeTimeline, activeGuess); // [{ index, label }]
  room.game.stealOptions = stealOptions.map((option) => option.index); // plain indices, for validation

  room.game.pendingDecisions = new Set(
    // Nothing left to bet on (the active player's guess covers the whole
    // timeline) - skip requiring a pointless explicit pass from anyone.
    stealOptions.length === 0 ? [] : Array.from(room.players.keys()).filter((id) => id !== room.game.activePlayerId)
  );
  room.game.stealDecisionTotal = room.game.pendingDecisions.size;

  io.to(roomCode).emit('stealWindowOpened', {
    activePlayerId: room.game.activePlayerId,
    activeNickname: room.players.get(room.game.activePlayerId) || 'Unknown',
    activeTimeline,
    stealOptions,
  });
  emitStealProgress(room, roomCode);
}

function emitStealProgress(room, roomCode) {
  const total = room.game.stealDecisionTotal;
  const decided = total - room.game.pendingDecisions.size;
  io.to(roomCode).emit('stealProgress', { decided, total, complete: room.game.pendingDecisions.size === 0 });
}

// Removes a player identity from a room entirely - used when a socket is
// abandoning it outright (e.g. joining a different room), as opposed to a
// disconnect, which keeps the player's spot around for rejoinRoom.
function removePlayer(room, roomCode, playerId) {
  const pendingTimer = room.disconnectTimers.get(playerId);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    room.disconnectTimers.delete(playerId);
  }

  room.players.delete(playerId);
  room.playerSockets.delete(playerId);
  room.game.timelines.delete(playerId);
  room.game.guesses.delete(playerId);
  room.game.tokens.delete(playerId);
  room.game.stealAttempts.delete(playerId);
  room.game.turnOrder = room.game.turnOrder.filter((id) => id !== playerId);
  if (room.game.pendingDecisions.delete(playerId)) {
    emitStealProgress(room, roomCode);
  }
  io.to(roomCode).emit('playerListUpdate', getPlayerList(room));
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

// A successful steal knows the song's exact year (that's the whole test), so
// there's no ambiguity about where it belongs on the stealer's timeline.
function correctInsertIndex(timeline, year) {
  let index = 0;
  for (const song of timeline) {
    if (Number(song.year) <= Number(year)) index++;
    else break;
  }
  return index;
}

// Every insertion index into a timeline, skipping the redundant zero-width
// gap between two cards that share a year (mirrors the client's dropdown).
function computeGapOptions(timeline) {
  const options = [];
  for (let i = 0; i <= timeline.length; i++) {
    if (i > 0 && i < timeline.length && Number(timeline[i - 1].year) === Number(timeline[i].year)) continue;
    options.push(i);
  }
  return options;
}

// A steal at `stealIndex` is correct if the song's year belongs there - EXCEPT
// on whichever boundary is shared with the active player's own claimed gap,
// where the tie-tolerant "<=" / ">=" tightens to a strict "<" / ">". That
// shared year already counts as correct for the active player, so a stealer
// can't also win with it - "the borders are in his favor".
function isValidSteal(timeline, year, stealIndex, activeGuess) {
  const songYear = Number(year);
  const before = timeline[stealIndex - 1];
  const after = timeline[stealIndex];
  const hasClaim = activeGuess !== null && activeGuess !== undefined;

  const beforeStrict = hasClaim && stealIndex === activeGuess + 1;
  const afterStrict = hasClaim && stealIndex === activeGuess - 1;

  const beforeOk = !before || (beforeStrict ? Number(before.year) < songYear : Number(before.year) <= songYear);
  const afterOk = !after || (afterStrict ? songYear < Number(after.year) : songYear <= Number(after.year));

  return beforeOk && afterOk;
}

// Builds the label for one steal option, shifting whichever boundary is
// shared with the active player's claimed gap by one year so it reads as the
// exclusive range it actually is (e.g. "2012 and before", not "Before 2013").
function buildStealOptionLabel(timeline, index, beforeStrict, afterStrict) {
  if (timeline.length === 0) return 'Only card';

  if (index === 0) {
    const upper = Number(timeline[0].year);
    return afterStrict ? `${upper - 1} and before` : `Before ${upper}`;
  }

  if (index === timeline.length) {
    const lower = Number(timeline[timeline.length - 1].year);
    return beforeStrict ? `${lower + 1} and after` : `After ${lower}`;
  }

  const lowerYear = Number(timeline[index - 1].year);
  const upperYear = Number(timeline[index].year);
  const lowerLabel = beforeStrict ? lowerYear + 1 : lowerYear;
  const upperLabel = afterStrict ? upperYear - 1 : upperYear;
  return `Between ${lowerLabel} and ${upperLabel}`;
}

// Which gaps in the active player's timeline stealers may bet on: every gap
// except their own exact claim (betting the identical range isn't a "steal"),
// with the two neighboring gaps' labels/correctness tightened to exclude the
// boundary year that gap shares with the claim.
function computeStealOptions(activeTimeline, activeGuess) {
  const allIndices = computeGapOptions(activeTimeline);
  const hasClaim = activeGuess !== null && activeGuess !== undefined;

  return allIndices
    .filter((index) => !hasClaim || index !== activeGuess)
    .map((index) => {
      const beforeStrict = hasClaim && index === activeGuess + 1;
      const afterStrict = hasClaim && index === activeGuess - 1;
      return { index, label: buildStealOptionLabel(activeTimeline, index, beforeStrict, afterStrict) };
    });
}

// Total songs still available for a normal round - used to gate the host's
// "Play Random Song" button before they even click it, not just react after.
function getUnplayedCount(room) {
  return room.songPool.filter((song) => !song.played && song.year).length;
}

// Hands each currently-joined player one random distinct song as a free
// starting card, so the very first turn isn't placing onto an empty
// timeline. Runs once per game, right before the first real round.
function dealStarterSongs(room) {
  const dealt = [];

  for (const playerId of room.game.turnOrder) {
    const unplayed = room.songPool.filter((song) => !song.played && song.year);
    if (unplayed.length === 0) break;

    const song = unplayed[Math.floor(Math.random() * unplayed.length)];
    song.played = true;

    const card = { name: song.name, artists: song.artists, year: song.year };
    room.game.timelines.set(playerId, [card]);
    dealt.push({ playerId, nickname: room.players.get(playerId) || 'Unknown', song: card });
  }

  room.game.starterCardsDealt = true;
  return dealt;
}

const DEFAULT_WIN_LENGTH = 10;
const STARTING_TOKENS = 1;
const ALLOWED_WIN_LENGTHS = [3, 5, 8, 10];

// How long a disconnected player has to reconnect before their turn/steal
// decision auto-resolves as a miss/pass - long enough to survive a page
// refresh or a brief wifi drop, short enough that a genuinely gone player
// doesn't stall the round indefinitely.
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 15000;

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

  // Every handler below assumes its last argument is a callable ack
  // callback, since that's all the shipped client ever sends. But a client
  // that emits without one (a malformed message, a rogue script) would
  // otherwise hit `callback(...)` on undefined - an uncaught TypeError that
  // crashes this single Node process, wiping every room's in-memory game
  // state at once. Wrapping registration here guarantees a safe no-op
  // callback instead, without touching any individual handler below.
  const onWithSafeCallback = socket.on.bind(socket);
  socket.on = (event, handler) => onWithSafeCallback(event, (...args) => {
    if (typeof args[args.length - 1] !== 'function') args.push(() => {});
    return handler(...args);
  });

  socket.on('createRoom', (callback) => {
    const code = generateRoomCode();
    // Secret only the actual host's browser ever sees (returned once, below,
    // and never broadcast) - hostRejoin requires it so that merely knowing
    // or opening the room's URL isn't enough to silently take over hosting.
    const hostToken = crypto.randomUUID();
    rooms.set(code, {
      players: new Map(),
      // playerId -> currently-connected socket.id. A player missing here (but
      // still present in `players`) has disconnected but kept their spot -
      // their timeline/tokens/turn order all stay put until they rejoin.
      playerSockets: new Map(),
      // playerId -> pending auto-forfeit/auto-pass timeout from a disconnect,
      // cancelled by rejoinRoom if they reconnect within the grace period.
      disconnectTimers: new Map(),
      spotify: null,
      songPool: [],
      hostId: socket.id,
      hostToken,
      game: {
        currentSong: null,
        timelines: new Map(),
        guesses: new Map(),
        tokens: new Map(),
        winners: [],
        winLength: DEFAULT_WIN_LENGTH,
        // Turn-based play: turnOrder is join order, turnIndex advances every
        // round (never resets on disconnect), and activePlayerId is whoever's
        // turn the CURRENT round belongs to. phase is 'waiting' (no round),
        // 'primary' (active player is placing their bet), or 'steal' (bet is
        // locked in, everyone else is deciding whether to spend a token).
        turnOrder: [],
        turnIndex: 0,
        activePlayerId: null,
        phase: 'waiting',
        starterCardsDealt: false,
        // Steal window bookkeeping, live only during phase === 'steal'.
        stealAttempts: new Map(), // playerId -> chosen gap index into the active player's timeline
        stealOptions: [], // gap indices stealers are currently allowed to pick
        pendingDecisions: new Set(), // playerIds who still owe a steal/pass decision
        stealDecisionTotal: 0,
      },
    });

    socket.join(code);
    socket.data.roomCode = code;

    callback({ code, hostToken });
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

  // Any full page load on the host side (the Spotify redirect, or just a plain
  // refresh) means a brand-new socket connection. This puts that new socket back
  // into the room's Socket.io channel so the host keeps receiving live
  // playerListUpdate broadcasts.
  socket.on('hostRejoin', ({ roomCode, hostToken }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    // Without this check, any browser that merely opens a URL containing
    // this room's code (e.g. a copied/duplicated tab) would silently become
    // the new host and lock out whoever actually created the room - the
    // token is the one piece only the real host's browser was ever given.
    if (!hostToken || hostToken !== room.hostToken) {
      callback({ error: 'Not authorized to host this room.' });
      return;
    }

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    room.hostId = socket.id;

    callback({
      players: getPlayerList(room),
      winLength: room.game.winLength,
      remaining: getUnplayedCount(room),
      // The songPool itself lives on the server and survives a host refresh
      // untouched - but the browser's local playlistLoaded flag doesn't,
      // which used to make a freshly reloaded host page look like the
      // playlist had vanished (hiding "Play Random Song") even though
      // nothing server-side had actually changed.
      playlistLoaded: room.songPool.length > 0,
      // Same idea as playlistLoaded - a plain refresh (not just the
      // Spotify-redirect one) now also restores this room, so the client
      // needs an authoritative answer instead of only trusting the one-time
      // ?spotify=connected URL param from the login redirect.
      spotifyConnected: !!room.spotify,
      round: buildHostRoundSnapshot(room),
    });
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

      callback({ count: room.songPool.length, added: newSongs.length, remaining: getUnplayedCount(room) });
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
    callback({ success: true, remaining: 0 });
  });

  // Picks a random song the room hasn't played yet, marks it played, and hands
  // back only the URI - the name/artist stay server-side until reveal.
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

    if (room.game.turnOrder.length === 0) {
      callback({ error: 'Need at least one player before starting a round.' });
      return;
    }

    // Songs without a release year can't be placed on a timeline, so skip them.
    const unplayed = room.songPool.filter((song) => !song.played && song.year);
    if (unplayed.length === 0) {
      callback({ error: 'No songs left in the pool.' });
      return;
    }

    // First call of a fresh game: hand everyone a free starter card instead
    // of opening with a blind placement onto an empty timeline. This click
    // just deals - the host clicks again to actually start round 1. Refuses
    // to deal at all unless there's enough for every player, so nobody ends
    // up starting the game short a card.
    if (!room.game.starterCardsDealt) {
      if (unplayed.length < room.game.turnOrder.length) {
        callback({
          error: `Need at least ${room.game.turnOrder.length} songs in the pool for starter cards (have ${unplayed.length}) - load more first.`,
        });
        return;
      }

      const dealt = dealStarterSongs(room);
      io.to(roomCode).emit('starterCardsDealt', { dealt });
      callback({ dealt: true, remaining: getUnplayedCount(room) });
      return;
    }

    const song = unplayed[Math.floor(Math.random() * unplayed.length)];
    song.played = true;

    const activePlayerId = room.game.turnOrder[room.game.turnIndex % room.game.turnOrder.length];
    const activeNickname = room.players.get(activePlayerId) || 'Unknown';
    room.game.turnIndex += 1;

    room.game.currentSong = song;
    room.game.activePlayerId = activePlayerId;
    room.game.phase = 'primary';
    room.game.guesses = new Map();
    room.game.stealAttempts = new Map();
    room.game.pendingDecisions = new Set();

    callback({ uri: song.uri, activePlayerId, activeNickname, remaining: getUnplayedCount(room) });
    io.to(roomCode).emit('roundStarted', { activePlayerId, activeNickname });
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

    // If this socket already joined a different room as a player, abandon
    // that identity first - otherwise it'd stay listed there as a ghost.
    const previousRoomCode = socket.data.roomCode;
    const previousPlayerId = socket.data.playerId;
    if (previousRoomCode && previousPlayerId && previousRoomCode !== roomCode) {
      const previousRoom = rooms.get(previousRoomCode);
      if (previousRoom && previousRoom.players.has(previousPlayerId)) {
        socket.leave(previousRoomCode);
        socket.leave(previousPlayerId);
        removePlayer(previousRoom, previousRoomCode, previousPlayerId);
      }
    }

    const playerId = crypto.randomUUID();

    room.players.set(playerId, trimmedNickname);
    room.playerSockets.set(playerId, socket.id);
    room.game.timelines.set(playerId, []);
    room.game.tokens.set(playerId, STARTING_TOKENS);
    if (!room.game.turnOrder.includes(playerId)) {
      room.game.turnOrder.push(playerId);
    }
    socket.join(roomCode);
    // A private room, just for this player, so the server can target them
    // directly (e.g. tokensUpdated) without tracking their socket.id - which
    // changes every time they reconnect.
    socket.join(playerId);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;

    io.to(roomCode).emit('playerListUpdate', getPlayerList(room));
    callback({ success: true, code: roomCode, playerId, timeline: [], tokens: STARTING_TOKENS });
  });

  // Reconnects an existing player identity to a new socket (e.g. after a page
  // reload or a dropped connection) instead of starting over - restores their
  // timeline, tokens, and wherever the current round's phase left off.
  socket.on('rejoinRoom', ({ roomCode, playerId }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    if (!room.players.has(playerId)) {
      callback({ error: 'Player not found in this room.' });
      return;
    }

    const pendingTimer = room.disconnectTimers.get(playerId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      room.disconnectTimers.delete(playerId);
    }

    room.playerSockets.set(playerId, socket.id);
    socket.join(roomCode);
    socket.join(playerId);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;

    io.to(roomCode).emit('playerListUpdate', getPlayerList(room));

    callback({
      success: true,
      code: roomCode,
      playerId,
      nickname: room.players.get(playerId),
      timeline: room.game.timelines.get(playerId) || [],
      tokens: room.game.tokens.get(playerId) || 0,
      ...buildRoundSnapshot(room, playerId),
    });
  });

  // The active player locks in where they think the currently-playing song
  // belongs on their own timeline. Submitting this immediately opens the
  // steal window for everyone else - nobody (including the active player)
  // learns whether it was actually correct until the reveal.
  socket.on('submitGuess', ({ roomCode, position }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    const playerId = socket.data.playerId;
    if (!playerId || !room.players.has(playerId)) {
      callback({ error: 'Only players can guess.' });
      return;
    }

    if (!room.game.currentSong || room.game.phase !== 'primary') {
      callback({ error: 'No bet to place right now.' });
      return;
    }

    if (playerId !== room.game.activePlayerId) {
      callback({ error: "It's not your turn." });
      return;
    }

    const timeline = room.game.timelines.get(playerId) || [];
    const clamped = Math.max(0, Math.min(Number(position), timeline.length));
    room.game.guesses.set(playerId, clamped);

    openStealWindow(room, roomCode);
    callback({ success: true });
  });

  // A non-active player spends a steal token to bet on one of the active
  // player's own timeline gaps (excluding the one the active player already
  // claimed, plus its neighbors) - if the active player's bet turns out
  // wrong and this gap is where the song actually belongs, the steal wins.
  socket.on('submitSteal', ({ roomCode, position }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    const playerId = socket.data.playerId;
    if (!playerId || !room.players.has(playerId)) {
      callback({ error: 'Only players can steal.' });
      return;
    }

    if (room.game.phase !== 'steal') {
      callback({ error: 'No steal window is open right now.' });
      return;
    }

    if (playerId === room.game.activePlayerId) {
      callback({ error: "You can't steal on your own turn." });
      return;
    }

    if (!room.game.pendingDecisions.has(playerId)) {
      callback({ error: 'You already decided this round.' });
      return;
    }

    const chosen = Number(position);
    if (!room.game.stealOptions.includes(chosen)) {
      callback({ error: 'That spot is off-limits this round.' });
      return;
    }

    const tokens = room.game.tokens.get(playerId) || 0;
    if (tokens <= 0) {
      callback({ error: "You don't have a steal token." });
      return;
    }

    room.game.tokens.set(playerId, tokens - 1);
    room.game.stealAttempts.set(playerId, chosen);
    room.game.pendingDecisions.delete(playerId);

    callback({ success: true, tokens: tokens - 1 });
    emitStealProgress(room, roomCode);
  });

  // A non-active player explicitly declines to steal - free, no token cost.
  socket.on('passSteal', ({ roomCode }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    const playerId = socket.data.playerId;
    if (!playerId || !room.players.has(playerId)) {
      callback({ error: 'Only players can decide this.' });
      return;
    }

    if (room.game.phase !== 'steal') {
      callback({ error: 'No steal window is open right now.' });
      return;
    }

    if (playerId === room.game.activePlayerId) {
      callback({ error: "You can't steal on your own turn." });
      return;
    }

    if (!room.game.pendingDecisions.has(playerId)) {
      callback({ error: 'You already decided this round.' });
      return;
    }

    room.game.pendingDecisions.delete(playerId);
    callback({ success: true });
    emitStealProgress(room, roomCode);
  });

  // Host-triggered, only once every steal decision is in. Scores the active
  // player's bet; if they missed, checks every steal attempt's chosen gap
  // against the real year, using the SAME active-player timeline the
  // stealers saw (frozen since the steal window opened - nothing gets added
  // to it unless the active player was right, which disqualifies stealers
  // anyway). A steal token is spent the instant it's used (submitSteal), win
  // or lose - there's nothing left to deduct here.
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

    if (room.game.phase !== 'steal') {
      callback({ error: "Waiting for the active player's bet." });
      return;
    }

    if (room.game.pendingDecisions.size > 0) {
      callback({ error: 'Still waiting on steal decisions.' });
      return;
    }

    const activePlayerId = room.game.activePlayerId;
    const activeNickname = room.players.get(activePlayerId) || 'Unknown';
    const activeTimeline = room.game.timelines.get(activePlayerId) || [];
    const activeGuess = room.game.guesses.has(activePlayerId) ? room.game.guesses.get(activePlayerId) : null;
    const activeCorrect = activeGuess !== null && isValidGuess(activeTimeline, song.year, activeGuess);

    const winners = [];

    if (activeCorrect) {
      const updatedTimeline = [...activeTimeline];
      updatedTimeline.splice(activeGuess, 0, { name: song.name, artists: song.artists, year: song.year });
      room.game.timelines.set(activePlayerId, updatedTimeline);
      if (updatedTimeline.length >= room.game.winLength) winners.push(activeNickname);
    }

    // Steal attempts only matter if the active player missed - otherwise
    // every attempt was already a spent token for nothing.
    const stealResults = [];
    for (const [playerId, position] of room.game.stealAttempts.entries()) {
      const nickname = room.players.get(playerId) || 'Unknown';
      const correct = !activeCorrect && isValidSteal(activeTimeline, song.year, position, activeGuess);

      if (correct) {
        const timeline = room.game.timelines.get(playerId) || [];
        const updatedTimeline = [...timeline];
        updatedTimeline.splice(correctInsertIndex(timeline, song.year), 0, {
          name: song.name,
          artists: song.artists,
          year: song.year,
        });
        room.game.timelines.set(playerId, updatedTimeline);
        if (updatedTimeline.length >= room.game.winLength) winners.push(nickname);
      }

      stealResults.push({
        playerId,
        nickname,
        position,
        correct,
        timeline: room.game.timelines.get(playerId) || [],
      });
    }

    room.game.currentSong = null;
    room.game.phase = 'waiting';
    room.game.guesses = new Map();
    room.game.stealAttempts = new Map();
    room.game.stealOptions = [];
    room.game.pendingDecisions = new Set();
    if (winners.length > 0) room.game.winners = winners;

    io.to(roomCode).emit('roundResult', {
      song: { name: song.name, artists: song.artists, year: song.year },
      activePlayerId,
      activeNickname,
      activeCorrect,
      activeTimeline: room.game.timelines.get(activePlayerId) || [],
      tokenEligible: activeCorrect,
      stealResults,
      winners,
    });

    callback({ success: true });
  });

  // Host-only, called after a reveal where the active player was correct.
  // The app can't verify they said the song's name/artist out loud, so this
  // is a manual judgment call - clicking it is the "approval".
  socket.on('awardStealToken', ({ roomCode, playerId }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ error: 'Room not found.' });
      return;
    }

    if (socket.id !== room.hostId) {
      callback({ error: 'Only the host can award steal tokens.' });
      return;
    }

    if (!room.players.has(playerId)) {
      callback({ error: 'Player not found.' });
      return;
    }

    const tokens = (room.game.tokens.get(playerId) || 0) + 1;
    room.game.tokens.set(playerId, tokens);

    io.to(playerId).emit('tokensUpdated', { tokens });
    io.to(roomCode).emit('playerListUpdate', getPlayerList(room));
    callback({ success: true, tokens });
  });

  // Host-only: resets scores/timelines/tokens and re-opens the whole song bank
  // so the same room can play another game without redoing Spotify login or
  // playlists.
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
    room.game.stealAttempts = new Map();
    room.game.stealOptions = [];
    room.game.pendingDecisions = new Set();
    room.game.stealDecisionTotal = 0;
    room.game.winners = [];
    room.game.phase = 'waiting';
    room.game.activePlayerId = null;
    room.game.starterCardsDealt = false;
    room.game.turnOrder = Array.from(room.players.keys());
    room.game.turnIndex = 0;

    const freshTimelines = new Map();
    const freshTokens = new Map();
    for (const playerId of room.players.keys()) {
      freshTimelines.set(playerId, []);
      freshTokens.set(playerId, STARTING_TOKENS);
    }
    room.game.timelines = freshTimelines;
    room.game.tokens = freshTokens;

    io.to(roomCode).emit('playerListUpdate', getPlayerList(room));
    io.to(roomCode).emit('newGameStarted', { remaining: getUnplayedCount(room), startingTokens: STARTING_TOKENS });
    callback({ success: true });
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);

    const roomCode = socket.data.roomCode;
    const playerId = socket.data.playerId;
    const room = roomCode && rooms.get(roomCode);

    // A rejoin may have already handed this playerId off to a newer socket
    // before this (older) socket's disconnect event arrived - don't let a
    // stale event knock a reconnected player back offline. Their spot
    // (timeline/tokens/turn order) stays put either way, so they can pick up
    // where they left off with rejoinRoom.
    if (room && playerId && room.playerSockets.get(playerId) === socket.id) {
      room.playerSockets.delete(playerId);
      io.to(roomCode).emit('playerListUpdate', getPlayerList(room));

      // Don't auto-forfeit the instant someone drops - a page refresh looks
      // identical to a dead connection at this point, and firing immediately
      // would silently skip their turn/steal decision before rejoinRoom even
      // gets a chance to run. Give them a grace period to reconnect first;
      // rejoinRoom cancels this if they make it back in time.
      const timer = setTimeout(() => {
        room.disconnectTimers.delete(playerId);

        if (room.playerSockets.has(playerId)) return; // reconnected in time

        // Don't let a vanished player permanently block the steal window.
        if (room.game.phase === 'steal' && room.game.pendingDecisions.delete(playerId)) {
          emitStealProgress(room, roomCode);
        }

        // Or, if they were mid-turn and never placed their bet, open the
        // steal window anyway (as an auto-miss) so the round isn't stuck.
        if (room.game.phase === 'primary' && room.game.activePlayerId === playerId) {
          openStealWindow(room, roomCode);
        }
      }, RECONNECT_GRACE_MS);

      room.disconnectTimers.set(playerId, timer);
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
