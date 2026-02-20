const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

// Increase limit for image data to 100MB to prevent crashes on big photos
const io = new Server(server, {
  maxHttpBufferSize: 1e8 
});

app.use(express.static('public'));

let games = {};

io.on('connection', (socket) => {
  socket.playerId = null;
  
  // Send the list of games to the new user
  socket.emit('updateGameList', games);

  // 1. HOST GAME
  socket.on('hostGame', ({ name, playerId }) => {
    if (!name || !playerId) return;
    socket.playerId = playerId;

    // Generate unique Room ID
    let roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
    while (games[roomId]) {
      roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
    }

    games[roomId] = { id: roomId, name: name, players: [playerId] };
    socket.join(roomId);
    socket.emit('joinedRoom', games[roomId]);
    io.emit('updateGameList', games);
  });

  // 2. JOIN GAME
  socket.on('joinGame', ({ roomId, playerId }) => {
    if (!roomId || !playerId) return;
    if (!games[roomId]) return;

    socket.playerId = playerId;
    socket.join(roomId);

    // Only add to list if not already there
    if (!games[roomId].players.includes(playerId)) {
        games[roomId].players.push(playerId);
    }

    io.to(roomId).emit('playerUpdate', games[roomId].players);
    socket.emit('joinedRoom', games[roomId]);
    io.emit('updateGameList', games);
  });

  // 3. JOIN AS PROJECTOR (Silent Mode)
  socket.on('joinAsProjector', ({ roomId, ownerId }) => {
    if (games[roomId]) {
        socket.join(roomId);
        console.log(`Projector joined room ${roomId} for owner ${ownerId}`);
    }
  });

  // 4. LEAVE GAME
  socket.on('leaveGame', (roomId) => {
    if (!games[roomId]) return;
    socket.leave(roomId);
    
    // Remove player ID
    games[roomId].players = games[roomId].players.filter(p => p !== socket.playerId);

    if (games[roomId].players.length === 0) {
      delete games[roomId];
    } else {
      io.to(roomId).emit('playerUpdate', games[roomId].players);
    }
    socket.emit('backToLobby');
    io.emit('updateGameList', games);
  });

  // 5. IMAGE HANDLING
  socket.on('sendImage', ({ roomId, image }) => {
    if (!roomId || !image || !games[roomId]) return;
    io.to(roomId).emit('receiveImage', { 
        image: image, 
        senderId: socket.playerId 
    });
  });

  // 6. DICE HANDLING
  socket.on('rollDice', ({ roomId, dice, senderId }) => {
    if (!roomId || !games[roomId]) return;
    io.to(roomId).emit('diceRolled', { dice, senderId });
  });

  // 7. PROJECTOR VIEW MODES (Calibration)
  socket.on('setProjectorViewMode', ({ roomId, ownerId, mode }) => {
    io.to(roomId).emit('projectorViewMode', { mode });
  });

  // 8. PROJECTOR GRID
  socket.on('setProjectorGrid', ({ roomId, ownerId, enabled, width, height }) => {
    io.to(roomId).emit('projectorGrid', { 
        ownerId: ownerId,
        enabled, 
        width: parseInt(width) || 50, 
        height: parseInt(height) || 50 
    });
  });

  // 9. PROJECTOR BLANKING
  socket.on('setProjectorBlank', ({ roomId, ownerId, blank }) => {
    io.to(roomId).emit('projectorBlank', { blank });
  });

  // 10. INCOMING IMAGE ALIGNMENT (X, Y, Z, Rotate)
  socket.on('setReceiverTransform', ({ roomId, ownerId, transform }) => {
    // Send alignment data ONLY to this player's projector
    io.to(roomId).emit('receiverTransform', { ownerId, transform });
  });

  // 11. DISCONNECT CLEANUP
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
