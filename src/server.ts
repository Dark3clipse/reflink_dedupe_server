import express from 'express';
import expressPino from 'express-pino-logger';
import yaml from 'yaml';
import swaggerUi from 'swagger-ui-express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.ts';
import { tracedRoute } from './utils/traceRoute.ts';
import { makeAuthMiddleware } from './utils/auth.ts';
import { initConfig } from './utils/config.ts';
import type { AppConfig } from './utils/config.ts';
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

  const torrentsDir = path.join(appConfig.server.TMP_DIR, 'torrents');
  fs.mkdirSync(torrentsDir, { recursive: true });

  initDatabases();

  const app = express();
  app.use(expressPino({ logger }));
  app.use(express.tson());
  app.use(makeAuthMiddleware(appConfig.server));

  if (logger.level === 'trace') {
    app.use((req, res, next) => {
      const oldJson = res.tson;
      res.tson = function (body) {
        logger.trace({ url: req.originalUrl, body }, 'Response JSON');
        return oldJson.call(this, body);
      };
      next();
    });
  }

  const specPath = path.resolve('./openapi/openapi.yaml');
  const openapiSpec = yaml.parse(fs.readFileSync(specPath, 'utf8'));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

  // Routes
  /*app.post('/torrent/upload', upload.single('torrentFile'), tracedRoute(uploadTorrent, 'uploadTorrent'));
  app.delete('/torrent/:id', tracedRoute(deleteTorrent, 'deleteTorrent'));
  app.get('/torrent/:id', tracedRoute(getTorrentMetadata, 'getTorrentMetadata'));
  app.get('/torrent/:id/filetree', tracedRoute(getTorrentFiletree, 'getTorrentFiletree'));
  app.post('/duplicates/report', tracedRoute(reportDuplicate, 'reportDuplicate'));
  app.post('/duplicates/create', tracedRoute(createDuplicate, 'createDuplicate'));*/

  app.listen(appConfig.server.PORT, () => {
    logger.info(`Server started on port ${appConfig.server.PORT}`);
  });
}

main().catch(err => {
  logger.error(err, 'Failed to start server');
  process.exit(1);
});
