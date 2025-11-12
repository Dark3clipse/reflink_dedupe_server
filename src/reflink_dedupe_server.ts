import http from 'http';
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import * as bencode from 'bencode';
import crypto from 'crypto';

interface ReflinkDedupeConfig {
  DB: string;
  DEDUPLICATION_ROOT: string;
}

interface ServerConfig {
  PORT: number
}

let db: Database;
let rdConfig: ReflinkDedupeConfig;
let serverConfig: ServerConfig;

function loadRdConfig(filePath: string): ReflinkDedupeConfig {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const cfg: any = {};
  for (const line of lines) {
    const [key, ...rest] = line.split('=');
    cfg[key.trim()] = rest.join('=').trim();
  }
  return {
    DB: cfg.DB || '/var/db/reflink_dedupe.db',
    DEDUPLICATION_ROOT: cfg.DEDUPLICATION_ROOT || '/',
  };
}

function loadServerConfig(filePath: string): ServerConfig {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const cfg: any = {};
  for (const line of lines) {
    const [key, ...rest] = line.split('=');
    cfg[key.trim()] = rest.join('=').trim();
  }
  return {
    PORT: parseInt(cfg.PORT, 10) || 8960,
  };
}

function toAbsolutePath(p: string): string {
  if (p.startsWith('/')) return p;
  return rdConfig.DEDUPLICATION_ROOT.replace(/\/+$/, '') + '/' + p.replace(/^\/+/, '');
}

function sendJSON(res: http.ServerResponse, status: number, data: object) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

