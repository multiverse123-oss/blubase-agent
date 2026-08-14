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

router.get('/:backend/collections', async (req, res, next) => {
  try {
    const adapter = getAdapterForBackend(req.params.backend);
    res.json(await adapter.getCollections());
  } catch (err) {
    next(err);
  }
});

router.post('/:backend/collections', async (req, res, next) => {
  try {
    const adapter = getAdapterForBackend(req.params.backend);
    res.status(201).json(await adapter.createCollection(req.body));
  } catch (err) {
    next(err);
  }
});

export default router;
