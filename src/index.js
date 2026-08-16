require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn, execSync } = require('child_process');
const PocketBaseModule = require('pocketbase');
const PocketBase = PocketBaseModule.default || PocketBaseModule.PocketBase || PocketBaseModule;
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());
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

// ---------- S3 Client ----------
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
  } catch { return false; }
}
async function s3Get(key) {
  if (!BUCKET) return null;
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await data.Body?.transformToString();
  } catch { return null; }
}

// ---------- Connection Manager ----------
const connections = new Map();

async function loadConnections() {
  const data = await s3Get(KEY);
  if (data) {
    for (const conn of JSON.parse(data)) connections.set(conn.id, conn);
    console.log(`Loaded ${connections.size} connections from S3`);
  }
}

async function saveConnections() {
  const arr = Array.from(connections.values());
  const saved = await s3Put(KEY, JSON.stringify(arr, null, 2));
  if (saved) console.log('Saved connections to S3');
  else console.log('Failed to save connections');
}

async function addConnection({ type, name, url, email, password, token, localUrl }) {
  const id = randomUUID();
  const conn = { id, type, name: name || type, url: url.replace(/\/$/, ''), email, password, token, localUrl, createdAt: new Date().toISOString() };
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
  return Array.from(connections.values()).map(({ password, token, localUrl, ...safe }) => safe);
}

// ---------- Local PocketBase Instances ----------
const instances = new Map(); // name -> { port, process, dir, connId }

