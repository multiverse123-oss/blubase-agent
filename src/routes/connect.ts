import { Router } from 'express';
import { connectionManager } from '../services/connectionManager';
import { PocketBaseAdapter } from '../services/pocketbaseAdapter';
import { RestBackendAdapter } from '../services/restBackendAdapter';

const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const { backend, name, url, email, password, token } = req.body;
    if (!backend || !url) {
      return res.status(400).json({ error: 'backend and url are required' });
    }
    const conn = connectionManager.add({ type: backend, name, url, email, password, token });
    const adapter = backend === 'pocketbase' ? new PocketBaseAdapter(conn) : new RestBackendAdapter(conn);
    await adapter.authenticate();
    res.json({
      success: true,
      connection: { id: conn.id, type: conn.type, name: conn.name, url: conn.url }
    });
  } catch (err) {
    next(err);
  }
});

export default router;
