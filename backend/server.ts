import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:5173", // React app URL
    methods: ["GET", "POST"]
  }
});

// Enable CORS for Express routes
app.use(cors());

app.get('/', (req, res) => {
  res.send('Hello World');
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Handle joining a room
  socket.on('join-room', (roomCode: string) => {
    socket.join(roomCode);
    console.log(`User ${socket.id} joined room ${roomCode}`);
    socket.to(roomCode).emit('user-connected', socket.id);
  });

  // Handle WebRTC signaling
  socket.on('offer', ({ roomCode, offer, to }: { roomCode: string; offer: any; to: string }) => {
    console.log(`Relaying offer from ${socket.id} to ${to}`);
    io.to(to).emit('offer', { offer, from: socket.id });
  });

  socket.on('answer', ({ roomCode, answer, to }: { roomCode: string; answer: any; to: string }) => {
    console.log(`Relaying answer from ${socket.id} to ${to}`);
    io.to(to).emit('answer', { answer, from: socket.id });
  });

  socket.on('ice-candidate', ({ roomCode, candidate, to }: { roomCode: string; candidate: any; to: string }) => {
    console.log(`Relaying ICE candidate from ${socket.id} to ${to}`);
    io.to(to).emit('ice-candidate', { candidate, from: socket.id });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    io.emit('user-disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 