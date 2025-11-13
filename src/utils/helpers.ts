import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';

/**
 * Ensure a directory exists.
 */
export function ensureDir(dir: string) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Convert byte size to a human-readable format.
 */
export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Time an async function and return both result + elapsed time.
 */
export async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
    const start = performance.now();
    const result = await fn();
    const end = performance.now();
    return [result, end - start];
}

/**
 * Safely join paths relative to a base directory.
 */
export function safeJoin(base: string, target: string): string {
    const resolved = path.resolve(base, target);
    if (!resolved.startsWith(path.resolve(base))) {
        throw new Error(`Invalid path outside of base: ${target}`);
    }
    return resolved;
}

