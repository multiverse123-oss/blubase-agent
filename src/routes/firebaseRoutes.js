const express = require('express');
const { db, auth, isReady, firebaseConfig, FieldValue } = require('../firebase');

const router = express.Router();

// Simple in-memory rate limiter
const rateLimiter = new Map();
function checkRateLimit(projectId, limit = 100, windowMs = 60000) {
  const now = Date.now();
  const entry = rateLimiter.get(projectId) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
  entry.count++;
  rateLimiter.set(projectId, entry);
  return entry.count <= limit;
}

function requireFirebase(req, res, next) {
  if (!isReady()) return res.status(503).json({ error: 'Firebase unavailable' });
  next();
}

const TEMPLATES = {
  crud: {
    users: [
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
      { name: 'Carol', email: 'carol@example.com' }
    ],
    items: [
      { title: 'First item', done: false },
      { title: 'Second item', done: false },
      { title: 'Third item', done: true }
    ]
  },
  chat: {
    messages: [
      { text: 'Welcome to the chat!', author: 'system' },
      { text: 'Hello everyone', author: 'user1' }
    ]
  },
  ecommerce: {
    products: [
      { name: 'Widget', price: 9.99 },
      { name: 'Gadget', price: 19.99 }
    ],
    orders: [{ productId: 'seed-1', status: 'pending' }]
  }
};

