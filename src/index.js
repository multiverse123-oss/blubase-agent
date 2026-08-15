require('dotenv').config();
const fs = require('fs');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const express = require('express');
const cors = require('cors');
const PocketBaseModule = require('pocketbase');
const PocketBase = PocketBaseModule.PocketBase || PocketBaseModule.default || PocketBaseModule;
const { randomUUID } = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const config = {
  port: process.env.PORT || 3000,
  apiKey: process.env.BLUBASE_API_KEY || '',
  render: {
    apiKey: process.env.RENDER_API_KEY || '',
    pocketbaseImage: process.env.POCKETBASE_IMAGE || 'pocketbase/pocketbase:latest',
    diskSizeGB: Number(process.env.POCKETBASE_DISK_GB) || 1,
  },
  llm: {
    apiKey: process.env.AGENT_LLM_API_KEY || '',
    baseUrl: (process.env.AGENT_LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: process.env.AGENT_LLM_MODEL || 'gpt-4o-mini'
  }
};

// ---------- Connection Manager ----------
const CONN_FILE = './data/connections.json';
const connections = new Map();

// S3 client for persistence
const s3 = new S3Client({
  region: process.env.IDRIVE_E2_REGION || 'us-west-4',
  endpoint: process.env.IDRIVE_E2_ENDPOINT || 'https://s3.us-west-4.idrivee2.com',
  credentials: {
    accessKeyId: process.env.IDRIVE_E2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.IDRIVE_E2_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: true, // required for iDrive E2
});

const BUCKET = process.env.IDRIVE_E2_BUCKET_NAME || '';
const KEY = 'connections.json';

async function loadFromS3() {
  if (!BUCKET) return null;
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: KEY });
    const data = await s3.send(command);
    const body = await data.Body?.transformToString();
    return JSON.parse(body || '[]');
  } catch (err) {
    console.error('S3 load error:', err.message);
    return null;
  }
}

async function saveToS3(arr) {
  if (!BUCKET) return false;
  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: KEY,
      Body: JSON.stringify(arr, null, 2),
      ContentType: 'application/json',
    });
    await s3.send(command);
    console.log('Saved connections to S3');
    return true;
  } catch (err) {
    console.error('S3 save error:', err.message);
    return false;
  }
}

async function loadConnections() {
  // 1. Try S3 first
  const s3Data = await loadFromS3();
  if (s3Data) {
    for (const conn of s3Data) connections.set(conn.id, conn);
    console.log('Loaded', connections.size, 'connections from S3');
    return;
  }
  // 2. Fallback to local file
  if (fs.existsSync(CONN_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONN_FILE, 'utf8'));
      for (const conn of data) connections.set(conn.id, conn);
      console.log('Loaded', connections.size, 'connections from local file');
    } catch (e) {
      console.error('Failed to load local connections:', e.message);
    }
  }
}

async function saveConnections() {
  const arr = Array.from(connections.values());
  // Save to S3 (and also to local file for dev)
  const s3Saved = await saveToS3(arr);
  if (!s3Saved) {
    if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
    fs.writeFileSync(CONN_FILE, JSON.stringify(arr, null, 2));
    console.log('Saved', arr.length, 'connections to local file');
  }
}