async function initDB(): Promise<Database> {
  const database = await open({
    filename: rdConfig.DB,
    driver: sqlite3.Database,
  });

  // Ensure schema exists
  await database.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE,
      hash TEXT,
      last_checked INTEGER,
      file_size INTEGER
    );
    CREATE TABLE IF NOT EXISTS duplicates (
      id INTEGER PRIMARY KEY,
      original TEXT NOT NULL,
      duplicate TEXT NOT NULL,
      reflinked INTEGER DEFAULT 0,
      last_verified INTEGER,
      CHECK(original < duplicate)
    );
    CREATE TABLE IF NOT EXISTS conflicts (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS batch_hashes (
      hash TEXT PRIMARY KEY
    );
    CREATE INDEX IF NOT EXISTS idx_files_hash_path ON files(hash, path);
    CREATE INDEX IF NOT EXISTS idx_files_hash_size_path ON files(hash, file_size, path);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_duplicates_pair ON duplicates(original, duplicate);
    CREATE INDEX IF NOT EXISTS idx_duplicates_duplicate ON duplicates(duplicate);
  `);

  return database;
}

// POST /torrent
async function handleTorrent(req: http.IncomingMessage, res: http.ServerResponse) {
  let chunks: Buffer[] = [];
  req.on('data', (chunk) => { chunks.push(chunk); });
  req.on('end', async () => {
    try {
      const buffer = Buffer.concat(chunks);
      const torrent = bencode.decode(buffer);

      if (!torrent.info || !torrent.info['piece length'] || !torrent.info.pieces) {
        sendJSON(res, 400, { error: 'Invalid torrent file: missing info' });
        return;
      }

      const pieceLength = torrent.info['piece length'] as number;
      const piecesBuffer: Buffer = torrent.info.pieces as Buffer;
      const numPieces = piecesBuffer.length / 20;

      // File sizes
      let totalSize = 0;
      if (torrent.info.files) {
        // Multi-file
        totalSize = (torrent.info.files as any[]).reduce((sum, f) => sum + f.length, 0);
      } else {
        // Single file
        totalSize = torrent.info.length as number;
      }

      // Split pieces into hashes
      const pieceHashes: string[] = [];
      for (let i = 0; i < numPieces; i++) {
        const hashBuf = piecesBuffer.slice(i * 20, (i + 1) * 20);
        pieceHashes.push(hashBuf.toString('hex'));
      }

      // Check how many hashes exist in DB
      const placeholders = pieceHashes.map(() => '?').join(',');
      const rows = await db.all(
        `SELECT DISTINCT hash FROM files WHERE hash IN (${placeholders})`,
        ...pieceHashes
      );
      const existingHashes = new Set(rows.map((r: any) => r.hash));

      // Compute matched size
      let matchedSize = 0;
      for (let i = 0; i < numPieces; i++) {
        if (existingHashes.has(pieceHashes[i])) {
          // All pieces except last are full pieceLength
          if (i < numPieces - 1) {
            matchedSize += pieceLength;
          } else {
            // Last piece may be smaller
            const lastSize = totalSize - pieceLength * (numPieces - 1);
            matchedSize += lastSize;
          }
        }
      }

      const percentage = totalSize > 0 ? (matchedSize / totalSize) * 100 : 0;

      sendJSON(res, 200, {
        totalSize,
        matchedSize,
        percentage: percentage.toFixed(2),
      });
    } catch (e) {
      console.error('Error in /torrent:', e);
      sendJSON(res, 400, { error: 'Invalid torrent file' });
    }
  });
}

// POST /duplicate
async function handleDuplicate(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const { original, duplicate, reflinked } = data;

      if (typeof original !== 'string' || typeof duplicate !== 'string') {
        sendJSON(res, 400, { error: 'original and duplicate must be strings' });
        return;
      }
      if (reflinked !== 0 && reflinked !== 1) {
        sendJSON(res, 400, { error: 'reflinked must be 0 or 1' });
        return;
      }

      const absOriginal = toAbsolutePath(original);
      const absDuplicate = toAbsolutePath(duplicate);

      if (!absOriginal.startsWith(rdConfig.DEDUPLICATION_ROOT) || !absDuplicate.startsWith(rdConfig.DEDUPLICATION_ROOT)) {
        sendJSON(res, 400, { error: 'Paths must be inside deduplication root' });
        return;
      }

      // Enforce ordering for CHECK(original < duplicate)
      const [o, d] = absOriginal < absDuplicate ? [absOriginal, absDuplicate] : [absDuplicate, absOriginal];

      await db.run(
        `INSERT INTO duplicates (original, duplicate, reflinked)
         VALUES (?, ?, ?)
         ON CONFLICT(original, duplicate) DO UPDATE SET reflinked=excluded.reflinked`,
        o, d, reflinked
      );

      sendJSON(res, 200, { status: 'OK' });
    } catch (e) {
      console.error('Error in /duplicate:', e);
      sendJSON(res, 400, { error: 'Invalid JSON payload' });
    }
  });
}

// GET /hash/:hash
async function handleHash(req: http.IncomingMessage, res: http.ServerResponse) {
  const urlParts = req.url?.split('/') || [];
  if (urlParts.length !== 3 || !urlParts[2]) {
    sendJSON(res, 400, { error: 'Hash not provided' });
    return;
  }
  const hash = urlParts[2];
  try {
    const row = await db.get('SELECT 1 FROM files WHERE hash = ? LIMIT 1', hash);
    sendJSON(res, 200, { exists: !!row });
  } catch (e) {
    console.error('Error in /hash:', e);
    sendJSON(res, 500, { error: 'Internal Server Error' });
  }
}

async function main() {
  rdConfig = loadRdConfig('/usr/local/etc/reflink_dedupe.conf');
  serverConfig = loadServerConfig('/usr/local/etc/reflink_dedupe_server.conf');
  db = await initDB();

  console.log(`[${new Date().toISOString()}] Reflink Dedupe Server started on port ${serverConfig.PORT}`);
  console.log(`Root path: ${rdConfig.DEDUPLICATION_ROOT}`);
  console.log(`DB path: ${rdConfig.DB}`);

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/duplicate') {
      handleDuplicate(req, res).catch(err => {
        console.error('Error handling /duplicate:', err);
        if (!res.headersSent) sendJSON(res, 500, { error: 'Internal Server Error' });
      });
    } else if (req.method === 'GET' && req.url?.startsWith('/hash/')) {
      handleHash(req, res).catch(err => {
        console.error('Error handling /hash:', err);
        if (!res.headersSent) sendJSON(res, 500, { error: 'Internal Server Error' });
      });
    } else if (req.method === 'POST' && req.url === '/torrent') {
      handleTorrent(req, res).catch(err => {
        console.error('Error handling /torrent:', err);
        if (!res.headersSent) sendJSON(res, 500, { error: 'Internal Server Error' });
      });
    } else if (req.method === 'GET' && req.url === '/health') {
      sendJSON(res, 200, { status: 'alive' });
    } else {
      sendJSON(res, 404, { error: 'Not found' });
    }
  });

  server.listen(serverConfig.PORT);
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
