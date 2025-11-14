import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import { logger } from '../logger.ts';

type TorrentFile = {
    path: string; // path inside torrent (relative)
    length: number;
};

export type TorrentInfo = {
    pieceLength: number;
    pieces: Buffer; // concatenated 20-byte SHA1s
    files: TorrentFile[]; // for single-file torrents, files.length == 1
    name?: string;
};

type Candidate = {
    filePath: string;
    size: number;
};

type Slot = {
    index: number; // file index within torrent files
    filePathInTorrent: string;
    size: number;
    offsetStart: number; // offset within whole torrent byte-stream
    offsetEnd: number;   // exclusive
    firstPiece: number;
    lastPiece: number;
    prefixLen: number; // bytes in the first piece that belong to previous file
    suffixLen: number; // bytes needed from next file to complete last piece
    middlePieceIndices: number[]; // pieces fully inside this file (may be empty)
    candidates: SlotCandidate[]; // candidates with precomputations
};

type SlotCandidate = {
    cand: Candidate;
    // counts and precomputed piece hashes for fully-contained pieces
    middleMatchCount: number; // number of middle pieces matched
    middleHashes: Buffer[];   // computed SHA1s for each middle piece (in same order as middlePieceIndices)
    // first/last partial buffers:
    firstPieceKnownBuf?: Buffer; // bytes from the candidate that sit in the first piece (length = P - prefixLen)
    lastPieceKnownBuf?: Buffer;  // bytes from the candidate that sit in the last piece (length = offsetEnd % P)
    // eliminated flag (pruned early because of middle piece mismatch)
    eliminated?: boolean;
};

export async function matchTorrentFiles(info: TorrentInfo): Promise<void> {
    logger.trace(`matchTorrentFiles`);
    logger.trace(info);
}
