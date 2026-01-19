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

let games = {};

io.on('connection', (socket) => {
  socket.playerId = null;
  socket.emit('updateGameList', games);

  // HOST
  socket.on('hostGame', ({ name, playerId }) => {
    if (!name || !playerId) return;
    socket.playerId = playerId;

    let roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
    while (games[roomId]) roomId = Math.random().toString(36).substr(2, 5).toUpperCase();

    games[roomId] = { id: roomId, name: name, players: [playerId] };
    socket.join(roomId);
    socket.emit('joinedRoom', games[roomId]);
    io.emit('updateGameList', games);
  });

  // JOIN
  socket.on('joinGame', ({ roomId, playerId }) => {
    if (!roomId || !playerId || !games[roomId]) return;
    socket.playerId = playerId;
    socket.join(roomId);

    if (!games[roomId].players.includes(playerId)) {
        games[roomId].players.push(playerId);
    }

    io.to(roomId).emit('playerUpdate', games[roomId].players);
    socket.emit('joinedRoom', games[roomId]);
    io.emit('updateGameList', games);
  });

  // JOIN AS PROJECTOR (Silent)
  socket.on('joinAsProjector', (roomId) => {
    if (games[roomId]) {
        socket.join(roomId);
        console.log(`Projector joined room ${roomId}`);
    }
  });

  // LEAVE
  socket.on('leaveGame', (roomId) => {
    if (!games[roomId]) return;
    socket.leave(roomId);
    games[roomId].players = games[roomId].players.filter(p => p !== socket.playerId);

    if (games[roomId].players.length === 0) {
      delete games[roomId];
    } else {
      io.to(roomId).emit('playerUpdate', games[roomId].players);
    }
    socket.emit('backToLobby');
    io.emit('updateGameList', games);
  });

  // IMAGE HANDLING (Modified for Cross-Fire)
  socket.on('sendImage', ({ roomId, image }) => {
    if (!roomId || !image || !games[roomId]) return;
    
    // We attach the SENDER'S ID to the package
    // This allows the projector to say "Oh, this is my owner, ignore it"
    io.to(roomId).emit('receiveImage', { 
        image: image, 
        senderId: socket.playerId 
    });
  });

  // DISCONNECT
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
