require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn, execSync } = require('child_process');
const PocketBaseModule = require('pocketbase');
const PocketBase = PocketBaseModule.default || PocketBaseModule.PocketBase || PocketBaseModule;
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const memory = require('./memory');
const firebaseRoutes = require('./routes/firebaseRoutes');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
  credentials: false,
  optionsSuccessStatus: 200
}));
app.options('*', cors());
app.use(express.json());

const config = {
  port: process.env.PORT || 3000,
  apiKey: process.env.BLUBASE_API_KEY || '',
  llm: {
    apiKey: process.env.AGENT_LLM_API_KEY || '',
    baseUrl: (process.env.AGENT_LLM_BASE_URL || 'https://api.mistral.ai/v1').replace(/\/$/, ''),
    model: process.env.AGENT_LLM_MODEL || 'mistral-small-latest'
  }
};

// ============================================================
// S3
// ============================================================
const s3 = new S3Client({
  region: process.env.IDRIVE_E2_REGION || 'us-west-4',
  endpoint: process.env.IDRIVE_E2_ENDPOINT || 'https://s3.us-west-4.idrivee2.com',
  credentials: {
    accessKeyId: process.env.IDRIVE_E2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.IDRIVE_E2_SECRET_ACCESS_KEY || ''
  },
  forcePathStyle: true
});
const BUCKET = process.env.IDRIVE_E2_BUCKET_NAME || '';
const KEY = 'connections.json';

async function s3Put(key, body) {
  if (!BUCKET) return false;
  try {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'application/json' }));
    return true;
  } catch (e) { console.error('[S3] put failed:', e.message); return false; }
}
async function s3Get(key) {
  if (!BUCKET) return null;
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await data.Body?.transformToString();
  } catch (e) { return null; }
}

// ============================================================
// Connections
// ============================================================
const connections = new Map();
const CONN_FILE = './data/connections.json';

async function loadConnections() {
  const data = await s3Get(KEY);
  if (data) {
    try {
      for (const conn of JSON.parse(data)) connections.set(conn.id, conn);
      console.log('Loaded ' + connections.size + ' connections from S3');
      return;
    } catch (e) { console.error('[Connections] S3 parse failed:', e.message); }
  }
  if (fs.existsSync(CONN_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(CONN_FILE, 'utf8'));
      for (const conn of arr) connections.set(conn.id, conn);
      console.log('Loaded ' + connections.size + ' connections from local file');
    } catch (e) {}
  }
}

async function saveConnections() {
  const arr = Array.from(connections.values());
  const ok = await s3Put(KEY, JSON.stringify(arr, null, 2));
  if (!ok) {
    try {
      if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
      fs.writeFileSync(CONN_FILE, JSON.stringify(arr, null, 2));
    } catch (e) {}
  }
}

async function addConnection({ type, name, url, email, password, token, userId }) {
  const id = randomUUID();
  const conn = { id, type, name: name || type, url: url.replace(/\/$/, ''), email, password, token, userId: userId || null, createdAt: new Date().toISOString() };
  connections.set(id, conn);
  await saveConnections();
  return conn;
}

function getConnection(idOrName) {
  for (const conn of connections.values()) {
    if (conn.id === idOrName || conn.name === idOrName || conn.type === idOrName) return conn;
  }
  return undefined;
}

function listConnections() {
  return Array.from(connections.values()).map(({ password, token, ...safe }) => safe);
}

