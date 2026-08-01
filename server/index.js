const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const analyzeRoutes = require('./routes/analyze');
const sessionsRoutes = require('./routes/sessions');
const setupSocket = require('./socket');

const app = express();
const server = http.createServer(app);
const io = setupSocket(server);

// Make io accessible in routes
app.set('io', io);

// Basic middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../Frontend')));

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/analyze', analyzeRoutes);
app.use('/api/v1/sessions', sessionsRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
