import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:5173", 
    methods: ["GET", "POST"]
  }
});

// Enable CORS for Express routes
app.use(cors());

// Track users in each room
const rooms: { [roomId: string]: string[] } = {};

app.get('/', (req, res) => {
  res.send('Video Calling App Signaling Server');
});

app.get('/stats', (req, res) => {
  res.json({
    rooms: Object.keys(rooms).map(roomId => ({
      roomId,
      users: rooms[roomId].length
    }))
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Handle joining a room
  socket.on('join-room', (roomCode: string) => {
    // Join the room
    socket.join(roomCode);
    
    // Initialize room if it doesn't exist
    if (!rooms[roomCode]) {
      rooms[roomCode] = [];
    }
    
    // Add user to room tracking
    rooms[roomCode].push(socket.id);
    
    console.log(`User ${socket.id} joined room ${roomCode}`);
    console.log(`Room ${roomCode} now has ${rooms[roomCode].length} users:`, rooms[roomCode]);
    
    // Emit to other clients in the room
    socket.to(roomCode).emit('user-connected', socket.id);
    
    // Broadcast current users to the new user
    const otherUsersInRoom = rooms[roomCode].filter(id => id !== socket.id);
    if (otherUsersInRoom.length > 0) {
      console.log(`Notifying ${socket.id} of existing users:`, otherUsersInRoom);
      socket.emit('existing-users', otherUsersInRoom);
    }
  });

  // Handle WebRTC signaling
  socket.on('offer', ({ roomCode, offer, to }: { roomCode: string; offer: any; to: string }) => {
    console.log(`Relaying offer from ${socket.id} to ${to} in room ${roomCode}`);
    io.to(to).emit('offer', { offer, from: socket.id });
  });

  socket.on('answer', ({ roomCode, answer, to }: { roomCode: string; answer: any; to: string }) => {
    console.log(`Relaying answer from ${socket.id} to ${to} in room ${roomCode}`);
    io.to(to).emit('answer', { answer, from: socket.id });
  });

  socket.on('ice-candidate', ({ roomCode, candidate, to }: { roomCode: string; candidate: any; to: string }) => {
    console.log(`Relaying ICE candidate from ${socket.id} to ${to} in room ${roomCode} - type: ${candidate.type || 'unknown'}`);
    io.to(to).emit('ice-candidate', { candidate, from: socket.id });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Find which room the user was in
    for (const roomCode in rooms) {
      const index = rooms[roomCode].indexOf(socket.id);
      if (index !== -1) {
        // Remove user from room
        rooms[roomCode].splice(index, 1);
        console.log(`User ${socket.id} removed from room ${roomCode}`);
        
        // If room is empty, clean it up
        if (rooms[roomCode].length === 0) {
          delete rooms[roomCode];
          console.log(`Room ${roomCode} is now empty and has been removed`);
        } else {
          console.log(`Room ${roomCode} now has ${rooms[roomCode].length} users:`, rooms[roomCode]);
        }
        
        // Notify other users in the room
        io.to(roomCode).emit('user-disconnected', socket.id);
      }
    }
  });
});

const PORT = 3000;
httpServer.listen(PORT, () => {
  console.log(`Signaling server is running on port ${PORT}`);
}); 