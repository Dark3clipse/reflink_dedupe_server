import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import express from 'express';
import expressPino from 'express-pino-logger';
import type { Request, Response, NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import yaml from 'yaml';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import bencode from 'bencode';
import crypto from 'crypto';
import multer from 'multer';
import { logger } from './logger.ts';
import pLimit from 'p-limit';

// Limit concurrent hashing to avoid disk contention
const limit = pLimit(8); // up to 8 pieces read in parallel

// --- Setup multer storage in TMP_DIR/torrents ---
let torrentsDir: string;
const upload = multer({ storage: multer.memoryStorage() }); // store in memory, we'll write manually

interface ReflinkDedupeConfig {
  DB: string;
  DEDUPLICATION_ROOT: string;
}

interface ServerConfig {
  PORT: number;
  AUTH_TOKEN: string;
  SUBPATH_LIBRARY: string;
  SUBPATH_DOWNLOADS: string;
  TMP_DIR: string;
  DB: string;
}

interface FileTreeEntry {
  path: string;
  size: number;
  locations: string[];
}

let db: Database;
let pieceDb: Database;
let rdConfig: ReflinkDedupeConfig;
let serverConfig: ServerConfig;

// --- Load configs ---
function loadRdConfig(filePath: string): ReflinkDedupeConfig {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const cfg: any = {};
  for (const line of lines) {
    const [key, ...rest] = line.split('=');
    let value = rest.join('=').trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    cfg[key.trim()] = value;
  }
  return { DB: cfg.DB || '/var/db/reflink_dedupe.db', DEDUPLICATION_ROOT: cfg.DEDUPLICATION_ROOT || '/' };
}

function loadServerConfig(filePath: string): ServerConfig {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const cfg: any = {};
  for (const line of lines) {
    const [key, ...rest] = line.split('=');
    let value = rest.join('=').trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    cfg[key.trim()] = value;
  }
  return { PORT: parseInt(cfg.PORT, 10) || 8960, AUTH_TOKEN: cfg.AUTH_TOKEN || "", SUBPATH_LIBRARY: cfg.SUBPATH_LIBRARY || 'library', SUBPATH_DOWNLOADS: cfg.SUBPATH_DOWNLOADS || 'downloads', TMP_DIR: cfg.TMP_DIR || '/tmp/reflink_dedupe_server', DB: cfg.DB || '/var/db/reflink_dedupe_server.db' };
}

// --- Helper ---
function toAbsolutePath(p: string): string {
  if (p.startsWith('/')) return p;
  return rdConfig.DEDUPLICATION_ROOT.replace(/\/+$/, '') + '/' + p.replace(/^\/+/, '');
}

async function openDbReadonly(): Promise<Database> {
  const dbPath = path.resolve(rdConfig.DB);
  if (!fs.existsSync(dbPath)) throw new Error(`Database file not found: ${dbPath}`);
  return open({ filename: dbPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
}

async function openPieceDb(): Promise<Database> {
  const dbPath = path.resolve(serverConfig.DB);
  await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
  const dbConn = await open({ filename: dbPath, driver: sqlite3.Database });
  await dbConn.exec(`
  CREATE TABLE IF NOT EXISTS file_pieces (
    file_hash TEXT NOT NULL,
    piece_length INTEGER NOT NULL,
    piece_index INTEGER NOT NULL,
    piece_hash TEXT NOT NULL,
    PRIMARY KEY (file_hash, piece_length, piece_index)
  );
  CREATE INDEX IF NOT EXISTS idx_file_pieces_hash_piece_length ON file_pieces(file_hash, piece_length);
  `);
  return dbConn;
}

function bufferToString(buf: any): string {
  if (Buffer.isBuffer(buf)) return buf.toString('utf8');
  if (Array.isArray(buf)) return buf.map(bufferToString).join('');
  return String(buf);
}

function getPieceHashes(info: any): Buffer[] {
  const pieces: Buffer[] = [];
  const buffer = Buffer.from(info.pieces, 'binary');
  for (let i = 0; i < buffer.length; i += 20) {
    pieces.push(buffer.subarray(i, i + 20));
  }
  return pieces;
}

async function getCachedPieceHashes(fileHash: string, pieceLength: number): Promise<Map<number, string>> {
  const rows = await pieceDb.all('SELECT piece_index, piece_hash FROM file_pieces WHERE file_hash = ? AND piece_length = ?', fileHash, pieceLength);
  const map = new Map<number, string>();
  for (const row of rows) map.set(row.piece_index, row.piece_hash);
  return map;
}

async function storePieceHashes(fileHash: string, pieceLength: number, pieceHashes: Buffer[]) {
  const insert = await pieceDb.prepare(`
  INSERT OR IGNORE INTO file_pieces (file_hash, piece_length, piece_index, piece_hash)
  VALUES (?, ?, ?, ?)
  `);
  for (let i = 0; i < pieceHashes.length; i++) {
    await insert.run(fileHash, pieceLength, i, pieceHashes[i].toString('hex'));
  }
  await insert.finalize();
}

async function hashPiece(filePath: string, offset: number, length: number): Promise<Buffer> {
  const fh = await fsPromises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, offset);
    return crypto.createHash('sha1').update(buffer).digest();
  } finally {
    await fh.close();
  }
}

// --- Token Auth middleware ---
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  const token = authHeader.split(' ')[1];
  // Placeholder: validate token here
  if (token !== serverConfig.AUTH_TOKEN) return res.status(403).json({ error: 'Invalid token' });
  next();
}