// ============================================================
// Adapters
// ============================================================
class PocketBaseAdapter {
  constructor(conn) {
    this.conn = conn;
    this.pb = new PocketBase(conn.localUrl || conn.url);
    this.pb.autoCancellation(false);
  }
  async auth() {
    if (this.pb.authStore.isValid) return;
    if (this.conn.token) { this.pb.authStore.save(this.conn.token, null); return; }
    if (!this.conn.email || !this.conn.password) throw new Error('PocketBase requires email/password or token');
    try { await this.pb.collection('_superusers').authWithPassword(this.conn.email, this.conn.password); }
    catch (e) { await this.pb.admins.authWithPassword(this.conn.email, this.conn.password); }
  }
  async list(collection, query) {
    await this.auth();
    query = query || {};
    return this.pb.collection(collection).getList(query.page || 1, query.perPage || 30, { filter: query.filter || '', sort: query.sort || '' });
  }
  async create(collection, data) { await this.auth(); return this.pb.collection(collection).create(data); }
  async update(collection, id, data) { await this.auth(); return this.pb.collection(collection).update(id, data); }
  async delete(collection, id) { await this.auth(); return this.pb.collection(collection).delete(id); }
  async getCollections() { await this.auth(); return this.pb.collections.getFullList(); }
  async createCollection(schema) {
    await this.auth();
    if (schema.fields && !schema.schema) { schema.schema = schema.fields; delete schema.fields; }
    if (!schema.type) schema.type = 'base';
    if (!schema.schema) schema.schema = [];
    return this.pb.collections.create(schema);
  }
  async callEdgeFunction(name, payload) {
    await this.auth();
    return this.pb.send('/api/functions/' + name, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' } });
  }
}

class RestAdapter {
  constructor(conn) { this.conn = conn; this.baseUrl = conn.url.replace(/\/$/, ''); this.token = conn.token; }
  async auth() {
    if (this.token) return;
    if (!this.conn.email || !this.conn.password) throw new Error('REST backend requires email/password or token');
    const res = await fetch(this.baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: this.conn.email, password: this.conn.password })
    });
    if (!res.ok) throw new Error('Auth failed: ' + res.status);
    const data = await res.json();
    this.token = data.token || data.access_token || (data.data && data.data.token);
    if (!this.token) throw new Error('Token not found');
  }
  async request(p, options) {
    await this.auth();
    options = options || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, this.token ? { Authorization: 'Bearer ' + this.token } : {}, options.headers || {});
    const res = await fetch(this.baseUrl + p, Object.assign({}, options, { headers }));
    if (!res.ok) throw new Error('Request failed: ' + res.status + ' ' + (await res.text()));
    return res.json();
  }
  list(collection, query) {
    const qs = new URLSearchParams(query || {}).toString();
    return this.request('/api/collections/' + collection + '/records' + (qs ? '?' + qs : ''));
  }
  create(collection, data) { return this.request('/api/collections/' + collection + '/records', { method: 'POST', body: JSON.stringify(data) }); }
  update(collection, id, data) { return this.request('/api/collections/' + collection + '/records/' + id, { method: 'PATCH', body: JSON.stringify(data) }); }
  delete(collection, id) { return this.request('/api/collections/' + collection + '/records/' + id, { method: 'DELETE' }); }
  getCollections() { return this.request('/api/collections'); }
  createCollection(schema) { return this.request('/api/collections', { method: 'POST', body: JSON.stringify(schema) }); }
  callEdgeFunction(name, payload) { return this.request('/api/functions/' + name, { method: 'POST', body: JSON.stringify(payload) }); }
}

function getAdapter(conn) {
  return conn.type === 'pocketbase' ? new PocketBaseAdapter(conn) : new RestAdapter(conn);
}

