const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

// Increase limit for high-res image data
const io = new Server(server, { maxHttpBufferSize: 1e8 });

app.use(express.static('public'));

// Standard turn interval: 10 seconds per player = 20 second total cycle loop
const TURN_DELAY_MS = 10000;

let games = {};
// We need a map to quickly find a socket object by its playerId attached to it
let playerSockets = {};

// Helper:Broadcast room state (who is ready) to the room
function broadcastRoomStatus(roomId) {
    if(!games[roomId]) return;
    const r = games[roomId];
    // Check if both host[0] and joiner[1] are marked ready
    const hostReady = r.readyPlayers.has(r.players[0]);
    const joinerReady = r.players[1] && r.readyPlayers.has(r.players[1]);
    const allReady = hostReady && joinerReady;

    io.to(roomId).emit('roomStatusUpdate', {
      hostReady, joinerReady, allReady, loopActive: r.loopActive
    });
}

// The Central Server Engine Loop
function runGameLoopSync(roomId) {
    const room = games[roomId];
    if (!room || room.players.length < 2 || !room.loopActive) {
        console.log(`Loop stopped for room ${roomId}`);
        if(room) room.loopActive = false;
        return;
    }

    // 0 = Host's Turn, 1 = Joiner's Turn
    const playerIndexStr = (room.turnCount % 2 === 0) ? "HOST" : "JOINER";
    const targetPlayerId = room.players[room.turnCount % 2];
    const targetSocket = playerSockets[targetPlayerId];

    console.log(`Room ${roomId}: Triggering turn ${room.turnCount} (${playerIndexStr} - ${targetPlayerId})`);

    if (targetSocket) {
        // Tell ONLY this specific player to run their capture sequence immediately
        targetSocket.emit('takeSnapshotNow');
    }

    room.turnCount++;

    // Schedule the next turn
    room.loopTimeout = setTimeout(() => runGameLoopSync(roomId), TURN_DELAY_MS);
}


io.on('connection', (socket) => {
  socket.playerId = null;
  socket.emit('updateGameList', games);

  // --- LOBBY & SETUP ---

  socket.on('hostGame', ({ name, playerId }) => {
    if (!name || !playerId) return;
    socket.playerId = playerId;
    playerSockets[playerId] = socket; // Store socket reference

    let roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
    while (games[roomId]) roomId = Math.random().toString(36).substr(2, 5).toUpperCase();

    games[roomId] = {
        id: roomId,
        name: name,
        players: [playerId], // players[0] is ALWAYS Host
        readyPlayers: new Set(),
        loopActive: false,
        turnCount: 0,
        loopTimeout: null
    };

    socket.join(roomId);
    // Tell client they are the host
    socket.emit('joinedRoom', { room: games[roomId], isHost: true });
    io.emit('updateGameList', games);
  });

  socket.on('joinGame', ({ roomId, playerId }) => {
    if (!roomId || !playerId || !games[roomId]) return;
    if (games[roomId].players.length >= 2) return; // Cap at 2 players for now

    socket.playerId = playerId;
    playerSockets[playerId] = socket; // Store socket reference
    socket.join(roomId);

    if (!games[roomId].players.includes(playerId)) {
        games[roomId].players.push(playerId); // players[1] is Joiner
    }

    io.to(roomId).emit('playerUpdate', games[roomId].players);
    // Tell client they are NOT the host
    socket.emit('joinedRoom', { room: games[roomId], isHost: false });
    io.emit('updateGameList', games);
    broadcastRoomStatus(roomId);
  });

  socket.on('joinAsProjector', ({ roomId, ownerId }) => {
    if (games[roomId]) socket.join(roomId);
  });

  // --- GAME LOOP CONTROLS ---

  // Client tells server: "My Camera is on and working"
  socket.on('cameraReadySignal', ({ roomId }) => {
      if(!games[roomId] || !socket.playerId) return;
      games[roomId].readyPlayers.add(socket.playerId);
      broadcastRoomStatus(roomId);
  });

  // Host clicks the "Start Game Loop" button
  socket.on('startGameLoop', ({ roomId }) => {
      const room = games[roomId];
      if(!room || room.players[0] !== socket.playerId) return; // Only host can start

      if(room.loopActive) return; // Already running

      console.log(`Starting game loop for room ${roomId}`);
      room.loopActive = true;
      room.turnCount = 0; // Start fresh with Host turn
      broadcastRoomStatus(roomId); // Update UI to show loop running

      // KICK OFF THE ENGINE
      runGameLoopSync(roomId);
  });

  // Host clicks stop loop
  socket.on('stopGameLoop', ({ roomId }) => {
       const room = games[roomId];
       if(!room || room.players[0] !== socket.playerId) return;
       console.log(`Stopping game loop for room ${roomId}`);
       room.loopActive = false;
       if(room.loopTimeout) clearTimeout(room.loopTimeout);
       broadcastRoomStatus(roomId);
  });


  // --- STANDARD GAMEPLAY EVENTS ---

  socket.on('sendImage', ({ roomId, image }) => {
    if (!roomId || !image || !games[roomId]) return;
    // Broadcast image to opposing player/projector
    io.to(roomId).emit('receiveImage', { image: image, senderId: socket.playerId });
  });

  socket.on('rollDice', ({ roomId, dice, senderId }) => io.to(roomId).emit('diceRolled', { dice, senderId }));
  socket.on('setProjectorViewMode', (data) => io.to(data.roomId).emit('projectorViewMode', data));
  socket.on('setProjectorGrid', (data) => io.to(data.roomId).emit('projectorGrid', data));
  socket.on('setProjectorBlank', (data) => io.to(data.roomId).emit('projectorBlank', data));

  socket.on('setFieldAlign', ({ roomId, ownerId, enabled, x, y, zoom, trapX, trapY, r }) => {
    if (!roomId || !games[roomId]) return;
    io.to(roomId).emit('fieldAlign', {
      ownerId, enabled: !!enabled,
      x: parseInt(x, 10)||0, y: parseInt(y, 10)||0, zoom: parseFloat(zoom)||1.0,
      trapX: parseFloat(trapX)||0, trapY: parseFloat(trapY)||0, r: parseInt(r, 10)||0
    });
  });

  // --- CLEANUP ---
  socket.on('disconnect', () => {
    if (!socket.playerId) return;
    delete playerSockets[socket.playerId]; // Clear socket reference

    let changed = false;
    for (const roomId of Object.keys(games)) {
      const room = games[roomId];
      if (room.players.includes(socket.playerId)) {
        // Stop the loop if someone leaves
        if(room.loopTimeout) clearTimeout(room.loopTimeout);
        room.loopActive = false;
        room.readyPlayers.delete(socket.playerId);

        room.players = room.players.filter(p => p !== socket.playerId);
        changed = true;

        if (room.players.length === 0) delete games[roomId];
        else {
            io.to(roomId).emit('playerUpdate', room.players);
            broadcastRoomStatus(roomId);
        }
      }
    }
    if (changed) io.emit('updateGameList', games);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
