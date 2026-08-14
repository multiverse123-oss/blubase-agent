import { Router } from 'express';
import { connectionManager } from '../services/connectionManager';

const router = Router();
router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'blubase-agent',
    connections: connectionManager.list()
  });
});
export default router;
