const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

// 100 MB limit for images (prototype-safe, but consider lowering later)
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
 * Used to target the projector tab(s) that belong to a specific player.
 */
let projectorSockets = {};

function getRoom(roomId) {
  return games[roomId] || null;
}

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

    socket.emit('joinedRoom', {
      id: roomId,
      name,
      players: listPlayers(games[roomId])
    });

    io.emit('updateGameList', games);
  });

  // JOIN
  socket.on('joinGame', ({ roomId, playerId }) => {
    const room = getRoom(roomId);
    if (!room || !playerId) return;

    // Prevent duplicate IDs inside the SAME room (stops collisions & impersonation)
    const exists = room.players.some(p => p.playerId === playerId);
    if (exists) {
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

  // PROJECTOR JOIN (now includes ownerId so we can target blanking)
  socket.on('joinAsProjector', ({ roomId, ownerId }) => {
    const room = getRoom(roomId);
    if (!roomId || !ownerId || !room) return;

    socket.isProjector = true;
    socket.projectorRoomId = roomId;
    socket.projectorOwnerId = ownerId;

    socket.join(roomId);

    ensureProjectorBucket(roomId, ownerId);
    projectorSockets[roomId][ownerId].add(socket.id);

    console.log(`Projector joined room=${roomId} owner=${ownerId} socket=${socket.id}`);
  });

  // LEAVE
  socket.on('leaveGame', (roomId) => {
    const room = getRoom(roomId);
    if (!room) return;

    socket.leave(roomId);

    // Remove player entry if present
    room.players = room.players.filter(p => p.socketId !== socket.id);

    if (room.players.length === 0) {
      delete games[roomId];
    } else {
      io.to(roomId).emit('playerUpdate', listPlayers(room));
    }

    socket.emit('backToLobby');
    io.emit('updateGameList', games);
  });

  /**
   * BLANKING CONTROL
   * Client calls: socket.emit('setProjectorBlank', { roomId, ownerId, blank: true/false })
   * Server targets the projector tab(s) belonging to that owner in that room.
   */
  socket.on('setProjectorBlank', ({ roomId, ownerId, blank }) => {
    const room = getRoom(roomId);
    if (!room || !roomId || !ownerId) return;

    const roomMap = projectorSockets[roomId];
    if (!roomMap || !roomMap[ownerId]) return;

    for (const projectorSocketId of roomMap[ownerId]) {
      io.to(projectorSocketId).emit('projectorBlank', { blank: !!blank });
    }
  });

  // IMAGE HANDLING
  socket.on('sendImage', ({ roomId, image }) => {
    const room = getRoom(roomId);
    if (!room || !image) return;

    if (typeof image !== 'string' || !image.startsWith('data:image/')) return;

    // Broadcast to everyone in room (controllers ignore; projectors filter by ownerId)
    io.to(roomId).emit('receiveImage', {
      image,
      senderId: socket.playerId
    });
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    // If this socket was a projector, clean up its registration
    if (socket.isProjector && socket.projectorRoomId && socket.projectorOwnerId) {
      removeProjectorSocket(socket.projectorRoomId, socket.projectorOwnerId, socket.id);
    }

    // Remove player record(s) if this was a controller socket
    removePlayerFromAllRooms(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
