const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

const io = new Server(server, { maxHttpBufferSize: 1e8 });
app.use(express.static('public'));

let games = {};

io.on('connection', (socket) => {
  socket.playerId = null;
  socket.emit('updateGameList', games);

  socket.on('hostGame', ({ name, playerId }) => {
    if (!name || !playerId) return;
    socket.playerId = playerId;
    let roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
    while (games[roomId]) roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
    
    // Create room. players[0] is always the Host.
    games[roomId] = { id: roomId, name: name, players: [playerId] };
    socket.join(roomId);
    socket.emit('joinedRoom', games[roomId]);
    io.emit('updateGameList', games);
  });

  socket.on('joinGame', ({ roomId, playerId }) => {
    if (!roomId || !playerId || !games[roomId]) return;
    socket.playerId = playerId;
    socket.join(roomId);
    if (!games[roomId].players.includes(playerId)) {
      games[roomId].players.push(playerId); // players[1] is the Joiner
    }
    io.to(roomId).emit('playerUpdate', games[roomId].players);
    socket.emit('joinedRoom', games[roomId]);
    io.emit('updateGameList', games);
  });

  socket.on('joinAsProjector', ({ roomId, ownerId }) => {
    if (games[roomId]) socket.join(roomId);
  });

  socket.on('leaveGame', (roomId) => {
    if (!games[roomId]) return;
    socket.leave(roomId);
    games[roomId].players = games[roomId].players.filter(p => p !== socket.playerId);
    if (games[roomId].players.length === 0) delete games[roomId];
    else io.to(roomId).emit('playerUpdate', games[roomId].players);
    socket.emit('backToLobby');
    io.emit('updateGameList', games);
  });

  // --- STANDARD GAMEPLAY RELAYS ---
  socket.on('sendImage', ({ roomId, image }) => {
    if (!roomId || !image || !games[roomId]) return;
    io.to(roomId).emit('receiveImage', { image: image, senderId: socket.playerId });
  });

  socket.on('rollDice', ({ roomId, dice, senderId }) => {
    if (!roomId || !games[roomId]) return;
    io.to(roomId).emit('diceRolled', { dice, senderId });
  });

  socket.on('setProjectorViewMode', ({ roomId, ownerId, mode }) => {
    io.to(roomId).emit('projectorViewMode', { ownerId, mode });
  });

  socket.on('setProjectorGrid', ({ roomId, ownerId, enabled, width, height }) => {
    io.to(roomId).emit('projectorGrid', { ownerId, enabled, width: parseInt(width) || 50, height: parseInt(height) || 50 });
  });

  socket.on('setProjectorBlank', ({ roomId, ownerId, blank }) => {
    io.to(roomId).emit('projectorBlank', { ownerId, blank: !!blank });
  });

  socket.on('setFieldAlign', (data) => {
    if (data.roomId) io.to(data.roomId).emit('fieldAlign', data);
  });

  // --- THE NEW GLOBAL START TRIGGERS ---
  socket.on('triggerGlobalStart', (roomId) => {
    io.to(roomId).emit('globalStartCommand');
  });

  socket.on('triggerGlobalStop', (roomId) => {
    io.to(roomId).emit('globalStopCommand');
  });

  socket.on('disconnect', () => {
    if (!socket.playerId) return;
    let changed = false;
    for (const roomId of Object.keys(games)) {
      const room = games[roomId];
      if (room.players.includes(socket.playerId)) {
        room.players = room.players.filter(p => p !== socket.playerId);
        changed = true;
        if (room.players.length === 0) delete games[roomId];
        else io.to(roomId).emit('playerUpdate', room.players);
      }
    }
    if (changed) io.emit('updateGameList', games);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
