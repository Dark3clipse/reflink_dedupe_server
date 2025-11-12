import fs from 'fs';
import path from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import yaml from 'yaml';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import bencode from 'bencode';
import crypto from 'crypto';
import multer from 'multer';

// --- Setup multer storage in TMP_DIR/torrents ---
let torrentsDir: string;
const upload = multer({ storage: multer.memoryStorage() }); // store in memory, we'll write manually

interface ReflinkDedupeConfig {
  DB: string;
  DEDUPLICATION_ROOT: string;
}

interface ServerConfig {
  PORT: number;
}

let db: Database;
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
  return { PORT: parseInt(cfg.PORT, 10) || 8960, AUTH_TOKEN: cfg.AUTH_TOKEN || "", SUBPATH_LIBRARY: cfg.SUBPATH_LIBRARY || 'library', SUBPATH_DOWNLOADS: cfg.SUBPATH_DOWNLOADS || 'downloads', TMP_DIR: cfg.TMP_DIR || '/tmp/reflink_dedupe_server' };
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

async function getTorrentFiletree(req: Request, res: Response) {
  const { id } = req.params;
  const torrentPath = path.join(torrentsDir, `${id}.torrent`);

  try {
    if (!fs.existsSync(torrentPath)) {
      console.log(`[TRACE] Torrent file not found: ${torrentPath}`);
      return res.status(404).json({ error: 'Torrent not found' });
    }

    console.log(`[TRACE] Loading torrent ${torrentPath}`);
    const torrentData = fs.readFileSync(torrentPath);
    const decoded = bencode.decode(torrentData, 'utf8') as any;

    const pieceLength = decoded.info['piece length'];
    let pieceHashes: Buffer;
    if (typeof decoded.info.pieces === 'string') {
      // If bencode returned a string, use 'latin1' (raw bytes)
      pieceHashes = Buffer.from(decoded.info.pieces, 'latin1');
    } else if (decoded.info.pieces instanceof Uint8Array) {
      // If bencode returned Uint8Array, wrap it
      pieceHashes = Buffer.from(decoded.info.pieces);
    } else {
      throw new Error('Unknown pieces type in torrent');
    }

    const files = decoded.info.files
    ? decoded.info.files.map((f: any) => ({ path: f.path.join('/'), length: f.length }))
    : [{ path: decoded.info.name, length: decoded.info.length }];

    const filetree: Array<{ path: string; size: number; locations: string[] }> = [];

    for (const file of files) {
      console.log(`[TRACE] Processing file: ${file.path} (size: ${file.length})`);
      let locations: string[] = [];

      if (file.length <= pieceLength) {
        // Single-piece file: look up SHA-1 directly
        const hash = pieceHashes.toString('hex'); // single-piece SHA-1
        const rows = await db.all('SELECT path FROM files WHERE hash = ?', hash);
        locations = rows.map(r => r.path);
        console.log(`[TRACE] Single-piece file found in DB: ${locations.join(', ')}`);
      } else {
        // Multi-piece file: search by file size first
        const candidates = await db.all('SELECT path, hash FROM files WHERE file_size = ?', file.length);
        console.log(`[TRACE] Found ${candidates.length} candidates by size`);

        // Optional: sort candidates by filename similarity
        const targetName = path.basename(file.path);
        candidates.sort((a, b) => {
          const nameA = path.basename(a.path);
          const nameB = path.basename(b.path);
          return nameB.includes(targetName) ? 1 : -1;
        });

        for (const candidate of candidates) {
          console.log(`[TRACE] Checking candidate: ${candidate.path}`);
          const fd = fs.openSync(candidate.path, 'r');
          let pieceMatch = true;

          for (let offset = 0, i = 0; offset < file.length; offset += pieceLength, i++) {
            const buffer = Buffer.alloc(Math.min(pieceLength, file.length - offset));
            const readBytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
            if (readBytes === 0) break;

            const hash = crypto.createHash('sha1').update(buffer.slice(0, readBytes)).digest();
            const torrentHash = pieceHashes.slice(i * 20, i * 20 + 20);
            if (!Buffer.isBuffer(torrentHash)) {
              console.log('[TRACE] Torrent hash is not a buffer!');
            }

            console.log('[TRACE] piece hash from torrent:', torrentHash.toString('hex'));
            console.log('[TRACE] candidate piece hash:', hash.toString('hex'));

            if (!hash.equals(torrentHash)) {
              pieceMatch = false;
              console.log(`[TRACE] Piece ${i} mismatch for candidate ${candidate.path}`);
              break;
            } else {
              console.log(`[TRACE] Piece ${i} matched for candidate ${candidate.path}`);
            }
          }

          fs.closeSync(fd);

          if (pieceMatch) {
            console.log(`[TRACE] Candidate matched: ${candidate.path}`);
            locations.push(candidate.path);
          } else {
            console.log(`[TRACE] Candidate did not match: ${candidate.path}`);
          }
        }
      }

      console.log(`[TRACE] File ${file.path} has ${locations.length} matching locations`);
      filetree.push({
        path: file.path,
        size: file.length,
        locations,
      });
    }

    console.log(`[TRACE] Filetree completed for torrent ${id}`);
    res.json(filetree);
  } catch (err) {
    console.error('Failed to get torrent filetree:', err);
    res.status(500).json({ error: 'Failed to get torrent filetree' });
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

  // open DB
  db = await openDbReadonly();

  const app = express();
  app.use(express.json());

  // --- Swagger UI ---
  const specPath = path.resolve('./openapi/openapi.yaml');
  const openapiSpec = yaml.parse(fs.readFileSync(specPath, 'utf8'));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

  // --- Apply auth globally ---
  app.use(authMiddleware);

  // --- Routes ---
  app.post('/torrent/upload', upload.single('torrentFile'), uploadTorrent);
  app.delete('/torrent/:id', deleteTorrent);
  app.get('/torrent/:id', getTorrentMetadata);
  app.get('/torrent/:id/filetree', getTorrentFiletree);
  app.get('/torrent/:id/location', getTorrentLocation);
  app.get('/torrent/:id/available', getTorrentAvailable);
  app.post('/torrent/:id/prepare', prepareTorrent);

  app.post('/duplicates/report', reportDuplicate);
  app.post('/duplicates/create', createDuplicate);

  app.listen(serverConfig.PORT, () => {
    console.log(`[${new Date().toISOString()}] Reflink Dedupe Server started on port ${serverConfig.PORT}`);
    console.log(`[${new Date().toISOString()}] Root path: ${rdConfig.DEDUPLICATION_ROOT}`);
    console.log(`[${new Date().toISOString()}] DB path: ${rdConfig.DB}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
