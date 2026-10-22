import express from 'express';
import { authRouter } from './routes/auth.routes.js';
import { auditRouter } from './routes/audit.routes.js';
import { productsRouter } from './routes/products.routes.js';
import { metalRatesRouter } from './routes/metal-rates.routes.js';
import { locationsRouter } from './routes/locations.routes.js';
import { purchasesRouter, suppliersRouter } from './routes/purchases.routes.js';
import { stockRouter } from './routes/stock.routes.js';
import { customersRouter } from './routes/customers.routes.js';
import { salesRouter } from './routes/sales.routes.js';
import { paymentsRouter } from './routes/payments.routes.js';
import { creditRouter } from './routes/credit.routes.js';
import { ordersRouter } from './routes/orders.routes.js';
import { pledgesRouter } from './routes/pledges.routes.js';
import { chitsRouter } from './routes/chits.routes.js';
import { approvalsRouter } from './routes/approvals.routes.js';
import { reportsRouter } from './routes/reports.routes.js';
import { usersRouter } from './routes/users.routes.js';
import { backupRouter } from './routes/backup.routes.js';
import { errorToResponse } from './lib/errors.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  // Conservative CORS for the known local dev UI origins only.
  // TODO(OWNER_POLICY): confirm allowed origins for the deployed environment.
  const allowedOrigins = (process.env.RSK_CORS_ORIGINS || 'http://localhost:8765,http://127.0.0.1:8765').split(',').map((o) => o.trim().replace(/\/$/, ''));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/api/v1/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/audit-logs', auditRouter);
  app.use('/api/v1/products', productsRouter);
  app.use('/api/v1/metal-rates', metalRatesRouter);
  app.use('/api/v1/locations', locationsRouter);
  app.use('/api/v1/suppliers', suppliersRouter);
  app.use('/api/v1/purchases', purchasesRouter);
  app.use('/api/v1/stock', stockRouter);
  app.use('/api/v1/customers', customersRouter);
  app.use('/api/v1/sales', salesRouter);
  app.use('/api/v1/payments', paymentsRouter);
  app.use('/api/v1/credit', creditRouter);
  app.use('/api/v1/orders', ordersRouter);
  app.use('/api/v1/pledges', pledgesRouter);
  app.use('/api/v1/chits', chitsRouter);
  app.use('/api/v1/approvals', approvalsRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/backup', backupRouter);

  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

  // Never leak stack traces to the client.
  app.use((err, req, res, _next) => {
    const mapped = errorToResponse(err);
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(err);
    res.status(500).json({ error: 'INTERNAL', message: 'Unexpected server error.' });
  });

  return app;
}
