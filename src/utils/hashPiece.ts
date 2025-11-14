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
 * Compute SHA1 hash of a specific piece in a *multi-file* torrent.
 * files: ordered list of files with their lengths and absolute paths.
 * globalOffset: offset in the "virtual concatenated" torrent stream.
 * pieceLength: how many bytes to read and hash.
 */
export async function hashPieceMulti(
    files: { path: string; length: number }[],
    globalOffset: number,
    pieceLength: number
): Promise<string> {
    const hash = crypto.createHash('sha1');
    let remaining = pieceLength;
    let offset = globalOffset;

    // find which file contains the starting offset
    let fileIndex = 0;
    let cumulative = 0;
    while (fileIndex < files.length && cumulative + files[fileIndex].length <= offset) {
        cumulative += files[fileIndex].length;
        fileIndex++;
    }

    if (fileIndex >= files.length) {
        throw new Error(`Offset ${offset} beyond end of torrent`);
    }

    // now start reading sequentially across files
    while (remaining > 0 && fileIndex < files.length) {
        const f = files[fileIndex];
        const filePath = f.path;
        const fileOffset = offset - cumulative; // start point within this file
        const readLength = Math.min(remaining, f.length - fileOffset);

        const fh = await fs.open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(readLength);
            const { bytesRead } = await fh.read(buffer, 0, readLength, fileOffset);
            hash.update(buffer.subarray(0, bytesRead));
        } finally {
            await fh.close();
        }

        remaining -= readLength;
        offset += readLength;
        cumulative += f.length;
        fileIndex++;
    }

    return hash.digest('hex');
}

/**
 * Get cached piece hashes from memory or the DB.
 */
export async function getCachedPieceHashes(fileHash: string, pieceLength: number, lastChecked: number): Promise<Map<number, string>> {
    const rows = await getServerDatabase().all('SELECT piece_index, piece_hash FROM file_pieces WHERE file_hash = ? AND piece_length = ? AND last_checked = ?', fileHash, pieceLength, lastChecked);
    const map = new Map<number, string>();
    for (const row of rows) map.set(row.piece_index, row.piece_hash);
    return map;
}

/**
 * Store piece hashes asynchronously after the response has been sent.
 */
export async function storePieceHashes(fileHash: string, pieceLength: number, pieceHashes: Buffer[], lastChecked: number) {
    const insert = await getServerDatabase().prepare(`
    INSERT OR IGNORE INTO file_pieces (file_hash, piece_length, piece_index, piece_hash, last_checked)
    VALUES (?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < pieceHashes.length; i++) {
        await insert.run(fileHash, pieceLength, i, pieceHashes[i].toString('hex'), lastChecked);
    }
    await insert.finalize();
}
