import { Router } from 'express';
import { connectionManager } from '../services/connectionManager';
import { PocketBaseAdapter } from '../services/pocketbaseAdapter';
import { RestBackendAdapter } from '../services/restBackendAdapter';

const router = Router();

router.post('/:backend/:function', async (req, res, next) => {
  try {
    const conn = connectionManager.findByNameOrType(req.params.backend);
    if (!conn) throw new Error(`Backend "${req.params.backend}" not found`);
    const adapter = conn.type === 'pocketbase' ? new PocketBaseAdapter(conn) : new RestBackendAdapter(conn);
    const result = await adapter.callEdgeFunction(req.params.function, req.body || {});
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
