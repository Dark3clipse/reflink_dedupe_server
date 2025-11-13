import fs from 'fs/promises';
import crypto from 'crypto';
import { getMainDatabase } from '../db/index.ts';
import { logger } from '../logger.ts';

const pieceCache = new Map<string, Map<number, string>>(); // cache[fileHash][pieceIndex] = hashHex

/**
 * Compute a SHA1 hash of a specific file region (torrent piece).
 */
export async function hashPiece(
    filePath: string,
    start: number,
    length: number
): Promise<Buffer> {
    const handle = await fs.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        const hash = crypto.createHash('sha1').update(buffer).digest();
        return hash;
    } finally {
        await handle.close();
    }
}

/**
 * Get cached piece hashes from memory or the DB.
 */
export async function getCachedPieceHashes(
    fileHash: string,
    pieceLength: number
): Promise<Map<number, string>> {
    if (pieceCache.has(fileHash)) {
        return pieceCache.get(fileHash)!;
    }

    const rows = await getMainDatabase().all(
        'SELECT piece_index, piece_hash FROM piece_hashes WHERE file_hash = ? AND piece_length = ?',
        fileHash,
        pieceLength
    );

    const map = new Map<number, string>();
    for (const row of rows) {
        map.set(row.piece_index, row.piece_hash);
    }

    pieceCache.set(fileHash, map);
    return map;
}

/**
 * Store piece hashes asynchronously after the response has been sent.
 */
export async function storePieceHashes(
    fileHash: string,
    pieceLength: number,
    computedPieces: (Buffer | undefined)[]
): Promise<void> {
    const insert = await getMainDatabase().prepare(
        'INSERT OR REPLACE INTO piece_hashes (file_hash, piece_length, piece_index, piece_hash) VALUES (?, ?, ?, ?)'
    );

    for (let i = 0; i < computedPieces.length; i++) {
        const hash = computedPieces[i];
        if (!hash) continue;
        await insert.run(fileHash, pieceLength, i, hash.toString('hex'));
    }

    await insert.finalize();
    logger.trace(
        { fileHash, pieceCount: computedPieces.filter(Boolean).length },
                 'Stored piece hashes'
    );

    // update cache
    const cached = pieceCache.get(fileHash) || new Map();
    for (let i = 0; i < computedPieces.length; i++) {
        const hash = computedPieces[i];
        if (hash) cached.set(i, hash.toString('hex'));
    }
    pieceCache.set(fileHash, cached);
}
