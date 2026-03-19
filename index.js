const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const Chess = require('chess.js').Chess || require('chess.js');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─────────────────────────── In-memory state ────────────────────────────────
const rooms = new Map();              // roomId → Room
const randomQueue = [];               // [{ socketId, name }]
const disconnectTimers = new Map();   // "roomId+color" → setTimeout handle

// ─────────────────────────── Helpers ────────────────────────────────────────
function genRoomId() {
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += CHARS[Math.floor(Math.random() * CHARS.length)];
  return rooms.has(id) ? genRoomId() : id;
}

function createRoom(wSocketId, wName) {
  const id = genRoomId();
  const room = {
    id,
    players: {
      w: { socketId: wSocketId, name: wName, connected: true },
      b: null
    },
    chess: new Chess(),
    status: 'waiting' // waiting | playing | finished
  };
  rooms.set(id, room);
  return room;
}

function startGame(room) {
  const base = {
    roomId: room.id,
    white: room.players.w.name,
    black: room.players.b.name,
    fen: room.chess.fen()
  };
  // Each player gets their own color
  io.to(room.players.w.socketId).emit('game_start', { ...base, myColor: 'w' });
  io.to(room.players.b.socketId).emit('game_start', { ...base, myColor: 'b' });
}

function doForfeit(room, loserColor) {
  if (room.status === 'finished') return;
  room.status = 'finished';
  const winner = loserColor === 'w' ? 'b' : 'w';
  io.to(room.id).emit('game_over', {
    reason: 'forfeit',
    winner,
    white: room.players.w.name,
    black: room.players.b?.name ?? '?'
  });
}

function cancelDisconnectTimer(roomId, color) {
  const key = roomId + color;
  if (disconnectTimers.has(key)) {
    clearTimeout(disconnectTimers.get(key));
    disconnectTimers.delete(key);
    return true;
  }
  return false;
}

// ─────────────────────────── Stockfish proxy ────────────────────────────────
// Browsers can't call stockfish.online directly (CORS). We proxy it here.
app.post('/api/best-move', async (req, res) => {
  const { fen, depth = 14 } = req.body;
  if (!fen) return res.status(400).json({ error: 'Missing fen' });

  try {
    const url = `https://stockfish.online/api/s/v2.php?fen=${encodeURIComponent(fen)}&depth=${Math.min(Number(depth), 20)}`;
    const response = await fetch(url);
    const data = await response.json();

    let raw = data?.bestmove ?? '';
    raw = raw.replace(/^bestmove\s+/i, '').trim().split(/\s+/)[0].toLowerCase();

    if (data.success && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(raw)) {
      return res.json({ move: raw });
    }
    res.status(422).json({ error: 'Stockfish returned no valid move' });
  } catch (err) {
    console.error('Stockfish proxy error:', err.message);
    res.status(500).json({ error: 'Stockfish unavailable' });
  }
});


app.get('/health', (_, res) =>
  res.json({ ok: true, rooms: rooms.size, queue: randomQueue.length })
);