// ============================================================
// LLM
// ============================================================
async function interpretCommand(message, conns, context) {
  context = context || {};
  if (!config.llm.apiKey) throw new Error('AGENT_LLM_API_KEY not set');
  const system = 'You are BluBase Agent, an AI backend manager with memory. You remember which backends the user owns, their previous conversation, and can perform follow-up actions.\n\n' +
    'Convert the user request to a JSON action.\n\n' +
    'Available backends: ' + JSON.stringify(conns.map(function(c) { return { id: c.id, name: c.name, type: c.type, url: c.url }; })) + '\n' +
    'User owned backends: ' + JSON.stringify(context.userBackends || []) + '\n' +
    'User ID: ' + (context.userId || 'anonymous') + '\n' +
    'Recent conversation: ' + (context.history || []).length + ' messages\n\n' +
    'Actions:\n' +
    '- provision_backend: {action:"provision_backend", name:"optional-name", backendType:"pocketbase|firebase"}\n' +
    '- list_user_backends: {action:"list_user_backends"}\n' +
    '- connect: {action:"connect", backend:"pocketbase|silobase|custom", name, url, email, password, token}\n' +
    '- list_collections: {action:"list_collections", backend:"name|id"}\n' +
    '- create_collection: {action:"create_collection", backend, schema:{name, type:"base", schema:[{name, type:"text"}]}}\n' +
    '- list_records: {action:"list_records", backend, collection, query:{page,perPage,filter,sort}}\n' +
    '- create_record: {action:"create_record", backend, collection, data:{}}\n' +
    '- update_record: {action:"update_record", backend, collection, id, data:{}}\n' +
    '- delete_record: {action:"delete_record", backend, collection, id}\n' +
    '- call_edge_function: {action:"call_edge_function", backend, function, data:{}}\n' +
    '- suggest_next_steps: {action:"suggest_next_steps", backend}\n' +
    '- help: {action:"help", message}\n\n' +
    'IMPORTANT RULES:\n' +
    '- If user asks "what backends do I have", "list my backends", "my apps", "my projects" => you MUST return {"action":"list_user_backends"}. Never answer in prose.\n' +
    '- If user asks to list collections of a backend => {"action":"list_collections","backend":"name"}.\n' +
    '- If user says "add/create a collection" => {"action":"create_collection","backend":"<name or omit if one backend>","schema":{...}}.\n' +
    '- If user references "my backend" and only has ONE, use it.\n' +
    '- If user references "my backend" and has MULTIPLE, use most recent.\n\n' +
    'Return ONLY JSON.';

  const models = [config.llm.model, 'mistral-tiny-latest', 'open-mistral-7b'];
  const uniqueModels = Array.from(new Set(models));
  let lastError = null;

  for (let mi = 0; mi < uniqueModels.length; mi++) {
    const model = uniqueModels[mi];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const messages = [{ role: 'system', content: system }];
        const history = context.history || [];
        for (let h = 0; h < history.length; h++) {
          const m = history[h];
          messages.push({ role: m.role === 'agent' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
        }
        messages.push({ role: 'user', content: message });

        const res = await fetch(config.llm.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.llm.apiKey },
          body: JSON.stringify({ model: model, messages: messages, temperature: 0.1, response_format: { type: 'json_object' } })
        });

        if (res.status === 429) {
          console.log('Rate limit hit on ' + model + ', retrying...');
          await new Promise(function(r) { setTimeout(r, 2000); });
          lastError = 'rate_limited';
          continue;
        }
        if (!res.ok) {
          lastError = 'LLM error: ' + res.status + ' ' + (await res.text());
          break;
        }
        const data = await res.json();
        const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';
        return JSON.parse(content);
      } catch (err) {
        lastError = err.message;
        await new Promise(function(r) { setTimeout(r, 1000); });
      }
    }
  }
  throw new Error('All LLM models failed: ' + lastError);
}

// ============================================================
// findBackend
// ============================================================
function findBackend(backend) {
  if (backend) {
    const c = getConnection(backend);
    if (c) return c;
  }
  const all = Array.from(connections.values());
  if (all.length === 1) return all[0];
  throw new Error(backend ? 'Backend "' + backend + '" not found' : 'No backend specified and multiple backends available');
}