// --- Placeholder endpoint implementations ---
async function uploadTorrent(req: Request, res: Response) {
  if (!req.file) {
    return res.status(400).json({ error: 'No torrent file uploaded' });
  }

  try {
    // Generate a random ID for the torrent (could also use a hash)
    const id = crypto.randomBytes(8).toString('hex');
    const torrentPath = path.join(torrentsDir, `${id}.torrent`);

    // Save the uploaded file
    fs.writeFileSync(torrentPath, req.file.buffer);

    // Return the torrent ID
    res.json({ id });
  } catch (err) {
    console.error('Failed to save torrent:', err);
    res.status(500).json({ error: 'Failed to save torrent' });
  }
}

async function deleteTorrent(req: Request, res: Response) {
  const { id } = req.params;
  const torrentPath = path.join(torrentsDir, `${id}.torrent`);

  try {
    if (!fs.existsSync(torrentPath)) {
      return res.status(404).json({ error: `Torrent with ID ${id} not found` });
    }

    fs.unlinkSync(torrentPath); // delete the file
    res.json({ success: true, message: `Torrent ${id} deleted successfully` });
  } catch (err) {
    console.error('Failed to delete torrent:', err);
    res.status(500).json({ error: 'Failed to delete torrent' });
  }
}

async function getTorrentMetadata(req: Request, res: Response) {
  const { id } = req.params;
  const torrentPath = path.join(torrentsDir, `${id}.torrent`);

  try {
    if (!fs.existsSync(torrentPath)) {
      return res.status(404).json({ error: `Torrent with ID ${id} not found` });
    }

    // Read and parse torrent
    const torrentData = fs.readFileSync(torrentPath);
    const decoded = bencode.decode(torrentData, { encoding: 'utf8' }) as any;

    // Torrent name
    let name = bufferToString(decoded.info?.name) || `Torrent-${id}`;

    // List of files and total size
    let files = [];
    let totalSize = 0;

    if (decoded.info?.files) {
      // Multi-file torrent
      files = decoded.info.files.map((f: any) => ({
        path: f.path.map((p: Buffer) => p.toString()).join('/'),
                                                  size: f.length
      }));
      totalSize = files.reduce((acc: number, f: any) => acc + f.size, 0);
    } else if (decoded.info?.length) {
      // Single-file torrent
      files = [{ path: name, size: decoded.info.length }];
      totalSize = decoded.info.length;
    }

    res.json({
      id,
      name,
      size: totalSize,
      fileCount: files.length
    });
  } catch (err) {
    console.error('Failed to read torrent metadata:', err);
    res.status(500).json({ error: 'Failed to read torrent metadata' });
  }
}

async function computeAndCacheMissingPieces(
  filePath: string,
  fileHash: string,
  pieceLength: number,
  pieceCount: number,
  cachedPieces: Map<number, string>,
  globalOffset: number,
  torrentPieceHashes: Buffer
): Promise<Buffer[]> {
  const computedPieces: Buffer[] = [];
  const tasks: Promise<void>[] = [];

  for (let i = 0; i < pieceCount; i++) {
    if (cachedPieces.has(i)) continue;

    const pieceStartGlobal = globalOffset + i * pieceLength;
    const pieceEndGlobal = pieceStartGlobal + pieceLength;
    const readLength = pieceEndGlobal - pieceStartGlobal;

    tasks.push(
      limit(async () => {
        const pieceHash = await hashPiece(filePath, i * pieceLength, readLength);
        computedPieces[i] = pieceHash;
      })
    );
  }

  await Promise.all(tasks);
  return computedPieces.filter(Boolean);
}

