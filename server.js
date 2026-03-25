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
    db = createMockDB();
    return db;
  }
  try {
    const client = new MongoClient(MONGODB_URI, {
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000
    });
    await client.connect();
    db = client.db(DATABASE_NAME);
    console.log('✅ Connected to MongoDB Atlas');
    return db;
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    db = createMockDB(); // Fallback to mock if DB fails
    return db;
  }
}

function createMockDB() {
  return {
    collection: (name) => ({
      find: (query = {}) => {
        let results = mockStore[name] || [];
        if (query.trackerId) results = results.filter(r => r.trackerId === query.trackerId);
        if (query.id) results = results.filter(r => r.id === query.id);
        return {
          toArray: async () => results,
          limit: (n) => ({ toArray: async () => results.slice(0, n) })
        };
      },
      findOne: async (query) => {
        const store = mockStore[name] || [];
        if (query.id) return store.find(r => r.id === query.id);
        if (query.trackerId) return store.find(r => r.trackerId === query.trackerId);
        return null;
      },
      insertOne: async (doc) => { (mockStore[name] = mockStore[name] || []).push(doc); return { insertedId: doc.id }; },
      updateOne: async (query, update) => {
        const store = mockStore[name] || [];
        const doc = store.find(r => r.id === query.id);
        if (doc && update.$set) Object.assign(doc, update.$set);
        return { modifiedCount: 1 };
      },
      deleteOne: async (query) => {
        const store = mockStore[name] || [];
        const idx = store.findIndex(r => r.id === query.id);
        if (idx !== -1) store.splice(idx, 1);
        return { deletedCount: 1 };
      },
      deleteMany: async (query) => {
        if (query.trackerId) {
          mockStore[name] = (mockStore[name] || []).filter(r => r.trackerId !== query.trackerId);
        }
        return { deletedCount: 1 };
      },
      countDocuments: async (query) => {
        const store = mockStore[name] || [];
        return store.filter(r => r.trackerId === query.trackerId).length;
      }
    })
  };
}

async function getCollection(name) {
  try {
    const database = await connectDB();
    return database.collection(name);
  } catch (e) {
    console.error('Collection Access Error:', e.message);
    return createMockDB().collection(name);
  }
}

// ── Unified Helpers ──────────────────────────────────────────

async function getTracker(id) {
  try {
    const col = await getCollection('trackers');
    return await col.findOne({ id });
  } catch (e) {
    return null;
  }
}

// Helper to check if a session is currently active (last update < 3 minutes ago)
function isSessionActive(session) {
  if (!session || !session.lastSeen) return false;
  const lastUpdate = new Date(session.lastSeen);
  return (new Date() - lastUpdate) < 180000;
}

async function updateTrackerLocation(trackerId, sessionId, entry) {
  try {
    const sCol = await getCollection('sessions');
    const lCol = await getCollection('locations');
    
    await sCol.updateOne(
      { trackerId, sessionId },
      { $set: { lastLocation: entry, lastSeen: new Date().toISOString() } },
      { upsert: true }
    );

    await lCol.insertOne({ trackerId, sessionId, ...entry });
    io.to(`tracker:${trackerId}`).emit('location-received', { trackerId, sessionId, location: entry });
    return true;
  } catch (e) {
    console.error('Update Location Error:', e);
    return false;
  }
}

async function addPhoto(trackerId, sessionId, photo) {
  try {
    const pCol = await getCollection('photos');
    await pCol.insertOne({ trackerId, sessionId, ...photo });
    io.to(`tracker:${trackerId}`).emit('photo-received', { trackerId, sessionId, photo });
    return true;
  } catch (e) {
    console.error('Add Photo Error:', e);
    return false;
  }
}

async function updateDeviceInfo(trackerId, sessionId, info) {
  try {
    const sCol = await getCollection('sessions');
    await sCol.updateOne(
      { trackerId, sessionId },
      { $set: { deviceInfo: info, lastSeen: new Date().toISOString() } },
      { upsert: true }
    );
    io.to(`tracker:${trackerId}`).emit('session-updated', { trackerId, sessionId, info });
    return true;
  } catch (e) {
    console.error('Update Device Error:', e);
    return false;
  }
}

// ── API Routes (Serverless Friendly) ──────────────────────────

