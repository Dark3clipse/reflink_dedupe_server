import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import bencode from 'bencode';
import { logger } from '../../logger.ts';

export async function getTorrentMetadata(req: Request, res: Response) {
    const { id } = req.params;
    const torrentsDir = process.env.TMP_TORRENTS_DIR!;
    const torrentPath = path.join(torrentsDir, `${id}.torrent`);

    try {
        if (!fs.existsSync(torrentPath)) {
            return res.status(404).json({ error: `Torrent ${id} not found` });
        }

        const torrentData = fs.readFileSync(torrentPath);
        const decoded = bencode.decode(torrentData, { encoding: 'utf8' }) as any;
        const name = decoded.info?.name?.toString?.('utf8') || `Torrent-${id}`;

        let files = [];
        let totalSize = 0;

        if (decoded.info?.files) {
            files = decoded.info.files.map((f: any) => ({
                path: f.path.map((p: Buffer) => p.toString('utf8')).join('/'),
                                                        size: f.length,
            }));
            totalSize = files.reduce((acc: number, f: any) => acc + f.size, 0);
        } else {
            files = [{ path: name, size: decoded.info.length }];
            totalSize = decoded.info.length;
        }

        logger.trace({ id, name, fileCount: files.length }, 'Torrent metadata extracted');
        res.json({ id, name, size: totalSize, fileCount: files.length });
    } catch (err) {
        logger.error({ err }, 'Failed to parse torrent metadata');
        res.status(500).json({ error: 'Failed to parse torrent metadata' });
    }
}