async function getTorrentFiletree(req: Request, res: Response) {
  try{

    const torrentId = req.params.id;
    const torrentPath = path.join(serverConfig.TMP_DIR, 'torrents', `${torrentId}.torrent`);

    logger.trace(`Loading torrent ${torrentPath}`);
    const filetree: FileTreeEntry[] = [];

    const torrentData = fs.readFileSync(torrentPath);
    const decoded: any = bencode.decode(torrentData);

    const info = decoded.info;
    const pieceLength: number = info['piece length'];
    let pieceHashes: Buffer;

    // Ensure we get raw bytes
    if (typeof info.pieces === 'string') {
      pieceHashes = Buffer.from(info.pieces, 'latin1');
    } else if (info.pieces instanceof Uint8Array) {
      pieceHashes = Buffer.from(info.pieces);
    } else {
      throw new Error('Unknown pieces type in torrent');
    }
    logger.trace(`[TRACE] Torrent piece length: ${pieceLength}, total pieces: ${pieceHashes.length / 20}`);


    // Determine if multi-file torrent
    const files: { path: string; length: number }[] = info.files
    ? info.files.map((f: any, idx: number) => {
      logger.trace(`[TRACE] Decoding multi-file path #${idx}`);
      const pathComponents = f.path.map((p: Buffer, compIdx: number) => {
        const str = p.toString('utf8');
        logger.trace(`[TRACE] Path component ${compIdx}: ${str}`);
        return str;
      });
      const filePath = pathComponents.join('/');
      logger.trace(`[TRACE] Full file path: ${filePath}, length: ${f.length}`);
      return { path: filePath, length: f.length };
    })
    : (() => {
      let filePath;
      if (info.name instanceof Uint8Array) {
        filePath = Buffer.from(info.name).toString('utf8');
      }else{
        filePath = String(info.name);
      }
      logger.trace(`[TRACE] Single-file torrent path: ${filePath}, length: ${info.length}`);
      return [{ path: filePath, length: info.length }];
    })();

    let globalOffset = 0; // global byte offset in the torrent

    for (const f of files) {
      logger.trace(`[TRACE] Processing file: ${f.path} (size: ${f.length})`);
      const locations: string[] = [];

      // 1️⃣ Get candidate files from DB by size
      const candidates = await db.all('SELECT path, hash FROM files WHERE file_size = ?', f.length);
      logger.trace(`[TRACE] Found ${candidates.length} candidates by size`);

      for (const c of candidates) {
        const candidatePath = path.isAbsolute(c.path) ? c.path : path.join(rdConfig.DEDUPLICATION_ROOT, c.path);
        if (!fs.existsSync(candidatePath)) continue;

        logger.trace(`[TRACE] Checking candidate: ${candidatePath}`);
        const fileHash = c.hash;
        const cachedPieces = await getCachedPieceHashes(fileHash, pieceLength);

        const pieceCount = Math.ceil(f.length / pieceLength);
        let matched = true;
        const computedPieces: Buffer[] = [];

        computeAndCacheMissingPieces(candidatePath, fileHash, pieceLength, pieceCount, cachedPieces, globalOffset, pieceHashes);

        /*for (let i = 0; i < pieceCount; i++) {
          // Compute offsets for this file within the global piece stream
          const pieceStartGlobal = globalOffset + i * pieceLength;
          const pieceEndGlobal = Math.min(pieceStartGlobal + pieceLength, globalOffset + f.length);
          const readLength = pieceEndGlobal - pieceStartGlobal;

          let candidatePieceHash: Buffer;

          if (cachedPieces.has(i)) {
            candidatePieceHash = Buffer.from(cachedPieces.get(i)!, 'hex');
          } else {
            const buffer = Buffer.alloc(readLength);
            fs.readSync(fd, buffer, 0, readLength, i * pieceLength);
            candidatePieceHash = crypto.createHash('sha1').update(buffer).digest();
            computedPieces.push(candidatePieceHash);
          }

          const torrentHash = pieceHashes.slice((Math.floor(pieceStartGlobal / pieceLength)) * 20,
                                                (Math.floor(pieceStartGlobal / pieceLength)) * 20 + 20);

          //logger.trace(`[TRACE] piece hash from torrent: ${torrentHash.toString('hex')}`);
          //logger.trace(`[TRACE] candidate piece hash: ${hash.toString('hex')}`);

          if (!candidatePieceHash.equals(torrentHash)) {
            logger.trace(`[TRACE] Piece ${i} mismatch for candidate ${candidatePath}`);
            matched = false;
            break;
          }
        }*/

        if (matched) {
          logger.trace(`[TRACE] Candidate matched: ${candidatePath}`);
          locations.push(candidatePath);
          if (computedPieces.length > 0) {
            setImmediate(async () => {
              try {
                await storePieceHashes(fileHash, pieceLength, computedPieces);
                logger.trace(`[TRACE] Stored ${computedPieces.length} piece hashes for ${candidatePath}`);
              } catch (err) {
                logger.error({ err }, `[TRACE] Failed to store piece hashes for ${candidatePath}`);
              }
            });
          }
        } else {
          logger.trace(`[TRACE] Candidate did not match: ${candidatePath}`);
        }
      }

      filetree.push({
        path: f.path,
        size: f.length,
        locations,
      });

      globalOffset += f.length; // increment global offset
    }

    logger.trace(`[TRACE] Filetree completed for torrent ${path.basename(torrentPath)}`);
    res.json(filetree);
  }catch (err){
    console.error('Failed to compute torrent filetree:', err);
    res.status(500).json({ error: 'Failed to compute torrent filetree' });
  }
}


