import type { Request, Response } from 'express';

export async function getTorrentAvailable(req: Request, res: Response) {
    res.json({ totalFiles: 10, filesFound: 7, availablePercentage: 70.0 });
}

