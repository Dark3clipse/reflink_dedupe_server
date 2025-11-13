import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export function makeRequestIdMiddleware() {
    return function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
        req.id = crypto.randomUUID();
        req.log = logger.child({ reqId: req.id });
        next();
    };
}
