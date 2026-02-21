// server.js
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

const io = new Server(server, { maxHttpBufferSize: 1e8 });
app.use(express.static('public'));

/**
 * games[roomId] = {
 *   id, name,
 *   password: string ("" means no password),
 *   players: [hostId, joinerId?],
 *   cameraReady: { [playerId]: true/false }
 * }
 */
let games = {};

function publicRooms() {
  // Never leak passwords. Only provide hasPassword boolean.
  const out = {};
  for (const [id, r] of Object.entries(games)) {
    out[id] = {
      id: r.id,
      name: r.name,
      players: r.players || [],
      hasPassword: !!(r.password && r.password.length > 0),
    };
  }
  return out;
}

function emitRoomList() {
  io.emit('updateGameList', publicRooms());
}

function emitCameraReady(roomId) {
  const room = games[roomId];
  if (!room) return;

  const status = {};
  for (const pid of room.players) status[pid] = !!room.cameraReady?.[pid];

  const bothReady = room.players.length >= 2 && room.players.every(pid => !!room.cameraReady?.[pid]);
  io.to(roomId).emit('cameraReadyUpdate', { roomId, status, bothReady });
}

io.on('connection', (socket) => {
  socket.playerId = null;

  // Initial lobby list
  socket.emit('updateGameList', publicRooms());

  // 1) HOST GAME (password optional)
  socket.on('hostGame', ({ name, playerId, password }) => {
    if (!name || !playerId) return;

    socket.playerId = String(playerId).trim();

    let roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
    while (games[roomId]) roomId = Math.random().toString(36).substr(2, 5).toUpperCase();

    games[roomId] = {
      id: roomId,
      name: String(name).trim(),
      password: (password ? String(password) : "").trim(),
      players: [socket.playerId],
      cameraReady: { [socket.playerId]: false }
    };

    socket.join(roomId);

    // Send full room object to members (password not included)
    socket.emit('joinedRoom', { id: roomId, name: games[roomId].name, players: games[roomId].players });
    emitRoomList();
    emitCameraReady(roomId);
  });

  // 2) JOIN GAME (password checked here)
  socket.on('joinGame', ({ roomId, playerId, passwordAttempt }) => {
    if (!roomId || !playerId) return;
    roomId = String(roomId).trim();
    if (!games[roomId]) return;

    const room = games[roomId];
    const pid = String(playerId).trim();
    socket.playerId = pid;

    // Reject if full (2 players max for now)
    if (room.players.length >= 2 && !room.players.includes(pid)) {
      socket.emit('errorMsg', 'Room is full.');
      return;
    }

    // Password validation
    const roomPass = (room.password || "");
    const attempt = (passwordAttempt ? String(passwordAttempt) : "").trim();
    if (roomPass.length > 0 && attempt !== roomPass) {
      socket.emit('errorMsg', 'Incorrect password.');
      return;
    }

    socket.join(roomId);

    if (!room.players.includes(pid)) room.players.push(pid);
    if (!room.cameraReady) room.cameraReady = {};
    if (room.cameraReady[pid] === undefined) room.cameraReady[pid] = false;

    // Notify room + send room info to joiner
    io.to(roomId).emit('playerUpdate', room.players);
    socket.emit('joinedRoom', { id: roomId, name: room.name, players: room.players });

    emitRoomList();
    emitCameraReady(roomId);
  });

  // 3) JOIN AS PROJECTOR
  socket.on('joinAsProjector', ({ roomId, ownerId }) => {
    if (!roomId || !games[roomId]) return;
    socket.join(roomId);
  });

  // 4) LEAVE GAME
  socket.on('leaveGame', (roomId) => {
    if (!roomId || !games[roomId]) return;
    roomId = String(roomId).trim();

    const room = games[roomId];
    socket.leave(roomId);

    // Remove player
    room.players = room.players.filter(p => p !== socket.playerId);
    if (room.cameraReady) delete room.cameraReady[socket.playerId];

    if (room.players.length === 0) {
      delete games[roomId];
    } else {
      io.to(roomId).emit('playerUpdate', room.players);
      emitCameraReady(roomId);
    }

    socket.emit('backToLobby');
    emitRoomList();
  });

  // 5) CAMERA READY HANDSHAKE
  socket.on('cameraReady', ({ roomId, playerId, ready }) => {
    if (!roomId || !games[roomId]) return;
    roomId = String(roomId).trim();

    const room = games[roomId];
    const pid = String(playerId || "").trim();
    if (!pid || !room.players.includes(pid)) return;

    room.cameraReady[pid] = !!ready;
    emitCameraReady(roomId);
  });

  // --- STANDARD GAMEPLAY RELAYS ---
  socket.on('sendImage', ({ roomId, image }) => {
    if (!roomId || !image || !games[roomId]) return;
    io.to(roomId).emit('receiveImage', { image, senderId: socket.playerId });
  });

  socket.on('rollDice', ({ roomId, dice, senderId }) => {
    if (!roomId || !games[roomId]) return;
    io.to(roomId).emit('diceRolled', { dice, senderId });
  });

  // Grid settings per owner (includes rows/cols now)
  socket.on('setProjectorGrid', ({ roomId, ownerId, enabled, cols, rows, width, height }) => {
    if (!roomId || !games[roomId]) return;
    io.to(roomId).emit('projectorGrid', {
      ownerId,
      enabled: !!enabled,
      cols: parseInt(cols, 10) || 30,
      rows: parseInt(rows, 10) || 22,
      width: parseInt(width, 10) || 50,
      height: parseInt(height, 10) || 50
    });
  });

  // Owner-specific projector blank
  socket.on('setProjectorBlank', ({ roomId, ownerId, blank }) => {
    if (!roomId || !games[roomId]) return;
    io.to(roomId).emit('projectorBlank', { ownerId, blank: !!blank });
  });

  // Field alignment relay per owner
  socket.on('setFieldAlign', (data) => {
    if (data && data.roomId) io.to(data.roomId).emit('fieldAlign', data);
  });

  // Host triggers global start/stop
  socket.on('triggerGlobalStart', (roomId) => {
    if (!roomId || !games[roomId]) return;
    const room = games[roomId];
    const hostId = room.players[0];
    if (socket.playerId !== hostId) return; // only host can start
    io.to(roomId).emit('globalStartCommand');
  });

  socket.on('triggerGlobalStop', (roomId) => {
    if (!roomId || !games[roomId]) return;
    const room = games[roomId];
    const hostId = room.players[0];
    if (socket.playerId !== hostId) return; // only host can stop
    io.to(roomId).emit('globalStopCommand');
  });

  // DISCONNECT CLEANUP
  socket.on('disconnect', () => {
    if (!socket.playerId) return;
    let changed = false;

    for (const roomId of Object.keys(games)) {
      const room = games[roomId];
      if (room.players.includes(socket.playerId)) {
        room.players = room.players.filter(p => p !== socket.playerId);
        if (room.cameraReady) delete room.cameraReady[socket.playerId];
        changed = true;

        if (room.players.length === 0) {
          delete games[roomId];
        } else {
          io.to(roomId).emit('playerUpdate', room.players);
          emitCameraReady(roomId);
        }
      }
    }
    if (changed) emitRoomList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