router.post('/provision', requireFirebase, async (req, res) => {
  try {
    const { firebaseUid, projectId, projectName, template = 'blank' } = req.body;
    if (!projectId || !firebaseUid) {
      return res.status(400).json({ error: 'projectId and firebaseUid required' });
    }

    const existing = await db.collection('user_projects').where('projectId', '==', projectId).limit(1).get();
    if (!existing.empty) {
      const doc = existing.docs[0];
      return res.json({
        ok: true, firebaseProjectId: 'multiverse-backends', firebaseConfig,
        userProjectsDocId: doc.id, seededCollections: [], existed: true
      });
    }

    const docRef = await db.collection('user_projects').add({
      userId: firebaseUid,
      projectId,
      name: projectName || 'Untitled Project',
      firebaseConfig,
      collections: [],
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    const seededCollections = [];
    if (template !== 'blank' && TEMPLATES[template]) {
      const tpl = TEMPLATES[template];
      for (const [collName, docs] of Object.entries(tpl)) {
        for (const d of docs) {
          await db.collection('project_data').add({
            projectId, collectionName: collName, data: d, createdBy: firebaseUid,
            createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
          });
        }
        seededCollections.push(collName);
      }
      await db.collection('user_projects').doc(docRef.id).update({ collections: seededCollections });
    }

    await db.collection('project_logs').add({
      projectId, userId: firebaseUid, action: 'firebase_provisioned',
      details: { template }, createdAt: FieldValue.serverTimestamp()
    });

    res.json({
      ok: true, firebaseProjectId: 'multiverse-backends', firebaseConfig,
      userProjectsDocId: docRef.id, seededCollections
    });
  } catch (err) {
    console.error('[Firebase] provision error:', err);
    res.status(500).json({ error: 'Provision failed' });
  }
});

router.post('/query', requireFirebase, async (req, res) => {
  try {
    const { projectId, collectionName, limit = 50 } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    if (!checkRateLimit(projectId)) return res.status(429).json({ error: 'Rate limit exceeded' });

    let q = db.collection('project_data').where('projectId', '==', projectId);
    if (collectionName) q = q.where('collectionName', '==', collectionName);
    q = q.limit(Math.min(limit, 500));

    const snap = await q.get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    await db.collection('project_logs').add({
      projectId, userId: 'agent', action: 'agent_query',
      details: { collectionName, limit }, createdAt: FieldValue.serverTimestamp()
    });

    res.json({ ok: true, count: docs.length, docs });
  } catch (err) {
    console.error('[Firebase] query error:', err);
    res.status(500).json({ error: 'Query failed' });
  }
});

router.post('/write', requireFirebase, async (req, res) => {
  try {
    const { projectId, collectionName, data, firebaseUid, action = 'create', docId } = req.body;
    if (!projectId || !collectionName || !firebaseUid) {
      return res.status(400).json({ error: 'projectId, collectionName, firebaseUid required' });
    }
    if (!checkRateLimit(projectId)) return res.status(429).json({ error: 'Rate limit exceeded' });

    let resultDocId = docId;

    if (action === 'create') {
      const ref = await db.collection('project_data').add({
        projectId, collectionName, data: data || {}, createdBy: firebaseUid,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
      resultDocId = ref.id;
    } else if (action === 'update') {
      if (!docId) return res.status(400).json({ error: 'docId required for update' });
      const ref = db.collection('project_data').doc(docId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Doc not found' });
      await ref.update({ data: data || {}, updatedAt: FieldValue.serverTimestamp() });
    } else if (action === 'delete') {
      if (!docId) return res.status(400).json({ error: 'docId required for delete' });
      const ref = db.collection('project_data').doc(docId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Doc not found' });
      await ref.delete();
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }

    await db.collection('project_logs').add({
      projectId, userId: firebaseUid, action: 'agent_write',
      details: { collectionName, action }, createdAt: FieldValue.serverTimestamp()
    });

    res.json({ ok: true, docId: resultDocId });
  } catch (err) {
    console.error('[Firebase] write error:', err);
    res.status(500).json({ error: 'Write failed' });
  }
});

router.post('/create-auth-user', requireFirebase, async (req, res) => {
  try {
    const { projectId, email, password, displayName } = req.body;
    if (!projectId || !email) return res.status(400).json({ error: 'projectId and email required' });

    const userRecord = await auth.createUser({ email, password, displayName });

    await db.collection('project_users').add({
      projectId, firebaseUid: userRecord.uid, email,
      displayName: displayName || '', createdAt: FieldValue.serverTimestamp(),
      lastLogin: null, metadata: {}
    });

    await db.collection('project_logs').add({
      projectId, userId: userRecord.uid, action: 'end_user_created',
      details: { email }, createdAt: FieldValue.serverTimestamp()
    });

    res.json({ ok: true, uid: userRecord.uid, email });
  } catch (err) {
    console.error('[Firebase] create-auth-user error:', err);
    res.status(500).json({ error: err.message || 'Create user failed' });
  }
});

router.get('/status/:projectId', requireFirebase, async (req, res) => {
  try {
    const { projectId } = req.params;
    const upSnap = await db.collection('user_projects').where('projectId', '==', projectId).limit(1).get();

    if (upSnap.empty) {
      return res.json({
        provisioned: false, firebaseProjectId: 'multiverse-backends',
        firebaseConfig: null, dataDocCount: 0, analyticsEventCount: 0, userProjectsDocId: null
      });
    }

    const upDoc = upSnap.docs[0];
    const dataCount = await db.collection('project_data').where('projectId', '==', projectId).count().get();
    const analyticsCount = await db.collection('project_analytics').where('projectId', '==', projectId).count().get();

    res.json({
      provisioned: true, firebaseProjectId: 'multiverse-backends', firebaseConfig,
      dataDocCount: dataCount.data().count,
      analyticsEventCount: analyticsCount.data().count,
      userProjectsDocId: upDoc.id
    });
  } catch (err) {
    console.error('[Firebase] status error:', err);
    res.status(500).json({ error: 'Status check failed' });
  }
});

router.post('/deprovision', requireFirebase, async (req, res) => {
  try {
    const { projectId, soft = true } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    const upSnap = await db.collection('user_projects').where('projectId', '==', projectId).get();

    if (soft) {
      for (const doc of upSnap.docs) {
        await doc.ref.update({ status: 'archived', updatedAt: FieldValue.serverTimestamp() });
      }
    } else {
      for (const doc of upSnap.docs) await doc.ref.delete();
      const dataSnap = await db.collection('project_data').where('projectId', '==', projectId).get();
      for (const doc of dataSnap.docs) await doc.ref.delete();
      const logSnap = await db.collection('project_logs').where('projectId', '==', projectId).get();
      for (const doc of logSnap.docs) await doc.ref.delete();
    }

    await db.collection('project_logs').add({
      projectId, userId: 'agent', action: 'firebase_deprovisioned',
      details: { soft }, createdAt: FieldValue.serverTimestamp()
    });

    res.json({ ok: true, soft });
  } catch (err) {
    console.error('[Firebase] deprovision error:', err);
    res.status(500).json({ error: 'Deprovision failed' });
  }
});

module.exports = router;