async function startLocalInstance(conn) {
  const existing = instances.get(conn.name);
  if (existing) return existing;

  const dir = `./pb_instances/${conn.name}`;
  fs.mkdirSync(dir, { recursive: true });

  // Restore from S3 if exists
  const dbData = await s3Get(`backends/${conn.name}/data.db`);
  if (dbData) {
    // S3 stores as JSON string, but we need binary. We'll store as base64
    const base64 = JSON.parse(dbData).base64;
    fs.writeFileSync(path.join(dir, 'data.db'), Buffer.from(base64, 'base64'));
  }

  // Find free port
  const net = require('net');
  let port = 8091;
  while (true) {
    const server = net.createServer();
    const isFree = await new Promise(resolve => {
      server.once('error', () => resolve(false));
      server.once('listening', () => { server.close(() => resolve(true)); });
      server.listen(port, '127.0.0.1');
    });
    if (isFree) break;
    port++;
  }

  const pbBinary = './pocketbase';
  if (!fs.existsSync(pbBinary)) throw new Error('pocketbase binary not found');

  const child = spawn(pbBinary, ['serve', `--http=127.0.0.1:${port}`, `--dir=${dir}`], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  await new Promise(resolve => setTimeout(resolve, 3000));

  instances.set(conn.name, { port, process: child, dir, connId: conn.id });
  return { port, url: `http://127.0.0.1:${port}` };
}

async function persistInstance(name) {
  const inst = instances.get(name);
  if (!inst) return;
  const dbFile = path.join(inst.dir, 'data.db');
  if (fs.existsSync(dbFile)) {
    const base64 = fs.readFileSync(dbFile).toString('base64');
    await s3Put(`backends/${name}/data.db`, JSON.stringify({ base64 }));
    console.log(`Persisted ${name} to S3`);
  }
}

// Adapters (same as before, but using localUrl for internal operations)
class PocketBaseAdapter {
  constructor(conn) { this.conn = conn; this.pb = new PocketBase(conn.localUrl || conn.url); this.pb.autoCancellation(false); }
  async auth() {
    if (this.pb.authStore.isValid) return;
    if (this.conn.token) { this.pb.authStore.save(this.conn.token, null); return; }
    if (!this.conn.email || !this.conn.password) throw new Error('PocketBase requires email/password or token');
    try { await this.pb.collection('_superusers').authWithPassword(this.conn.email, this.conn.password); }
    catch { await this.pb.admins.authWithPassword(this.conn.email, this.conn.password); }
  }
  async list(collection, query = {}) { await this.auth(); return this.pb.collection(collection).getList(query.page || 1, query.perPage || 30, { filter: query.filter || '', sort: query.sort || '' }); }
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
  async callEdgeFunction(name, payload) { await this.auth(); return this.pb.send(`/api/functions/${name}`, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' } }); }
}

class RestAdapter {
  constructor(conn) { this.conn = conn; this.baseUrl = conn.url.replace(/\/$/, ''); this.token = conn.token; }
  async auth() {
    if (this.token) return;
    if (this.conn.email && this.conn.password) {
      const res = await fetch(`${this.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: this.conn.email, password: this.conn.password }) });
      if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
      const data = await res.json();
      this.token = data.token || data.access_token || data.data?.token;
      if (!this.token) throw new Error('Token not found');
    } else throw new Error('REST backend requires email/password or token');
  }
  async request(path, options = {}) {
    await this.auth();
    const headers = { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...options.headers };
    const res = await fetch(`${this.baseUrl}${path}`, { ...options, headers });
    if (!res.ok) throw new Error(`Request failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  list(collection, query = {}) { const qs = new URLSearchParams(query).toString(); return this.request(`/api/collections/${collection}/records${qs ? `?${qs}` : ''}`); }
  create(collection, data) { return this.request(`/api/collections/${collection}/records`, { method: 'POST', body: JSON.stringify(data) }); }
  update(collection, id, data) { return this.request(`/api/collections/${collection}/records/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); }
  delete(collection, id) { return this.request(`/api/collections/${collection}/records/${id}`, { method: 'DELETE' }); }
  getCollections() { return this.request('/api/collections'); }
  createCollection(schema) { return this.request('/api/collections', { method: 'POST', body: JSON.stringify(schema) }); }
  callEdgeFunction(name, payload) { return this.request(`/api/functions/${name}`, { method: 'POST', body: JSON.stringify(payload) }); }
}

function getAdapter(conn) { return conn.type === 'pocketbase' ? new PocketBaseAdapter(conn) : new RestAdapter(conn); }

// LLM Agent (same as before)
async function interpretCommand(message, conns) {
  if (!config.llm.apiKey) throw new Error('AGENT_LLM_API_KEY not set');
  const system = `You are BluBase Agent. Convert user request to JSON action.
Available backends: ${JSON.stringify(conns.map(c => ({ id: c.id, name: c.name, type: c.type, url: c.url })))}.
Actions:
- provision_backend: {action:"provision_backend", name:"optional-name"}
- connect: {action:"connect", backend:"pocketbase|silobase|custom", name, url, email, password, token}
- list_collections: {action:"list_collections", backend:"name|id"}
- create_collection: {action:"create_collection", backend, schema:{name, type:"base", schema:[{name, type:"text"}]}}
- list_records: {action:"list_records", backend, collection, query:{page,perPage,filter,sort}}
- create_record: {action:"create_record", backend, collection, data:{}}
- update_record: {action:"update_record", backend, collection, id, data:{}}
- delete_record: {action:"delete_record", backend, collection, id}
- call_edge_function: {action:"call_edge_function", backend, function, data:{}}
- help: {action:"help", message}
Return ONLY JSON.`;
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
    body: JSON.stringify({ model: config.llm.model, messages: [{ role: 'system', content: system }, { role: 'user', content: message }], temperature: 0.1, response_format: { type: 'json_object' } })
  });
  if (!res.ok) throw new Error(`LLM error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  return JSON.parse(content);
}

async function runAgent(message) {
  const conns = Array.from(connections.values());
  const action = await interpretCommand(message, conns);
  switch (action.action) {
    case 'provision_backend': {
      return await provisionLocalBackend(action.name);
    }
    case 'connect': {
      if (!action.url) throw new Error('Connect requires url');
      const conn = await addConnection({ type: action.backend || 'custom', name: action.name, url: action.url, email: action.email, password: action.password, token: action.token });
      if (conn.type === 'pocketbase') {
        await startLocalInstance(conn);
        conn.localUrl = (await startLocalInstance(conn)).url;
        await saveConnections();
      }
      const adapter = getAdapter(conn);
      await adapter.auth();
      return { success: true, message: `Connected ${conn.name} (${conn.type})`, connection: { id: conn.id, type: conn.type, name: conn.name, url: conn.url } };
    }
    case 'list_collections': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      return { success: true, backend: conn.name, collections: await adapter.getCollections() };
    }
    case 'create_collection': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      return { success: true, backend: conn.name, result: await adapter.createCollection(action.schema) };
    }
    case 'list_records': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      return { success: true, backend: conn.name, collection: action.collection, records: await adapter.list(action.collection || '', action.query) };
    }
    case 'create_record': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      const result = await adapter.create(action.collection || '', action.data);
      await persistInstance(conn.name);
      return { success: true, backend: conn.name, collection: action.collection, record: result };
    }
    case 'update_record': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      const result = await adapter.update(action.collection || '', action.id || '', action.data);
      await persistInstance(conn.name);
      return { success: true, backend: conn.name, collection: action.collection, record: result };
    }
    case 'delete_record': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      await adapter.delete(action.collection || '', action.id || '');
      await persistInstance(conn.name);
      return { success: true, backend: conn.name, collection: action.collection, deletedId: action.id };
    }
    case 'call_edge_function': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      return { success: true, backend: conn.name, function: action.function, result: await adapter.callEdgeFunction(action.function || '', action.data || {}) };
    }
    case 'help':
      return { success: false, message: action.message || 'Please clarify.' };
    default:
      throw new Error('Unknown action');
  }
}

function findBackend(backend) {
  if (backend) {
    const conn = getConnection(backend);
    if (conn) return conn;
  }
  const all = Array.from(connections.values());
  if (all.length === 1) return all[0];
  throw new Error(backend ? `Backend "${backend}" not found` : 'No backend specified and multiple backends available');
}

// Provisioning: create local PocketBase instance and expose via path URL
async function provisionLocalBackend(name = '') {
  const serviceName = (name || 'pb-' + Date.now()).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const adminEmail = 'admin@' + serviceName + '.com';
  const adminPassword = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

  const dir = `./pb_instances/${serviceName}`;
  fs.mkdirSync(dir, { recursive: true });

  // Find free port
  const net = require('net');
  let port = 8091;
  while (true) {
    const server = net.createServer();
    const isFree = await new Promise(resolve => {
      server.once('error', () => resolve(false));
      server.once('listening', () => { server.close(() => resolve(true)); });
      server.listen(port, '127.0.0.1');
    });
    if (isFree) break;
    port++;
  }

  const pbBinary = './pocketbase';
  if (!fs.existsSync(pbBinary)) throw new Error('pocketbase binary not found');

  const child = spawn(pbBinary, ['serve', `--http=127.0.0.1:${port}`, `--dir=${dir}`], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  await new Promise(resolve => setTimeout(resolve, 3000));

  try {
    execSync(`${pbBinary} admin create ${adminEmail} ${adminPassword} --dir=${dir}`, { stdio: 'ignore' });
  } catch (e) {}

  const publicUrl = `https://blubase-agent.onrender.com/backend/${serviceName}`;
  const conn = await addConnection({
    type: 'pocketbase',
    name: serviceName,
    url: publicUrl,
    email: adminEmail,
    password: adminPassword,
    localUrl: `http://127.0.0.1:${port}`
  });

  instances.set(serviceName, { port, process: child, dir, connId: conn.id });

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

// ---------- Proxy route for /backend/:name ----------
app.use('/backend/:name', async (req, res, next) => {
  const name = req.params.name;
  const inst = instances.get(name);
  if (!inst) return res.status(404).json({ error: 'Backend not found' });
  const target = `http://127.0.0.1:${inst.port}${req.url.replace(`/backend/${name}`, '') || '/'}`;
  try {
    const fetchRes = await fetch(target, {
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${inst.port}` },
      body: ['GET','HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const data = await fetchRes.text();
    res.status(fetchRes.status).set('Content-Type', fetchRes.headers.get('content-type') || 'application/json').send(data);
  } catch (err) {
    next(err);
  }
});

// ---------- API routes (same as before) ----------
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'blubase-agent', connections: listConnections() }));

app.use((req, res, next) => {
  if (!config.apiKey) return next();
  if (req.header('x-api-key') !== config.apiKey) return res.status(401).json({ error: 'Invalid or missing x-api-key header' });
  next();
});

app.post('/connect', async (req, res, next) => {
  try {
    const { backend, name, url, email, password, token } = req.body;
    if (!backend || !url) return res.status(400).json({ error: 'backend and url are required' });
    const conn = await addConnection({ type: backend, name, url, email, password, token });
    if (backend === 'pocketbase') {
      await startLocalInstance(conn);
      conn.localUrl = (await startLocalInstance(conn)).url;
      await saveConnections();
    }
    const adapter = getAdapter(conn);
    await adapter.auth();
    res.json({ success: true, connection: { id: conn.id, type: conn.type, name: conn.name, url: conn.url } });
  } catch (err) { next(err); }
});

app.get('/connections', (_req, res) => res.json(listConnections()));

app.post('/agent/command', async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    res.json(await runAgent(message));
  } catch (err) { next(err); }
});

app.post('/provision', async (req, res, next) => {
  try {
    const { name } = req.body;
    res.json(await provisionLocalBackend(name));
  } catch (err) { next(err); }
});

app.get('/proxy/:backend/:collection', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); res.json(await adapter.list(req.params.collection, req.query)); } catch (err) { next(err); }
});
app.post('/proxy/:backend/:collection', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); res.status(201).json(await adapter.create(req.params.collection, req.body)); await persistInstance(conn.name); } catch (err) { next(err); }
});
app.patch('/proxy/:backend/:collection/:id', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); res.json(await adapter.update(req.params.collection, req.params.id, req.body)); await persistInstance(conn.name); } catch (err) { next(err); }
});
app.delete('/proxy/:backend/:collection/:id', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); await adapter.delete(req.params.collection, req.params.id); await persistInstance(conn.name); res.json({ success: true }); } catch (err) { next(err); }
});

app.get('/meta/:backend/collections', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); res.json(await adapter.getCollections()); } catch (err) { next(err); }
});
app.post('/meta/:backend/collections', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); res.status(201).json(await adapter.createCollection(req.body)); } catch (err) { next(err); }
});

app.post('/edge/:backend/:function', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); res.json(await adapter.callEdgeFunction(req.params.function, req.body || {})); } catch (err) { next(err); }
});

app.get('/', (_req, res) => res.json({
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
    backend: 'GET|POST|PATCH|DELETE /backend/:name/*'
  }
}));

app.use((err, _req, res, _next) => {
  console.error('ERROR:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Startup: load connections, start local instances
(async () => {
  await loadConnections();
  for (const conn of connections.values()) {
    if (conn.type === 'pocketbase' && conn.localUrl) {
      try {
        await startLocalInstance(conn);
        console.log(`Started local instance ${conn.name}`);
      } catch (e) {
        console.error(`Failed to start ${conn.name}:`, e.message);
      }
    }
  }
  app.listen(config.port, () => console.log(`🚀 BluBase Agent running on port ${config.port}`));
})();
