import fsPromises from 'fs/promises';
import crypto from 'crypto';
import { getServerDatabase } from '../db/index.ts';
import { logger } from '../logger.ts';

/**
 * Compute a SHA1 hash of a specific file region (torrent piece).
 */
export async function hashPiece(filePath: string, offset: number, length: number): Promise<string> {
    const fh = await fsPromises.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buffer, 0, length, offset);
        return crypto.createHash('sha1')
        .update(buffer.subarray(0, bytesRead))
        .digest('hex');
    } finally {
        await fh.close();
    }
}

/**
 * Get cached piece hashes from memory or the DB.
 */
export async function getCachedPieceHashes(fileHash: string, pieceLength: number): Promise<Map<number, string>> {
    const rows = await getServerDatabase().all('SELECT piece_index, piece_hash FROM file_pieces WHERE file_hash = ? AND piece_length = ?', fileHash, pieceLength);
    const map = new Map<number, string>();
    for (const row of rows) map.set(row.piece_index, row.piece_hash);
    return map;
}

/**
 * Store piece hashes asynchronously after the response has been sent.
 */
export async function storePieceHashes(fileHash: string, pieceLength: number, pieceHashes: Buffer[]) {
    const insert = await getServerDatabase().prepare(`
    INSERT OR IGNORE INTO file_pieces (file_hash, piece_length, piece_index, piece_hash)
    VALUES (?, ?, ?, ?)
    `);
    for (let i = 0; i < pieceHashes.length; i++) {
        await insert.run(fileHash, pieceLength, i, pieceHashes[i].toString('hex'));
    }
    await insert.finalize();
}
