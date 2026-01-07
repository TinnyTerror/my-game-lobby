const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(express.static('public'));

let games = {}; 

io.on('connection', (socket) => {
  socket.emit('updateGameList', games);

  socket.on('hostGame', (name) => {
    const roomId = Math.random().toString(36).substr(2, 5);
    games[roomId] = { id: roomId, name: name, players: [socket.id.substr(0,4)] };
    socket.join(roomId);
    socket.emit('joinedRoom', games[roomId]);
    io.emit('updateGameList', games);
  });

  socket.on('joinGame', (roomId) => {
    if (games[roomId]) {
        socket.join(roomId);
        games[roomId].players.push(socket.id.substr(0,4));
        io.to(roomId).emit('playerUpdate', games[roomId].players);
        socket.emit('joinedRoom', games[roomId]);
        io.emit('updateGameList', games); 
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
