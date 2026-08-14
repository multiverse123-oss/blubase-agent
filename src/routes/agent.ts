import { Router } from 'express';
import { runAgent } from '../services/agent';

const router = Router();

router.post('/command', async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    const result = await runAgent(message);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
