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
  res.json({ success: true });
}

async function getTorrentMetadata(req: Request, res: Response) {
  res.json({ id: req.params.id, name: 'Torrent Name', size: 12345, fileCount: 1 });
}

async function getTorrentFiletree(req: Request, res: Response) {
  res.json([{ path: 'file.txt', size: 123, locations: ['/path/to/file.txt'] }]);
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
  fs.mkdirSync(serverConfig.TMP_DIR);
  fs.mkdirSync(torrentsDir);

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