// ============================================================
// Provisioning
// ============================================================
async function provisionLocalBackend(name, baseUrl) {
  name = name || '';
  baseUrl = baseUrl || 'https://blubase-agent-1.onrender.com';
  const serviceName = (name || ('pb-' + Date.now())).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const dir = './pb_instances/' + serviceName;
  if (fs.existsSync(dir)) throw new Error('Instance already exists: ' + serviceName);
  fs.mkdirSync(dir, { recursive: true });

  // Find free port
  const net = require('net');
  let port = 8091;
  while (true) {
    const server = net.createServer();
    const isFree = await new Promise(function(resolve) {
      server.once('error', function() { resolve(false); });
      server.once('listening', function() { server.close(function() { resolve(true); }); });
      server.listen(port, '127.0.0.1');
    });
    if (isFree) break;
    port++;
  }

  const adminEmail = 'admin@' + serviceName + '.com';
  const adminPassword = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const pbBinary = './pocketbase';
  if (!fs.existsSync(pbBinary)) throw new Error('pocketbase binary not found');

  const child = spawn(pbBinary, ['serve', '--http=127.0.0.1:' + port, '--dir=' + dir], { detached: true, stdio: 'ignore' });
  child.unref();
  await new Promise(function(r) { setTimeout(r, 3000); });

  try {
    execSync(pbBinary + ' admin create ' + adminEmail + ' ' + adminPassword + ' --dir=' + dir, { stdio: 'ignore' });
  } catch (e) {}

  const publicUrl = baseUrl + '/backend/' + serviceName;
  const conn = await addConnection({
    type: 'pocketbase',
    name: serviceName,
    url: publicUrl,
    email: adminEmail,
    password: adminPassword,
    token: null,
    userId: null
  });
  // Store localUrl on the connection object for internal adapter use
  const fullConn = connections.get(conn.id);
  fullConn.localUrl = 'http://127.0.0.1:' + port;
  await saveConnections();

  return {
    success: true,
    message: 'Backend created',
    connection: {
      id: conn.id,
      type: conn.type,
      name: conn.name,
      url: publicUrl,
      email: adminEmail,
      password: adminPassword
    }
  };
}

