import path from 'path';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import fs from 'fs/promises';
import { getConfig } from '../utils/config.ts';

let mainDb: Database | null = null;
let serverDb: Database | null = null;

export async function openMainDbReadonly(dbPath: string): Promise<Database> {
    return open({ filename: dbPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
}

export async function openServerDb(dbPath: string): Promise<Database> {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
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

export async function initDatabases(): None {
    const cfg = getConfig();
    mainDb = await openMainDbReadonly(cfg.rd.DB);
    serverDb = await openServerDb(cfg.server.DB);
}

export function getMainDatabase(): Database {
    if (!mainDb) {
        throw new Error('Database not initialized! Call initDatabases() in main() first.');
    }
    return mainDb;
}

export function getServerDatabase(): Database {
    if (!serverDb) {
        throw new Error('Database not initialized! Call initDatabases() in main() first.');
    }
    return serverDb;
}
