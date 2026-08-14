import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!config.apiKey) return next();
  const key = req.header('x-api-key');
  if (key !== config.apiKey) {
    return res.status(401).json({ error: 'Invalid or missing x-api-key header' });
  }
  next();
}
