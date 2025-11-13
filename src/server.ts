import express from 'express';
import expressPino from 'express-pino-logger';
import yaml from 'yaml';
import swaggerUi from 'swagger-ui-express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.ts';
import { tracedRoute, makeResponseBodyMiddleware } from './utils/traceRoute.ts';
import { makeAuthMiddleware } from './utils/auth.ts';
import { makeRequestIdMiddleware } from './utils/requestId.ts';
import { initConfig } from './utils/config.ts';
import type { AppConfig } from './utils/config.ts';
import { initPaths } from './utils/paths.ts';
import { initDatabases } from './db/index.ts';
import { uploadTorrent } from './paths/torrent/upload.ts';
import { deleteTorrent } from './paths/torrent/delete.ts';
import { getTorrentMetadata } from './paths/torrent/metadata.ts';
import { getTorrentFiletree } from './paths/torrent/filetree.ts';
import { reportDuplicate } from './paths/duplicates/report.ts';
import { createDuplicate } from './paths/duplicates/create.ts';


const upload = multer({ storage: multer.memoryStorage() });

async function main() {
  const appConfig = initConfig();
  const paths = initPaths();
  initDatabases();

  const app = express();
  app.use(expressPino({ logger }));
  app.use(express.json());
  app.use(makeRequestIdMiddleware());
  app.use(makeAuthMiddleware(appConfig.server));
  if (logger.level === 'trace') {
    app.use(makeResponseBodyMiddleware());
  }

  const specPath = path.resolve('./openapi/openapi.yaml');
  const openapiSpec = yaml.parse(fs.readFileSync(specPath, 'utf8'));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

  // Routes
  app.post('/torrent/upload', upload.single('torrentFile'), tracedRoute(uploadTorrent, 'uploadTorrent'));
  app.delete('/torrent/:id', tracedRoute(deleteTorrent, 'deleteTorrent'));
  app.get('/torrent/:id', tracedRoute(getTorrentMetadata, 'getTorrentMetadata'));
  app.get('/torrent/:id/filetree', tracedRoute(getTorrentFiletree, 'getTorrentFiletree'));
  app.post('/duplicates/report', tracedRoute(reportDuplicate, 'reportDuplicate'));
  app.post('/duplicates/create', tracedRoute(createDuplicate, 'createDuplicate'));

  app.listen(appConfig.server.PORT, () => {
    logger.info(`Server started on port ${appConfig.server.PORT}`);
  });
}

main().catch(err => {
  logger.error(err, 'Failed to start server');
  process.exit(1);
});
