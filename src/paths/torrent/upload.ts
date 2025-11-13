import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { logger } from '../../logger.ts';

export async function uploadTorrent(req: Request, res: Response) {
    if (!req.file) return res.status(400).json({ error: 'No torrent file uploaded' });

    try {
        const id = crypto.randomBytes(8).toString('hex');
        const torrentPath = path.join(process.env.TMP_TORRENTS_DIR!, `${id}.torrent`);
        fs.writeFileSync(torrentPath, req.file.buffer);
        logger.trace({ torrentPath }, 'Uploaded torrent');
        res.json({ id });
    } catch (err) {
        logger.error({ err }, 'Failed to save torrent');
        res.status(500).json({ error: 'Failed to save torrent' });
    }
}