// ============================================================
// runAgent
// ============================================================
async function runAgent(message, req, userId, sessionId) {
  const conns = Array.from(connections.values());
  const session = sessionId ? await memory.getSession(sessionId) : { messages: [] };
  const userBackends = userId ? await memory.getUserBackends(userId) : [];
  const context = { userId: userId, userBackends: userBackends, history: session.messages.slice(-6) };

  if (sessionId && userId) {
    await memory.addSessionMessage(sessionId, userId, 'user', message);
  }

  // Deterministic short-circuit for "list my backends"
  const lm = (message || '').toLowerCase();
  if (/(what|which|list|show).*(backends?|apps?|projects?).*(have|owned|mine)/.test(lm) || /^my (backends|apps|projects)$/.test(lm.trim())) {
    const r = { success: true, userId: userId, backends: userBackends, count: userBackends.length };
    if (sessionId && userId) await memory.addSessionMessage(sessionId, userId, 'agent', r);
    return r;
  }

  let action;
  try {
    action = await interpretCommand(message, conns, context);
  } catch (err) {
    console.error('LLM unavailable:', err.message);
    if (lm.includes('create') && (lm.includes('backend') || lm.includes('app'))) {
      const cleanName = message.replace(/.*for (?:my )?/i, '').trim();
      const r = await provisionLocalBackend(cleanName, req ? (req.get('x-forwarded-proto') || 'https') + '://' + req.get('host') : undefined);
      return r;
    }
    return { success: false, message: 'AI is temporarily rate-limited. Try again in 30 seconds.', llmError: err.message };
  }

  let result;
  switch (action.action) {
    case 'provision_backend': {
      const proto = (req && (req.get('x-forwarded-proto') || 'https')) || 'https';
      const baseUrl = req ? proto + '://' + req.get('host') : 'https://blubase-agent-1.onrender.com';
      const provResult = await provisionLocalBackend(action.name, baseUrl);
      if (provResult.success && provResult.connection) {
        await memory.linkUserBackend(userId, {
          name: provResult.connection.name,
          type: provResult.connection.type,
          url: provResult.connection.url
        });
      }
      result = Object.assign({}, provResult, {
        nextSteps: [
          'Create your first collection: "add a tasks collection with title and done fields"',
          'List your backends: "what backends do I have?"',
          'Connect your frontend to: ' + (provResult.connection ? provResult.connection.url : '')
        ]
      });
      break;
    }
    case 'list_user_backends': {
      result = { success: true, userId: userId, backends: userBackends, count: userBackends.length };
      break;
    }
    case 'suggest_next_steps': {
      const c = findBackend(action.backend);
      result = {
        success: true,
        backend: c.name,
        nextSteps: [
          'Create a collection in ' + c.name,
          'List collections: "show collections in ' + c.name + '"',
          'Connect your frontend: ' + c.url
        ]
      };
      break;
    }
    case 'connect': {
      if (!action.url) throw new Error('Connect requires url');
      const conn = await addConnection({ type: action.backend || 'custom', name: action.name, url: action.url, email: action.email, password: action.password, token: action.token, userId: userId });
      const adapter = getAdapter(conn);
      await adapter.auth();
      result = { success: true, message: 'Connected ' + conn.name + ' (' + conn.type + ')', connection: { id: conn.id, type: conn.type, name: conn.name, url: conn.url } };
      break;
    }
    case 'list_collections': {
      const c = findBackend(action.backend);
      const adapter = getAdapter(c);
      result = { success: true, backend: c.name, collections: await adapter.getCollections() };
      break;
    }
    case 'create_collection': {
      const c = findBackend(action.backend);
      const adapter = getAdapter(c);
      result = { success: true, backend: c.name, result: await adapter.createCollection(action.schema) };
      break;
    }
    case 'list_records': {
      const c = findBackend(action.backend);
      const adapter = getAdapter(c);
      result = { success: true, backend: c.name, collection: action.collection, records: await adapter.list(action.collection || '', action.query) };
      break;
    }
    case 'create_record': {
      const c = findBackend(action.backend);
      const adapter = getAdapter(c);
      result = { success: true, backend: c.name, collection: action.collection, record: await adapter.create(action.collection || '', action.data) };
      break;
    }
    case 'update_record': {
      const c = findBackend(action.backend);
      const adapter = getAdapter(c);
      result = { success: true, backend: c.name, collection: action.collection, record: await adapter.update(action.collection || '', action.id || '', action.data) };
      break;
    }
    case 'delete_record': {
      const c = findBackend(action.backend);
      const adapter = getAdapter(c);
      await adapter.delete(action.collection || '', action.id || '');
      result = { success: true, backend: c.name, collection: action.collection, deletedId: action.id };
      break;
    }
    case 'call_edge_function': {
      const c = findBackend(action.backend);
      const adapter = getAdapter(c);
      result = { success: true, backend: c.name, function: action.function, result: await adapter.callEdgeFunction(action.function || '', action.data || {}) };
      break;
    }
    case 'help':
      result = { success: false, message: action.message || 'Please clarify.' };
      break;
    default:
      throw new Error('Unknown action: ' + action.action);
  }

  if (sessionId && userId && result) {
    await memory.addSessionMessage(sessionId, userId, 'agent', result);
  }
  return result;
}

// ============================================================
// Middleware
// ============================================================
function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();
  if (req.header('x-api-key') !== config.apiKey) return res.status(401).json({ error: 'Invalid or missing x-api-key header' });
  next();
}

// ============================================================
// Routes
// ============================================================
app.get('/health', function(_req, res) {
  res.json({ status: 'ok', service: 'blubase-agent', connections: listConnections() });
});

app.use(requireApiKey);

app.post('/connect', async function(req, res, next) {
  try {
    const b = req.body;
    if (!b.backend || !b.url) return res.status(400).json({ error: 'backend and url are required' });
    const conn = await addConnection({ type: b.backend, name: b.name, url: b.url, email: b.email, password: b.password, token: b.token });
    const adapter = getAdapter(conn);
    await adapter.auth();
    res.json({ success: true, connection: { id: conn.id, type: conn.type, name: conn.name, url: conn.url } });
  } catch (err) { next(err); }
});

app.get('/connections', function(_req, res) { res.json(listConnections()); });