async function getTorrentLocation(req: Request, res: Response) {
  res.json({ downloadsPercentage: 100, libraryPercentage: 50 });
}

async function getTorrentAvailable(req: Request, res: Response) {
  res.json({ totalFiles: 10, filesFound: 7, availablePercentage: 70.0 });
}

async function prepareTorrent(req: Request, res: Response) {
  res.json({ success: true, message: 'Prepared torrent folder (placeholder)' });
}

async function reportDuplicate(req: Request, res: Response) {
  res.json({ success: true, message: 'Duplicate verified (placeholder)' });
}

async function createDuplicate(req: Request, res: Response) {
  res.json({ success: true, message: 'Duplicate created (placeholder)' });
}

export function tracedRoute(fn: Function, name?: string) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const routeName = name || fn.name || 'anonymousHandler';
    req.log.trace({ routeName }, '→ Enter route');

    const start = Date.now();
    try {
      await fn(req, res, next);
      const duration = Date.now() - start;
      req.log.trace({ routeName, duration }, '← Exit route (OK)');
    } catch (err) {
      const duration = Date.now() - start;
      req.log.error({ routeName, duration, err }, '← Exit route (ERROR)');
      next(err);
    }
  };
}

// --- Main ---
async function main() {
  rdConfig = loadRdConfig('/usr/local/etc/reflink_dedupe.conf');
  serverConfig = loadServerConfig('/usr/local/etc/reflink_dedupe_server.conf');

  // Derive temporary locations
  torrentsDir = path.join(serverConfig.TMP_DIR, 'torrents')

  // create temporary directories
  if (!fs.existsSync(serverConfig.TMP_DIR)) {
    fs.mkdirSync(serverConfig.TMP_DIR);
  };
  if (!fs.existsSync(torrentsDir)) {
    fs.mkdirSync(torrentsDir);
  };

  // open DBs
  db = await openDbReadonly();
  pieceDb = await openPieceDb();


  const app = express();
  app.use(expressPino({ logger }));
  app.use(express.json());
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    req.log = logger.child({ reqId: req.id });
    next();
  });
  if (logger.level === 'trace') {
    app.use((req, res, next) => {
      const oldJson = res.json;
      res.json = function (body) {
        logger.trace({ url: req.originalUrl, body }, 'Response JSON');
        return oldJson.call(this, body);
      };
      next();
    });
  }

  // --- Swagger UI ---
  const specPath = path.resolve('./openapi/openapi.yaml');
  const openapiSpec = yaml.parse(fs.readFileSync(specPath, 'utf8'));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

  // --- Apply auth globally ---
  app.use(authMiddleware);

  // --- Routes ---
  app.post('/torrent/upload', upload.single('torrentFile'), tracedRoute(uploadTorrent, 'uploadTorrent'));
  app.delete('/torrent/:id', tracedRoute(deleteTorrent, 'deleteTorrent'));
  app.get('/torrent/:id', tracedRoute(getTorrentMetadata, 'getTorrentMetadata'));
  app.get('/torrent/:id/filetree', tracedRoute(getTorrentFiletree, 'getTorrentFiletree'));
  app.get('/torrent/:id/location', tracedRoute(getTorrentLocation, 'getTorrentLocation'));
  app.get('/torrent/:id/available', tracedRoute(getTorrentAvailable, 'getTorrentAvailable'));
  app.post('/torrent/:id/prepare', tracedRoute(prepareTorrent, 'prepareTorrent'));

  app.post('/duplicates/report', tracedRoute(reportDuplicate, 'reportDuplicate'));
  app.post('/duplicates/create', tracedRoute(createDuplicate, 'createDuplicate'));

  app.listen(serverConfig.PORT, () => {
    logger.info(`Reflink Dedupe Server started on port ${serverConfig.PORT}`);
    logger.trace(`Root path: ${rdConfig.DEDUPLICATION_ROOT}`);
    logger.trace(`DB path: ${rdConfig.DB}`);
  });
}

process.on('SIGINT', async () => {
  logger.info('Waiting for background tasks to finish...');
  await Promise.allSettled(backgroundTasks);
  await Promise.allSettled([db?.close(), pieceDb?.close()]);
  process.exit(0);
});

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
