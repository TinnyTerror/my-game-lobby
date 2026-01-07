const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(express.static('public'));

let games = {}; 

io.on('connection', (socket) => {
  // Send list to new user
  socket.emit('updateGameList', games);

  // 1. HOST GAME
  socket.on('hostGame', (name) => {
    const roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
    
    games[roomId] = { 
        id: roomId, 
        name: name, 
        players: [socket.id.substr(0,4)] // Add host to list
    };
    
    socket.join(roomId);
    socket.emit('joinedRoom', games[roomId]); // Send host to waiting room
    io.emit('updateGameList', games); // Update everyone's lobby list
  });

  // 2. JOIN GAME
  socket.on('joinGame', (roomId) => {
    if (games[roomId]) {
        socket.join(roomId);
        games[roomId].players.push(socket.id.substr(0,4));
        
        // Update everyone in the room
        io.to(roomId).emit('playerUpdate', games[roomId].players);
        
        // Move the joiner to the waiting room screen
        socket.emit('joinedRoom', games[roomId]);
        
        // Update lobby counts for people outside
        io.emit('updateGameList', games); 
    }
  });

  // 3. LEAVE GAME (New Feature)
  socket.on('leaveGame', (roomId) => {
    if (games[roomId]) {
        socket.leave(roomId);

        // Remove player from the list
        games[roomId].players = games[roomId].players.filter(p => p !== socket.id.substr(0,4));

        if (games[roomId].players.length === 0) {
            // If room is empty, delete it
            delete games[roomId];
        } else {
            // If people remain, tell them someone left
            io.to(roomId).emit('playerUpdate', games[roomId].players);
        }

        // Send the leaver back to lobby
        socket.emit('backToLobby');
        
        // Update global game list
        io.emit('updateGameList', games);
    }
  });

  // 4. DISCONNECT (Browser closed)
  socket.on('disconnect', () => {
    // Ideally, we would find which room they were in and remove them
    // For this simple test, we rely on the game resetting eventually
    console.log('User disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
