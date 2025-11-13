import type { Request, Response } from 'express';

export async function prepareTorrent(req: Request, res: Response) {
    res.json({ success: true, message: 'Prepared torrent folder (placeholder)' });
}

