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

interface FileTreeEntry {
  path: string;
  size: number;
  locations: string[];
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
  try{
    const torrentId = req.params.id;
    const torrentPath = path.join(serverConfig.TMP_DIR, 'torrents', `${torrentId}.torrent`);

    console.log(`[TRACE] Loading torrent ${torrentPath}`);
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

    // Determine if multi-file torrent
    const files: { path: string; length: number }[] = info.files
    ? info.files.map((f: any) => {
      const decodedPathComponents = f.path.map((p: Buffer) => p.toString('utf8'));
      return { path: decodedPathComponents.join('/'), length: f.length };
    })
    : [{ path: info.name.toString('utf8'), length: info.length }];

    let globalOffset = 0; // global byte offset in the torrent

    for (const f of files) {
      console.log(`[TRACE] Processing file: ${f.path} (size: ${f.length})`);
      const locations: string[] = [];

      // 1️⃣ Get candidate files from DB by size
      const candidates = await db.all('SELECT path FROM files WHERE file_size = ?', f.length);
      console.log(`[TRACE] Found ${candidates.length} candidates by size`);

      for (const c of candidates) {
        const candidatePath = path.isAbsolute(c.path) ? c.path : path.join(rdConfig.DEDUPLICATION_ROOT, c.path);
        if (!fs.existsSync(candidatePath)) continue;

        console.log(`[TRACE] Checking candidate: ${candidatePath}`);

        const fd = fs.openSync(candidatePath, 'r');
        const pieceCount = Math.ceil(f.length / pieceLength);
        let matched = true;

        for (let i = 0; i < pieceCount; i++) {
          // Compute offsets for this file within the global piece stream
          const pieceStartGlobal = globalOffset + i * pieceLength;
          const pieceEndGlobal = Math.min(pieceStartGlobal + pieceLength, globalOffset + f.length);
          const readLength = pieceEndGlobal - pieceStartGlobal;

          const buffer = Buffer.alloc(readLength);
          fs.readSync(fd, buffer, 0, readLength, i * pieceLength);

          const hash = crypto.createHash('sha1').update(buffer).digest();
          const torrentHash = pieceHashes.slice((Math.floor(pieceStartGlobal / pieceLength)) * 20,
                                                (Math.floor(pieceStartGlobal / pieceLength)) * 20 + 20);

          console.log(`[TRACE] piece hash from torrent: ${torrentHash.toString('hex')}`);
          console.log(`[TRACE] candidate piece hash: ${hash.toString('hex')}`);

          if (!hash.equals(torrentHash)) {
            console.log(`[TRACE] Piece ${i} mismatch for candidate ${candidatePath}`);
            matched = false;
            break;
          }
        }

        fs.closeSync(fd);

        if (matched) {
          console.log(`[TRACE] Candidate matched: ${candidatePath}`);
          locations.push(candidatePath);
        } else {
          console.log(`[TRACE] Candidate did not match: ${candidatePath}`);
        }
      }

      filetree.push({
        path: f.path,
        size: f.length,
        locations,
      });

      globalOffset += f.length; // increment global offset
    }

    console.log(`[TRACE] Filetree completed for torrent ${path.basename(torrentPath)}`);
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
