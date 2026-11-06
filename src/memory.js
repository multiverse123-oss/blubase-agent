const fs = require('fs');
let firebaseDb = null;
try {
  const fb = require('./firebase');
  if (fb.isReady()) firebaseDb = fb.db;
} catch (e) { /* Firebase optional */ }

const MEMORY_FILE = './data/memory.json';
let memStore = { sessions: {}, userBackends: {} };

if (fs.existsSync(MEMORY_FILE)) {
  try { memStore = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch (e) {}
}

function saveLocal() {
  try {
    if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memStore, null, 2));
  } catch (e) { console.error('[Memory] local save failed:', e.message); }
}

async function saveToFirestore(path, data) {
  if (!firebaseDb) return false;
  try {
    await firebaseDb.doc(path).set(data, { merge: true });
    return true;
  } catch (e) { console.error('[Memory] firestore save failed:', e.message); return false; }
}

async function getFromFirestore(path) {
  if (!firebaseDb) return null;
  try {
    const doc = await firebaseDb.doc(path).get();
    return doc.exists ? doc.data() : null;
  } catch (e) { return null; }
}

async function addSessionMessage(sessionId, userId, role, content) {
  if (!memStore.sessions[sessionId]) {
    memStore.sessions[sessionId] = { messages: [], userId, createdAt: new Date().toISOString() };
  }
  memStore.sessions[sessionId].messages.push({ role, content, at: new Date().toISOString() });
  // Keep last 20
  if (memStore.sessions[sessionId].messages.length > 20) {
    memStore.sessions[sessionId].messages = memStore.sessions[sessionId].messages.slice(-20);
  }
  saveLocal();
  saveToFirestore(`agent_sessions/${sessionId}`, {
    userId, messages: memStore.sessions[sessionId].messages,
    updatedAt: new Date().toISOString()
  });
}

async function getSession(sessionId) {
  if (memStore.sessions[sessionId]) return memStore.sessions[sessionId];
  const remote = await getFromFirestore(`agent_sessions/${sessionId}`);
  if (remote) { memStore.sessions[sessionId] = remote; return remote; }
  return { messages: [] };
}

async function linkUserBackend(userId, backendInfo) {
  if (!userId) return;
  if (!memStore.userBackends[userId]) memStore.userBackends[userId] = [];
  const exists = memStore.userBackends[userId].find(b => b.name === backendInfo.name && b.type === backendInfo.type);
  if (!exists) {
    memStore.userBackends[userId].push({ ...backendInfo, linkedAt: new Date().toISOString() });
  } else {
    // Update existing entry
    Object.assign(exists, backendInfo);
  }
  saveLocal();
  saveToFirestore(`agent_users/${userId}`, {
    backends: memStore.userBackends[userId],
    updatedAt: new Date().toISOString()
  });
}

async function getUserBackends(userId) {
  if (!userId) return [];
  if (memStore.userBackends[userId]) return memStore.userBackends[userId];
  const remote = await getFromFirestore(`agent_users/${userId}`);
  if (remote && remote.backends) {
    memStore.userBackends[userId] = remote.backends;
    return remote.backends;
  }
  return [];
}

module.exports = { addSessionMessage, getSession, linkUserBackend, getUserBackends };
