import type { Request, Response } from 'express';

export async function createDuplicate(req: Request, res: Response) {
    res.json({ success: true, message: 'Duplicate created (placeholder)' });
}