app.post('/agent/command', async function(req, res, next) {
  try {
    const b = req.body;
    if (!b.message) return res.status(400).json({ error: 'message is required' });
    const sid = b.sessionId || ('sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    const response = await runAgent(b.message, req, b.userId, sid);
    res.json(Object.assign({}, response, { sessionId: sid }));
  } catch (err) { next(err); }
});

app.post('/provision', async function(req, res, next) {
  try {
    const proto = req.get('x-forwarded-proto') || 'https';
    const baseUrl = proto + '://' + req.get('host');
    res.json(await provisionLocalBackend(req.body && req.body.name, baseUrl));
  } catch (err) { next(err); }
});

app.get('/proxy/:backend/:collection', async function(req, res, next) {
  try { const c = findBackend(req.params.backend); res.json(await getAdapter(c).list(req.params.collection, req.query)); } catch (err) { next(err); }
});
app.post('/proxy/:backend/:collection', async function(req, res, next) {
  try { const c = findBackend(req.params.backend); res.status(201).json(await getAdapter(c).create(req.params.collection, req.body)); } catch (err) { next(err); }
});
app.patch('/proxy/:backend/:collection/:id', async function(req, res, next) {
  try { const c = findBackend(req.params.backend); res.json(await getAdapter(c).update(req.params.collection, req.params.id, req.body)); } catch (err) { next(err); }
});
app.delete('/proxy/:backend/:collection/:id', async function(req, res, next) {
  try { const c = findBackend(req.params.backend); await getAdapter(c).delete(req.params.collection, req.params.id); res.json({ success: true }); } catch (err) { next(err); }
});

app.get('/meta/:backend/collections', async function(req, res, next) {
  try { const c = findBackend(req.params.backend); res.json(await getAdapter(c).getCollections()); } catch (err) { next(err); }
});
app.post('/meta/:backend/collections', async function(req, res, next) {
  try { const c = findBackend(req.params.backend); res.status(201).json(await getAdapter(c).createCollection(req.body)); } catch (err) { next(err); }
});

app.post('/edge/:backend/:function', async function(req, res, next) {
  try { const c = findBackend(req.params.backend); res.json(await getAdapter(c).callEdgeFunction(req.params.function, req.body || {})); } catch (err) { next(err); }
});

// Multi-tenant backend proxy: /backend/:name -> internal local instance
app.use('/backend/:name', async function(req, res, next) {
  const name = req.params.name;
  const c = getConnection(name);
  if (!c || !c.localUrl) return res.status(404).json({ error: 'Backend not found or not running' });
  const targetPath = req.originalUrl.replace('/backend/' + name, '') || '/';
  try {
    const headers = Object.assign({}, req.headers);
    delete headers['host'];
    delete headers['content-length'];
    const opts = { method: req.method, headers: headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      opts.body = req.rawBody || JSON.stringify(req.body);
    }
    const r = await fetch(c.localUrl + targetPath, opts);
    const text = await r.text();
    res.status(r.status);
    r.headers.forEach(function(v, k) { if (k.toLowerCase() !== 'content-encoding' && k.toLowerCase() !== 'content-length') res.set(k, v); });
    res.send(text);
  } catch (err) { next(err); }
});

// Firebase routes
app.use('/agent/firebase', firebaseRoutes);

app.get('/', function(_req, res) {
  res.json({
    service: 'BluBase Agent',
    endpoints: {
      health: 'GET /health',
      connect: 'POST /connect',
      connections: 'GET /connections',
      agent: 'POST /agent/command',
      provision: 'POST /provision',
      proxy: 'GET|POST|PATCH|DELETE /proxy/:backend/:collection',
      meta: 'GET|POST /meta/:backend/collections',
      edge: 'POST /edge/:backend/:function',
      backend: 'ANY /backend/:name/*',
      firebase: 'POST /agent/firebase/*'
    }
  });
});

app.use(function(err, _req, res, _next) {
  console.error('ERROR:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ============================================================
// Startup
// ============================================================
(async function() {
  await loadConnections();
  app.listen(config.port, '0.0.0.0', function() {
    console.log('🚀 BluBase Agent running on PORT ' + config.port);
  });
})();