app.post('/api/tracker/:id/location', async (req, res) => {
  try {
    const { sessionId, latitude, longitude, accuracy, altitude, speed, heading } = req.body;
    const entry = { latitude, longitude, accuracy, altitude, speed, heading, timestamp: new Date().toISOString() };
    const success = await updateTrackerLocation(req.params.id, sessionId || 'default', entry);
    res.json({ success });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tracker/:id/photo', async (req, res) => {
  try {
    const { sessionId, image, facing } = req.body;
    const entry = { image, facing, timestamp: new Date().toISOString() };
    const success = await addPhoto(req.params.id, sessionId || 'default', entry);
    res.json({ success });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tracker/:id/info', async (req, res) => {
  try {
    const { sessionId, info } = req.body;
    const success = await updateDeviceInfo(req.params.id, sessionId || 'default', info);
    res.json({ success });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API Routes (Standard) ────────────────────────────────────

app.post('/api/tracker/create', async (req, res) => {
  try {
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
    
    // Fixed link generation for Vercel (prefer HTTPS)
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const link = `${protocol}://${host}/track/${id}`;
    
    res.json({ success: true, tracker, link });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trackers', async (req, res) => {
  try {
    const col = await getCollection('trackers');
    const sCol = await getCollection('sessions');
    const all = await col.find({}).toArray();
    for (const t of all) {
      const sessions = await sCol.find({ trackerId: t.id }).toArray();
      t.sessionCount = sessions.length;
      t.active = sessions.some(s => isSessionActive(s));
    }
    res.json(all);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tracker/:id', async (req, res) => {
  try {
    const tracker = await getTracker(req.params.id);
    if (!tracker) return res.status(404).json({ error: 'Tracker not found' });
    
    const sCol = await getCollection('sessions');
    const lCol = await getCollection('locations');
    const pCol = await getCollection('photos');
    
    const result = { ...tracker };
    result.sessions = await sCol.find({ trackerId: req.params.id }).toArray();
    result.locations = await lCol.find({ trackerId: req.params.id }).limit(200).toArray();
    result.photos = await pCol.find({ trackerId: req.params.id }).limit(100).toArray();
    
    for (const s of result.sessions) {
      s.active = isSessionActive(s);
    }
    
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tracker/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const col = await getCollection('trackers');
    const sCol = await getCollection('sessions');
    const lCol = await getCollection('locations');
    const pCol = await getCollection('photos');

    await col.deleteOne({ id });
    await sCol.deleteMany({ trackerId: id });
    await lCol.deleteMany({ trackerId: id });
    await pCol.deleteMany({ trackerId: id });
    
    io.emit('tracker-deleted', id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Socket.io (Hybrid) ──────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('join-tracker', async (trackerId) => {
    try {
      socket.join(`tracker:${trackerId}`);
      socket.trackerId = trackerId;
      const tracker = await getTracker(trackerId);
      if (tracker) {
        await updateDeviceInfo(trackerId, tracker.deviceInfo || {});
      }
    } catch (e) {}
  });

  socket.on('watch-tracker', (trackerId) => {
    socket.join(`tracker:${trackerId}`);
  });

  socket.on('join-tracker', (trackerId) => {
    socket.join(`tracker:${trackerId}`);
  });

  socket.on('location-update', async (data) => {
    try {
      const { trackerId, sessionId, ...coords } = data;
      const entry = { ...coords, timestamp: new Date().toISOString() };
      await updateTrackerLocation(trackerId, sessionId || 'default', entry);
    } catch (e) {}
  });

  socket.on('photo-capture', async (data) => {
    try {
      const { trackerId, sessionId, ...photo } = data;
      const entry = { ...photo, timestamp: new Date().toISOString() };
      await addPhoto(trackerId, sessionId || 'default', entry);
    } catch (e) {}
  });

  socket.on('device-info', async (data) => {
    try {
      await updateDeviceInfo(data.trackerId, data.sessionId || 'default', data.info);
    } catch (e) {}
  });

  socket.on('disconnect', async () => {
    // Ephemeral connections on serverless
  });
});

// ── Track page route ────────────────────────────────────────
app.get('/track/:id', async (req, res) => {
  try {
    const tracker = await getTracker(req.params.id);
    if (!tracker) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
    
    // Auto-online on page load
    const tCol = await getCollection('trackers');
    await tCol.updateOne({ id: req.params.id }, { $set: { active: true } });
    
    res.sendFile(path.join(__dirname, 'public', 'track.html'));
  } catch (e) {
    res.status(500).send("Critical error loading track page");
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🟢 Location Tracker Dashboard running at http://localhost:${PORT}\n`);
});
