import { Router } from 'express';
import { auditWrites, requireAuth, requireStaff } from '../middleware/auth.js';
import { toPublicUser } from '../models/User.js';
import { permissionsFor } from '../services/permissions.js';
import { adminCatalogRouter } from './adminCatalog.js';
import { adminCommerceRouter } from './adminCommerce.js';
import { adminContentRouter } from './adminContent.js';
import { adminOpsRouter } from './adminOps.js';
import { adminOrdersRouter } from './adminOrders.js';
import { adminUsersRouter } from './adminUsers.js';

// Every route added here is staff-only, and every change made here is audited.
export const adminRouter = Router();
adminRouter.use(requireAuth, requireStaff, auditWrites);

adminRouter.get('/session', async (req, res) => {
  res.json({ user: toPublicUser(req.user!), permissions: await permissionsFor(req.user!.role) });
});

adminRouter.use(adminCatalogRouter);
adminRouter.use(adminCommerceRouter);
adminRouter.use(adminContentRouter);
adminRouter.use(adminOrdersRouter);
adminRouter.use(adminUsersRouter);
adminRouter.use(adminOpsRouter);
