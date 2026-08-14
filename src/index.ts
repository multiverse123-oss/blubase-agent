import express from 'express';
import cors from 'cors';
import { config } from './config';
import { requireApiKey } from './middleware/auth';
import healthRouter from './routes/health';
import connectRouter from './routes/connect';
import connectionsRouter from './routes/connections';
import agentRouter from './routes/agent';
import proxyRouter from './routes/proxy';
import metaRouter from './routes/meta';
import edgeRouter from './routes/edge';

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.get('/', (_req, res) => {
  res.json({
    service: 'BluBase Agent',
    description: 'Agentic backend powered by PocketBase, SiloBase and custom REST backends',
    endpoints: {
      health: 'GET /health',
      connect: 'POST /connect',
      connections: 'GET /connections',
      agentCommand: 'POST /agent/command',
      proxy: 'GET|POST|PATCH|DELETE /proxy/:backend/:collection',
      meta: 'GET|POST /meta/:backend/collections',
      edge: 'POST /edge/:backend/:function'
    }
  });
});

app.use('/health', healthRouter);
app.use(requireApiKey);
app.use('/connect', connectRouter);
app.use('/connections', connectionsRouter);
app.use('/agent', agentRouter);
app.use('/proxy', proxyRouter);
app.use('/meta', metaRouter);
app.use('/edge', edgeRouter);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`🚀 BluBase Agent running on port ${config.port}`);
});
