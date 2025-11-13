import path from 'path';
import fs from 'fs';
import { getConfig } from './config.ts';
import type { AppConfig } from './config.ts';

export interface Paths {
    torrents: string;
}

let paths: Paths | null = null;

export function initPaths(): Paths {
    if (paths) return paths; // prevent re-init

    const cfg: AppConfig = getConfig();
    paths = {
        torrents: path.join(cfg.server.TMP_DIR, 'torrents')
    }

    fs.mkdirSync(paths.torrents, { recursive: true });

    return paths;
}

export function getPaths(): Paths {
    if (!paths) {
        throw new Error('Paths not initialized! Call initPaths() in main() first.');
    }
    return paths;
}
