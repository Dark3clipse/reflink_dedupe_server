import type { Request, Response } from 'express';

export async function reportDuplicate(req: Request, res: Response) {
    res.json({ success: true, message: 'Duplicate verified (placeholder)' });
}

