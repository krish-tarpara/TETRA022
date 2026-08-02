const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

function setupSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  const analysisNamespace = io.of('/analysis');

  analysisNamespace.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (err) {
      next(new Error('Authentication error'));
    }
  });

  analysisNamespace.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on('analysis:start', ({ sessionId }) => {
      console.log(`Socket ${socket.id} joining session: ${sessionId}`);
      socket.join(`session:${sessionId}`);
    });

    socket.on('rejoin', ({ sessionId }) => {
      console.log(`Socket ${socket.id} rejoining session: ${sessionId}`);
      socket.join(`session:${sessionId}`);
    });

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });

  return io;
}

module.exports = setupSocket;