// ─────────────────────────── Socket.io ──────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── Create private room ──────────────────────────────────────────────────
  socket.on('create_room', ({ name }) => {
    if (!name) return;
    const room = createRoom(socket.id, name);
    socket.join(room.id);
    socket.emit('room_created', { roomId: room.id });
    console.log(`Room ${room.id} created by "${name}"`);
  });

  // ── Join private room ────────────────────────────────────────────────────
  socket.on('join_room', ({ roomId, name }) => {
    if (!name || !roomId) return;
    const room = rooms.get(roomId.toUpperCase().trim());
    if (!room) {
      return socket.emit('room_error', { message: 'Room not found. Double-check the code.' });
    }
    if (room.status !== 'waiting') {
      return socket.emit('room_error', { message: 'This room is full or the game has already started.' });
    }
    room.players.b = { socketId: socket.id, name, connected: true };
    room.status = 'playing';
    socket.join(room.id);
    startGame(room);
    console.log(`Room ${room.id} started: "${room.players.w.name}" vs "${name}"`);
  });

  // ── Join random queue ────────────────────────────────────────────────────
  socket.on('join_random', ({ name }) => {
    if (!name) return;
    // Clear stale queue entry for this socket
    const qi = randomQueue.findIndex(e => e.socketId === socket.id);
    if (qi !== -1) randomQueue.splice(qi, 1);

    if (randomQueue.length > 0) {
      const opp = randomQueue.shift();
      const oppSocket = io.sockets.sockets.get(opp.socketId);
      if (!oppSocket) {
        // Opponent disconnected while waiting — try again recursively
        return socket.emit('join_random', { name });
      }
      const room = createRoom(opp.socketId, opp.name);
      room.players.b = { socketId: socket.id, name, connected: true };
      room.status = 'playing';
      oppSocket.join(room.id);
      socket.join(room.id);
      startGame(room);
      console.log(`Random match: "${opp.name}" vs "${name}" in ${room.id}`);
    } else {
      randomQueue.push({ socketId: socket.id, name });
      socket.emit('in_queue', { position: randomQueue.length });
      console.log(`"${name}" joined queue (depth: ${randomQueue.length})`);
    }
  });

  // ── Cancel random queue ──────────────────────────────────────────────────
  socket.on('cancel_queue', () => {
    const qi = randomQueue.findIndex(e => e.socketId === socket.id);
    if (qi !== -1) randomQueue.splice(qi, 1);
    socket.emit('queue_cancelled');
  });

  // ── Make move ────────────────────────────────────────────────────────────
  socket.on('make_move', ({ roomId, move }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    const turn = room.chess.turn();
    const player = room.players[turn];
    if (!player || player.socketId !== socket.id) {
      return socket.emit('not_your_turn');
    }

    try {
      const result = room.chess.move(move);
      const fen = room.chess.fen();
      io.to(roomId).emit('move_made', { move: result, fen, turn: room.chess.turn() });

      if (room.chess.game_over()) {
        room.status = 'finished';
        let reason = 'draw';
        let winner = null;
        if (room.chess.in_checkmate()) { reason = 'checkmate'; winner = turn; }
        else if (room.chess.in_stalemate()) reason = 'stalemate';
        else if (room.chess.insufficient_material()) reason = 'insufficient';
        else if (room.chess.in_threefold_repetition()) reason = 'repetition';

        io.to(roomId).emit('game_over', {
          reason, winner,
          white: room.players.w.name,
          black: room.players.b.name
        });
        console.log(`Game over in ${roomId}: ${reason}, winner=${winner}`);
      }
    } catch (err) {
      socket.emit('invalid_move');
    }
  });

  // ── Rejoin after page refresh ────────────────────────────────────────────
  socket.on('rejoin_room', ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('room_error', { message: 'Room has expired.' });

    let color = null;
    if (room.players.w?.name === name) color = 'w';
    else if (room.players.b?.name === name) color = 'b';
    if (!color) return socket.emit('room_error', { message: 'Your name was not found in this room.' });

    const wasTimerRunning = cancelDisconnectTimer(roomId, color);
    if (wasTimerRunning) {
      io.to(roomId).emit('opponent_reconnected');
    }

    room.players[color].socketId = socket.id;
    room.players[color].connected = true;
    socket.join(roomId);

    socket.emit('game_rejoined', {
      roomId,
      myColor: color,
      fen: room.chess.fen(),
      white: room.players.w.name,
      black: room.players.b?.name ?? '',
      status: room.status,
      turn: room.chess.turn()
    });
    console.log(`"${name}" rejoined ${roomId} as ${color}`);
  });

  // ── Disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);

    // Remove from random queue
    const qi = randomQueue.findIndex(e => e.socketId === socket.id);
    if (qi !== -1) randomQueue.splice(qi, 1);

    // Handle in-game disconnects
    rooms.forEach((room, roomId) => {
      if (room.status !== 'playing') return;
      ['w', 'b'].forEach(color => {
        const p = room.players[color];
        if (!p || p.socketId !== socket.id) return;

        p.connected = false;
        io.to(roomId).emit('opponent_disconnected', { color });

        const key = roomId + color;
        const timer = setTimeout(() => {
          disconnectTimers.delete(key);
          doForfeit(room, color);
        }, 30_000);
        disconnectTimers.set(key, timer);
        console.log(`"${p.name}" disconnected from ${roomId}; forfeit in 30s`);
      });
    });
  });
});

// ─────────────────────────── Start ──────────────────────────────────────────
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Chess server running on port ${PORT}`);
});
