import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { csrfProtection, limiters, rejectMongoOperators } from './middleware/security.js';
import { accountRouter } from './routes/account.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { cartRouter } from './routes/cart.js';
import { catalogRouter } from './routes/catalog.js';
import { addressRouter, checkoutRouter, deliveryRouter } from './routes/checkout.js';
import { contentRouter } from './routes/content.js';
import { favoritesRouter } from './routes/favorites.js';
import { ordersRouter, paymentsRouter } from './routes/orders.js';

export const createApp = () => {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      autoLogging: env.NODE_ENV !== 'test',
      // Method, path and status only. Headers hold cookies and CSRF tokens.
      serializers: {
        req: (req) => ({ method: req.method, url: req.url?.split('?')[0] }),
        res: (res) => ({ status: res.statusCode }),
      },
    })
  );
  app.use(helmet());
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(rejectMongoOperators);
  app.use(limiters.general);

  const api = Router();
  api.get('/health', (_req, res) => {
    const database = mongoose.connection.readyState === 1 ? 'up' : 'down';
    res.status(database === 'up' ? 200 : 503).json({ status: database === 'up' ? 'ok' : 'degraded', database });
  });
  api.use(csrfProtection);
  api.use(catalogRouter);
  api.use(contentRouter);
  api.use('/favorites', favoritesRouter);
  api.use('/cart', cartRouter);
  api.use('/delivery', deliveryRouter);
  api.use('/addresses', addressRouter);
  api.use('/checkout', checkoutRouter);
  api.use('/orders', ordersRouter);
  api.use('/payments', paymentsRouter);
  api.use('/auth', authRouter);
  api.use('/account', accountRouter);
  api.use('/admin', adminRouter);

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler);

  return app;
};
