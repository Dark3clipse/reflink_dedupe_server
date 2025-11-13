import express from 'express';
import { logger } from '../logger.ts';

export function tracedRoute(fn: Function, name?: string) {
    return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const routeName = name || fn.name || 'anonymous';
        req.log.trace({ routeName }, '→ Enter route');
        const start = Date.now();
        try {
            await fn(req, res, next);
            req.log.trace({ routeName, duration: Date.now() - start }, '← Exit route (OK)');
        } catch (err) {
            req.log.error({ routeName, duration: Date.now() - start, err }, '← Exit route (ERROR)');
            next(err);
        }
    };
}
