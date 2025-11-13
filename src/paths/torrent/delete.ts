import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { logger } from '../../logger.ts';

export async function deleteTorrent(req: Request, res: Response) {
    const { id } = req.params;
    const torrentsDir = process.env.TMP_TORRENTS_DIR!;
    const torrentPath = path.join(torrentsDir, `${id}.torrent`);

    try {
        if (!fs.existsSync(torrentPath)) {
            return res.status(404).json({ error: `Torrent ${id} not found` });
        }
        fs.unlinkSync(torrentPath);
        logger.trace({ torrentPath }, 'Deleted torrent');
        res.json({ success: true });
    } catch (err) {
        logger.error({ err }, 'Failed to delete torrent');
        res.status(500).json({ error: 'Failed to delete torrent' });
    }
}
