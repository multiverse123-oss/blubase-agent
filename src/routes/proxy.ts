import { Router } from 'express';
import { connectionManager } from '../services/connectionManager';
import { PocketBaseAdapter } from '../services/pocketbaseAdapter';
import { RestBackendAdapter } from '../services/restBackendAdapter';

const router = Router();

function getAdapterForBackend(backend: string) {
  const conn = connectionManager.findByNameOrType(backend);
  if (!conn) throw new Error(`Backend "${backend}" not found`);
  return conn.type === 'pocketbase' ? new PocketBaseAdapter(conn) : new RestBackendAdapter(conn);
}

router.get('/:backend/:collection', async (req, res, next) => {
  try {
    const adapter = getAdapterForBackend(req.params.backend);
    const data = await adapter.list(req.params.collection, req.query);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post('/:backend/:collection', async (req, res, next) => {
  try {
    const adapter = getAdapterForBackend(req.params.backend);
    const data = await adapter.create(req.params.collection, req.body);
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

router.patch('/:backend/:collection/:id', async (req, res, next) => {
  try {
    const adapter = getAdapterForBackend(req.params.backend);
    const data = await adapter.update(req.params.collection, req.params.id, req.body);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.delete('/:backend/:collection/:id', async (req, res, next) => {
  try {
    const adapter = getAdapterForBackend(req.params.backend);
    await adapter.delete(req.params.collection, req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
