import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './lib/db.js';
import { logger } from './lib/logger.js';
import { startOrderJobs } from './services/orders.js';

const start = async () => {
  await connectDatabase(env.MONGODB_URI);
  const server = createApp().listen(env.PORT, (err?: Error) => {
    if (err) {
      logger.fatal({ err }, 'Could not open the API port');
      process.exit(1);
    }
    logger.info(`API listening on port ${env.PORT}`);
    startOrderJobs();
  });

  const shutdown = () => {
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start API');
  process.exit(1);
});
