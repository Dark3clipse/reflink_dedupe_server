import fs from 'fs';
import path from 'path';
import bencode from 'bencode';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import pLimit from 'p-limit';
import { getPaths } from '../../utils/paths.ts';
import { getCachedPieceHashes, storePieceHashes, hashPiece } from '../../utils/hashPiece.ts';
import { getMainDatabase } from '../../db/index.ts';
import { logger } from '../../logger.ts';
import { getConfig } from '../../utils/config.ts';
import type { AppConfig } from '../../utils/config.ts';

const limit = pLimit(8);

interface FileTreeEntry {
    path: string;
    size: number;
    locations: string[];
}

export async function getTorrentFiletree(req: Request, res: Response) {
    try {
        // Prepare paths
        const torrentId = req.params.id;
        const rdRoot = getConfig().rd.DEDUPLICATION_ROOT;
        const torrentPath = path.join(getPaths().torrents, `${torrentId}.torrent`);

        // Parse torrent metadata
        logger.trace(`Loading torrent ${torrentPath}`);
        const torrentData = fs.readFileSync(torrentPath);
        const decoded: any = bencode.decode(torrentData);
        const info = decoded.info;
        const pieceLength: number = info['piece length'];
        const pieceHashes: Buffer = typeof info.pieces === 'string' ? Buffer.from(info.pieces, 'latin1') : Buffer.from(info.pieces);
        const files: { path: string; length: number }[] = info.files
        ? info.files.map((f: any, idx: number) => {
            //logger.trace(`[TRACE] Decoding multi-file path #${idx}`);
            const pathComponents = f.path.map((p: Buffer, compIdx: number) => {
                const str = p.toString('utf8');
                //logger.trace(`[TRACE] Path component ${compIdx}: ${str}`);
                return str;
            });
            const filePath = pathComponents.join('/');
            //logger.trace(`[TRACE] Full file path: ${filePath}, length: ${f.length}`);
            return { path: filePath, length: f.length };
        })
        : (() => {
            let filePath;
            if (info.name instanceof Uint8Array) {
                filePath = Buffer.from(info.name).toString('utf8');
            }else{
                filePath = String(info.name);
            }
            //logger.trace(`[TRACE] Single-file torrent path: ${filePath}, length: ${info.length}`);
            return [{ path: filePath, length: info.length }];
        })();

        logger.trace(`Torrent metadata parsed:`);
        logger.trace(`  piece length: ${pieceLength}`);
        logger.trace(`  total pieces: ${pieceHashes.length / 20}`);
        logger.trace(`  files:`);
        for (const f of files) {
            logger.trace(`    ${f.path} (size: ${f.length})`);
        }

        // Prepare loop
        const filetree: FileTreeEntry[] = [];
        let globalOffset = 0;

        res.status(500).json({ error: 'Failed to build torrent filetree' });
        return;

        for (const f of files) {
            const locations: string[] = [];
            const candidates = await getMainDatabase().all('SELECT path, hash FROM files WHERE file_size = ?', f.length);

            for (const c of candidates) {
                const candidatePath = path.isAbsolute(c.path)
                ? c.path
                : path.join(rdRoot, c.path);
                if (!fs.existsSync(candidatePath)) continue;

                const fileHash = c.hash;
                const cachedPieces = await getCachedPieceHashes(fileHash, pieceLength);
                const pieceCount = Math.ceil(f.length / pieceLength);
                let matched = true;
                const computedPieces: Buffer[] = [];

                const tasks: Promise<void>[] = [];
                for (let i = 0; i < pieceCount; i++) {
                    if (cachedPieces.has(i)) continue;
                    const pieceStartGlobal = globalOffset + i * pieceLength;
                    const pieceEndGlobal = Math.min(pieceStartGlobal + pieceLength, globalOffset + f.length);
                    const readLength = pieceEndGlobal - pieceStartGlobal;

                    tasks.push(
                        limit(async () => {
                            const hash = await hashPiece(candidatePath, i * pieceLength, readLength);
                            computedPieces[i] = hash;
                        })
                    );
                }
                await Promise.all(tasks);

                const torrentPieceHashes = [];
                for (let i = 0; i < pieceCount; i++) {
                    const torrentHash = pieceHashes.subarray((Math.floor((globalOffset + i * pieceLength) / pieceLength)) * 20, (Math.floor((globalOffset + i * pieceLength) / pieceLength)) * 20 + 20);
                    const candidatePieceHash = cachedPieces.has(i)
                    ? Buffer.from(cachedPieces.get(i)!, 'hex')
                    : computedPieces[i];

                    if (!candidatePieceHash.equals(torrentHash)) {
                        matched = false;
                        break;
                    }
                    torrentPieceHashes.push(candidatePieceHash);
                }

                if (matched) {
                    locations.push(candidatePath);
                    setImmediate(async () => {
                        try {
                            await storePieceHashes(fileHash, pieceLength, computedPieces);
                        } catch (err) {
                            logger.error({ err }, 'Failed to store piece hashes');
                        }
                    });
                }
            }

            filetree.push({ path: f.path, size: f.length, locations });
            globalOffset += f.length;
        }

        res.json(filetree);
    } catch (err) {
        logger.error({ err }, 'Failed to build torrent filetree');
        res.status(500).json({ error: 'Failed to build torrent filetree' });
    }
}
