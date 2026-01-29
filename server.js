const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

// 100 MB limit for images
const io = new Server(server, {
  maxHttpBufferSize: 1e8
});

app.use(express.static('public'));

/**
 * games[roomId] = {
 *   id: string,
 *   name: string,
 *   players: [{ playerId: string, socketId: string }]
 * }
 */
let games = {};

/**
 * projectorSockets[roomId][ownerId] = Set(socketId)
 */
let projectorSockets = {};

function listPlayers(room) {
  return room.players.map(p => p.playerId);
}

function ensureProjectorBucket(roomId, ownerId) {
  if (!projectorSockets[roomId]) projectorSockets[roomId] = {};
  if (!projectorSockets[roomId][ownerId]) projectorSockets[roomId][ownerId] = new Set();
}

function removeProjectorSocket(roomId, ownerId, socketId) {
  const roomMap = projectorSockets[roomId];
  if (!roomMap) return;

  const set = roomMap[ownerId];
  if (!set) return;

  set.delete(socketId);

  if (set.size === 0) delete roomMap[ownerId];
  if (Object.keys(roomMap).length === 0) delete projectorSockets[roomId];
}

function removePlayerFromAllRooms(socket) {
  let changed = false;

  for (const roomId of Object.keys(games)) {
    const room = games[roomId];
    const before = room.players.length;

    room.players = room.players.filter(p => p.socketId !== socket.id);

    if (room.players.length !== before) {
      changed = true;

      if (room.players.length === 0) {
        delete games[roomId];
      } else {
        io.to(roomId).emit('playerUpdate', listPlayers(room));
      }
    }
  }

  if (changed) io.emit('updateGameList', games);
}

io.on('connection', (socket) => {
  socket.playerId = null;

  // Projector socket identity
  socket.isProjector = false;
  socket.projectorRoomId = null;
  socket.projectorOwnerId = null;

  socket.emit('updateGameList', games);

  // HOST
  socket.on('hostGame', ({ name, playerId }) => {
    if (!name || !playerId) return;

    socket.playerId = playerId;

    let roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
    while (games[roomId]) roomId = Math.random().toString(36).substr(2, 5).toUpperCase();

    games[roomId] = {
      id: roomId,
      name,
      players: [{ playerId, socketId: socket.id }]
    };

    socket.join(roomId);

    socket.emit('joinedRoom', { id: roomId, name, players: listPlayers(games[roomId]) });
    io.emit('updateGameList', games);
  });

  // JOIN
  socket.on('joinGame', ({ roomId, playerId }) => {
    const room = games[roomId];
    if (!room || !playerId) return;

    // Prevent duplicate player IDs in the same room
    if (room.players.some(p => p.playerId === playerId)) {
      socket.emit('errorMsg', `Player ID "${playerId}" is already in this room. Choose a different one.`);
      return;
    }

    socket.playerId = playerId;
    socket.join(roomId);

    room.players.push({ playerId, socketId: socket.id });

    io.to(roomId).emit('playerUpdate', listPlayers(room));
    socket.emit('joinedRoom', { id: roomId, name: room.name, players: listPlayers(room) });
    io.emit('updateGameList', games);
  });

  // PROJECTOR JOIN (room + owner)
  socket.on('joinAsProjector', ({ roomId, ownerId }) => {
    const room = games[roomId];
    if (!room || !roomId || !ownerId) return;

    socket.isProjector = true;
    socket.projectorRoomId = roomId;
    socket.projectorOwnerId = ownerId;

    socket.join(roomId);

    ensureProjectorBucket(roomId, ownerId);
    projectorSockets[roomId][ownerId].add(socket.id);

    console.log(`Projector joined room=${roomId} owner=${ownerId} socket=${socket.id}`);
  });

  // NEW: Set projector view mode for an owner's projector(s)
  // mode: "normal" => show opponent only
  // mode: "calibrate" => show owner only
  socket.on('setProjectorViewMode', ({ roomId, ownerId, mode }) => {
    const room = games[roomId];
    if (!room || !roomId || !ownerId) return;

    const roomMap = projectorSockets[roomId];
    if (!roomMap || !roomMap[ownerId]) return;

    const safeMode = (mode === 'calibrate') ? 'calibrate' : 'normal';

    for (const projectorSocketId of roomMap[ownerId]) {
      io.to(projectorSocketId).emit('projectorViewMode', { mode: safeMode });
    }
  });

  // BLANKING CONTROL (targets owner's projector sockets)
  socket.on('setProjectorBlank', ({ roomId, ownerId, blank }) => {
    const room = games[roomId];
    if (!room || !roomId || !ownerId) return;

    const roomMap = projectorSockets[roomId];
    if (!roomMap || !roomMap[ownerId]) return;

    for (const projectorSocketId of roomMap[ownerId]) {
      io.to(projectorSocketId).emit('projectorBlank', { blank: !!blank });
    }
  });

  // LEAVE
  socket.on('leaveGame', (roomId) => {
    const room = games[roomId];
    if (!room) return;

    socket.leave(roomId);

    room.players = room.players.filter(p => p.socketId !== socket.id);

    if (room.players.length === 0) {
      delete games[roomId];
    } else {
      io.to(roomId).emit('playerUpdate', listPlayers(room));
    }

    socket.emit('backToLobby');
    io.emit('updateGameList', games);
  });

  // IMAGE HANDLING
  socket.on('sendImage', ({ roomId, image }) => {
    const room = games[roomId];
    if (!room || !roomId || !image) return;

    if (typeof image !== 'string' || !image.startsWith('data:image/')) return;

    io.to(roomId).emit('receiveImage', {
      image,
      senderId: socket.playerId
    });
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    if (socket.isProjector && socket.projectorRoomId && socket.projectorOwnerId) {
      removeProjectorSocket(socket.projectorRoomId, socket.projectorOwnerId, socket.id);
    }
    removePlayerFromAllRooms(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
