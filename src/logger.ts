import pino from 'pino';

// Configure pino with pretty-print for development
export const logger = pino({
    level: process.env.LOG_LEVEL || 'trace',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: "yyyy-mm-dd'T'HH:MM:ss.l'Z'",
            ignore: 'pid,hostname'
        }
    }
});
