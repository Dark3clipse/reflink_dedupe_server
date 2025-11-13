import type { Request, Response, NextFunction } from 'express';
import type { ServerConfig } from './config.ts';

export function makeAuthMiddleware(config: ServerConfig) {
    return function authMiddleware(req: Request, res: Response, next: NextFunction) {
        const authHeader = req.headers['authorization'];
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing token' });
        }
        const token = authHeader.split(' ')[1];
        if (token !== config.AUTH_TOKEN) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        next();
    };
}