async function addConnection({ type, name, url, email, password, token }) {
  const id = randomUUID();
  const conn = { id, type, name: name || type, url: url.replace(/\/$/, ''), email, password, token, createdAt: new Date().toISOString() };
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

// Preload from env
if (process.env.POCKETBASE_URL) {
  addConnection({ type: 'pocketbase', name: 'pocketbase', url: process.env.POCKETBASE_URL, email: process.env.POCKETBASE_EMAIL, password: process.env.POCKETBASE_PASSWORD, token: process.env.POCKETBASE_TOKEN });
}
if (process.env.SILOBASE_URL) {
  addConnection({ type: 'silobase', name: 'silobase', url: process.env.SILOBASE_URL, email: process.env.SILOBASE_EMAIL, password: process.env.SILOBASE_PASSWORD, token: process.env.SILOBASE_TOKEN });
}
if (process.env.CUSTOM_BACKEND_URL) {
  addConnection({ type: 'custom', name: 'custom', url: process.env.CUSTOM_BACKEND_URL, email: process.env.CUSTOM_BACKEND_EMAIL, password: process.env.CUSTOM_BACKEND_PASSWORD, token: process.env.CUSTOM_BACKEND_TOKEN });
}

// Load any persisted connections (in case env preloads already added some, we'll merge)
(async () => {
  await loadConnections();
  console.log('Connections loaded');
})();

// ---------- Adapters ----------
class PocketBaseAdapter {
  constructor(conn) { this.conn = conn; this.pb = new PocketBase(conn.url); this.pb.autoCancellation(false); }
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
    schema.schema = schema.schema.map(field => ({
      name: field.name,
      type: field.type || 'text',
      required: field.required || false,
      presentable: field.presentable || false,
      unique: field.unique || false,
      options: field.options || {}
    }));
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
      if (!this.token) throw new Error('Token not found in auth response');
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

// ---------- Provisioning ----------
async function provisionBackend(name = '') {
  if (!config.render.apiKey) throw new Error('RENDER_API_KEY not set');
  const serviceName = (name || 'pb-' + Date.now()).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const adminEmail = 'admin@' + serviceName + '.com';
  const adminPassword = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

  const renderBody = {
    type: 'web_service',
    name: serviceName,
    env: 'node',
    plan: 'free',
    region: 'oregon',
    serviceDetails: {
      image: {
        registry: 'docker.io',
        image: config.render.pocketbaseImage.split(':')[0],
        tag: config.render.pocketbaseImage.split(':')[1] || 'latest',
      },
      envVars: [
        { key: 'POCKETBASE_ADMIN_EMAIL', value: adminEmail },
        { key: 'POCKETBASE_ADMIN_PASSWORD', value: adminPassword },
        { key: 'POCKETBASE_HTTP_PORT', value: '80' },
      ],
      disk: {
        name: 'pb-data',
        mountPath: '/pb_data',
        sizeGB: config.render.diskSizeGB,
      },
    },
  };

  const response = await fetch('https://api.render.com/v1/services', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + config.render.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(renderBody),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error('Render API error: ' + response.status + ' ' + text);
  }

  const service = await response.json();
  const serviceId = service.id;

  // Poll for service URL
  let url = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const statusRes = await fetch('https://api.render.com/v1/services/' + serviceId, {
      headers: { 'Authorization': 'Bearer ' + config.render.apiKey },
    });
    if (statusRes.ok) {
      const statusData = await statusRes.json();
      if (statusData.service && statusData.service.serviceDetails && statusData.service.serviceDetails.url) {
        url = statusData.service.serviceDetails.url;
        break;
      }
    }
  }

  if (!url) throw new Error('Timed out waiting for service URL');

  // Connect to the new PocketBase instance
  const conn = await addConnection({
    type: 'pocketbase',
    name: serviceName,
    url: url,
    email: adminEmail,
    password: adminPassword,
  });

  return {
    success: true,
    message: 'Backend provisioned successfully',
    connection: {
      id: conn.id,
      type: conn.type,
      name: conn.name,
      url: conn.url,
      email: adminEmail,
      password: adminPassword,
    },
  };
}
function findBackend(backend) {
  if (backend) { const conn = getConnection(backend); if (conn) return conn; }
  const all = Array.from(connections.values());
  if (all.length === 1) return all[0];
  throw new Error(backend ? `Backend "${backend}" not found` : 'No backend specified and multiple backends available');
}

// ---------- LLM Agent ----------
async function interpretCommand(message, conns) {
  if (!config.llm.apiKey) throw new Error('AGENT_LLM_API_KEY not set');
  const system = `You are BluBase Agent. Convert user request to JSON action. Available backends: ${JSON.stringify(conns.map(c => ({ id: c.id, name: c.name, type: c.type, url: c.url })))}.
Actions: connect, list_collections, create_collection, list_records, create_record, update_record, delete_record, call_edge_function, help.
For provision_backend: {action:"provision_backend", name:"optional-name"}
For connect: {action:"connect", backend:"pocketbase|silobase|custom", name, url, email, password, token}
For list_collections: {action:"list_collections", backend:"name|id"}
For create_collection: {action:"create_collection", backend, schema:{name:"collection_name", type:"base", schema:[{name:"field_name", type:"text", required:false, presentable:false, unique:false, options:{min:null,max:null,pattern:""}}]}}
For list_records: {action:"list_records", backend, collection, query:{page,perPage,filter,sort}}
For create_record: {action:"create_record", backend, collection, data:{}}
For update_record: {action:"update_record", backend, collection, id, data:{}}
For delete_record: {action:"delete_record", backend, collection, id}
For call_edge_function: {action:"call_edge_function", backend, function, data:{}}
For help: {action:"help", message}
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
      const result = await provisionBackend(action.name);
      return result;
    }
    case 'connect': {
      if (!action.url) throw new Error('Connect requires url');
      const conn = addConnection({ type: action.backend || 'custom', name: action.name, url: action.url, email: action.email, password: action.password, token: action.token });
      const adapter = getAdapter(conn); await adapter.auth();
      return { success: true, message: `Connected ${conn.name} (${conn.type})`, connection: { id: conn.id, type: conn.type, name: conn.name, url: conn.url } };
    }
    case 'list_collections': { const conn = findBackend(action.backend); const adapter = getAdapter(conn); return { success: true, backend: conn.name, collections: await adapter.getCollections() }; }
    case 'create_collection': { const conn = findBackend(action.backend); const adapter = getAdapter(conn); return { success: true, backend: conn.name, result: await adapter.createCollection(action.schema) }; }
    case 'list_records': { const conn = findBackend(action.backend); const adapter = getAdapter(conn); return { success: true, backend: conn.name, collection: action.collection, records: await adapter.list(action.collection || '', action.query) }; }
    case 'create_record': { const conn = findBackend(action.backend); const adapter = getAdapter(conn); return { success: true, backend: conn.name, collection: action.collection, record: await adapter.create(action.collection || '', action.data) }; }
    case 'update_record': { const conn = findBackend(action.backend); const adapter = getAdapter(conn); return { success: true, backend: conn.name, collection: action.collection, record: await adapter.update(action.collection || '', action.id || '', action.data) }; }
    case 'delete_record': { const conn = findBackend(action.backend); const adapter = getAdapter(conn); await adapter.delete(action.collection || '', action.id || ''); return { success: true, backend: conn.name, collection: action.collection, deletedId: action.id }; }
    case 'call_edge_function': { const conn = findBackend(action.backend); const adapter = getAdapter(conn); return { success: true, backend: conn.name, function: action.function, result: await adapter.callEdgeFunction(action.function || '', action.data || {}) }; }
    case 'help': return { success: false, message: action.message || 'Please clarify.' };
    default: throw new Error('Unknown action');
  }
}

// ---------- Middleware ----------
function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();
  if (req.header('x-api-key') !== config.apiKey) return res.status(401).json({ error: 'Invalid or missing x-api-key header' });
  next();
}

// ---------- Routes ----------
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'blubase-agent', connections: listConnections() }));

app.use(requireApiKey);

app.post('/provision', async (req, res, next) => {
  try {
    const { name } = req.body;
    const result = await provisionBackend(name);
    res.json(result);
  } catch (err) { next(err); }
});

app.post('/connect', async (req, res, next) => {
  try {
    const { backend, name, url, email, password, token } = req.body;
    if (!backend || !url) return res.status(400).json({ error: 'backend and url are required' });
    const conn = addConnection({ type: backend, name, url, email, password, token });
    const adapter = getAdapter(conn); await adapter.auth();
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

// Proxy routes
app.get('/proxy/:backend/:collection', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); res.json(await adapter.list(req.params.collection, req.query)); } catch (err) { next(err); }
});
app.post('/proxy/:backend/:collection', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); res.status(201).json(await adapter.create(req.params.collection, req.body)); } catch (err) { next(err); }
});
app.patch('/proxy/:backend/:collection/:id', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); res.json(await adapter.update(req.params.collection, req.params.id, req.body)); } catch (err) { next(err); }
});
app.delete('/proxy/:backend/:collection/:id', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); await adapter.delete(req.params.collection, req.params.id); res.json({ success: true }); } catch (err) { next(err); }
});

// Meta routes
app.get('/meta/:backend/collections', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); res.json(await adapter.getCollections()); } catch (err) { next(err); }
});
app.post('/meta/:backend/collections', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); res.status(201).json(await adapter.createCollection(req.body)); } catch (err) { next(err); }
});

// Edge route
app.post('/edge/:backend/:function', async (req, res, next) => {
  try { const conn = findBackend(req.params.backend); const adapter = getAdapter(conn); res.json(await adapter.callEdgeFunction(req.params.function, req.body || {})); } catch (err) { next(err); }
});

// Root info
app.get('/', (_req, res) => res.json({
  service: 'BluBase Agent',
  endpoints: {
    health: 'GET /health',
    connect: 'POST /connect',
    connections: 'GET /connections',
    agent: 'POST /agent/command',
    proxy: 'GET|POST|PATCH|DELETE /proxy/:backend/:collection',
    meta: 'GET|POST /meta/:backend/collections',
    edge: 'POST /edge/:backend/:function'
  }
}));

// Error handler
app.use((err, _req, res, _next) => {
    console.error('ERROR:', err);
    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal server error';
    const details = err.response?.data || err.data || null;
    res.status(status).json({ error: message, details });
  });

app.listen(config.port, () => console.log(`🚀 BluBase Agent running on port ${config.port}`));
