const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

// Increase limit for image data
const io = new Server(server, {
  maxHttpBufferSize: 1e8 // 100 MB
});

app.use(express.static('public'));

let games = {}; 

io.on('connection', (socket) => {
  socket.emit('updateGameList', games);

  // 1. HOST
  socket.on('hostGame', (name) => {
    const roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
    games[roomId] = { id: roomId, name: name, players: [socket.id.substr(0,4)] };
    socket.join(roomId);
    socket.emit('joinedRoom', games[roomId]);
    io.emit('updateGameList', games);
  });

  // 2. JOIN
  socket.on('joinGame', (roomId) => {
    if (games[roomId]) {
        socket.join(roomId);
        games[roomId].players.push(socket.id.substr(0,4));
        io.to(roomId).emit('playerUpdate', games[roomId].players);
        socket.emit('joinedRoom', games[roomId]);
        io.emit('updateGameList', games); 
    }
  });

  // 3. LEAVE
  socket.on('leaveGame', (roomId) => {
    if (games[roomId]) {
        socket.leave(roomId);
        games[roomId].players = games[roomId].players.filter(p => p !== socket.id.substr(0,4));
        if (games[roomId].players.length === 0) {
            delete games[roomId];
        } else {
            io.to(roomId).emit('playerUpdate', games[roomId].players);
        }
        socket.emit('backToLobby');
        io.emit('updateGameList', games);
    }
  });

  // 4. IMAGE HANDLING (New!)
  socket.on('sendImage', ({ roomId, image }) => {
    // Send this image to EVERYONE in the room (including the sender)
    io.to(roomId).emit('receiveImage', image);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
