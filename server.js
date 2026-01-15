const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

// Increase limit for image data (still recommend lowering later)
const io = new Server(server, {
  maxHttpBufferSize: 1e8 // 100 MB
});

app.use(express.static('public'));

let games = {};

io.on('connection', (socket) => {
  // NEW: store playerId on socket
  socket.playerId = null;

  socket.emit('updateGameList', games);

  // 1. HOST (now expects { name, playerId })
  socket.on('hostGame', ({ name, playerId }) => {
    if (!name || !playerId) return;

    socket.playerId = playerId;

    // Generate roomId
    let roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
    while (games[roomId]) {
      roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
    }

    games[roomId] = { id: roomId, name: name, players: [playerId] };

    socket.join(roomId);
    socket.emit('joinedRoom', games[roomId]);
    io.emit('updateGameList', games);
  });

  // 2. JOIN (now expects { roomId, playerId })
  socket.on('joinGame', ({ roomId, playerId }) => {
    if (!roomId || !playerId) return;
    if (!games[roomId]) return;

    socket.playerId = playerId;
    socket.join(roomId);

    games[roomId].players.push(playerId);

    io.to(roomId).emit('playerUpdate', games[roomId].players);
    socket.emit('joinedRoom', games[roomId]);
    io.emit('updateGameList', games);
  });

  // 3. LEAVE
  socket.on('leaveGame', (roomId) => {
    if (!games[roomId]) return;

    socket.leave(roomId);

    // Remove this player's ID from the room
    games[roomId].players = games[roomId].players.filter(p => p !== socket.playerId);

    if (games[roomId].players.length === 0) {
      delete games[roomId];
    } else {
      io.to(roomId).emit('playerUpdate', games[roomId].players);
    }

    socket.emit('backToLobby');
    io.emit('updateGameList', games);
  });

  // 4. IMAGE HANDLING
  socket.on('sendImage', ({ roomId, image }) => {
    if (!roomId || !image) return;
    if (!games[roomId]) return;

    // (Optional) basic validation
    if (typeof image !== 'string' || !image.startsWith('data:image/')) return;

    // Broadcast to everyone in the room
    io.to(roomId).emit('receiveImage', image);
  });

  // NEW (recommended): cleanup on disconnect to avoid ghost players/rooms
  socket.on('disconnect', () => {
    if (!socket.playerId) return;

    let changed = false;

    for (const roomId of Object.keys(games)) {
      const room = games[roomId];
      if (room.players.includes(socket.playerId)) {
        room.players = room.players.filter(p => p !== socket.playerId);
        changed = true;

        if (room.players.length === 0) {
          delete games[roomId];
        } else {
          io.to(roomId).emit('playerUpdate', room.players);
        }
      }
    }

    if (changed) io.emit('updateGameList', games);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
