import fs from 'fs';

export interface ReflinkDedupeConfig {
    DB: string;
    DEDUPLICATION_ROOT: string;
}

export interface ServerConfig {
    PORT: number;
    AUTH_TOKEN: string;
    SUBPATH_LIBRARY: string;
    SUBPATH_DOWNLOADS: string;
    TMP_DIR: string;
    DB: string;
}

export interface AppConfig {
    rd: ReflinkDedupeConfig;
    server: ServerConfig;
}

let ReflinkDedupeDefaults: Partial<ReflinkDedupeConfig> = {
    DB: '/var/db/reflink_dedupe.db',
    DEDUPLICATION_ROOT: '/',
}

let ServerDefaults: Partial<ServerConfig> = {
    PORT: 8960,
    AUTH_TOKEN: '',
    SUBPATH_LIBRARY: 'library',
    SUBPATH_DOWNLOADS: 'downloads',
    TMP_DIR: '/tmp/reflink_dedupe_server',
    DB: '/var/db/reflink_dedupe_server.db',
}

let config: AppConfig | null = null;


function loadConfigFile<T>(filePath: string, defaults: Partial<T> = {}): T {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const cfg: any = {};
    for (const line of lines) {
        const [key, ...rest] = line.split('=');
        let value = rest.join('=').trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        cfg[key.trim()] = value;
    }
    return { ...defaults, ...cfg } as T;
}

/**
 * Initialize global configuration from config files.
 * This should only be called once at app startup.
 */
export function initConfig(
    rdPath = '/usr/local/etc/reflink_dedupe.conf',
    serverPath = '/usr/local/etc/reflink_dedupe_server.conf'
): AppConfig {
    if (config) return config; // prevent re-init

    const rdRaw = loadConfigFile(rdPath, ReflinkDedupeDefaults);
    const serverRaw = loadConfigFile(serverPath, ServerDefaults);

    config = {
        rd: rdRaw,
        server: serverRaw,
    };

    return config;
}

/**
 * Access the already-loaded configuration.
 * Throws if called before `initConfig()`.
 */
export function getConfig(): AppConfig {
    if (!config) {
        throw new Error('Config not initialized! Call initConfig() in main() first.');
    }
    return config;
}

