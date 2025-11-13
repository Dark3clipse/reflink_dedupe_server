import type { Request, Response } from 'express';

export async function getTorrentLocation(req: Request, res: Response) {
    res.json({ downloadsPercentage: 100, libraryPercentage: 50 });
}
