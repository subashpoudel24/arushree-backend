import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { escapeRegex, idParams, paged, pagination } from '../lib/validation.js';
import { requirePermission } from '../middleware/auth.js';
import { AuditLog, RolePermission } from '../models/Admin.js';
import { Order } from '../models/Commerce.js';
import { STAFF_ROLES, User, UserDocument } from '../models/User.js';
import { DEFAULT_PERMISSIONS, EditableRole, PERMISSIONS } from '../services/permissions.js';
import { revokeAllSessions } from '../services/tokens.js';

const adminUser = (user: UserDocument) => ({
  id: user.id as string,
  name: user.name,
  email: user.email,
  phone: user.phone ?? null,
  role: user.role,
  status: user.status,
  emailVerified: user.emailVerified,
  createdAt: user.createdAt,
});

const assertNotLastSuperAdmin = async (user: UserDocument) => {
  if (user.role !== 'super_admin') return;
  const others = await User.countDocuments({ role: 'super_admin', status: 'active', _id: { $ne: user._id } });
  if (!others) throw new ApiError(409, 'last_super_admin', 'The store must keep at least one active Super Admin.');
};

export const adminUsersRouter = Router();

adminUsersRouter.get('/customers', requirePermission('customers'), async (req, res) => {
  const query = z
    .object({ ...pagination, q: z.string().trim().max(100).optional(), status: z.enum(['active', 'blocked']).optional() })
    .parse(req.query);
  const pattern = query.q && { $regex: escapeRegex(query.q), $options: 'i' };
  const filter = {
    role: 'customer' as const,
    ...(query.status && { status: query.status }),
    ...(pattern && { $or: [{ name: pattern }, { email: pattern }, { phone: pattern }] }),
  };
  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    User.countDocuments(filter),
  ]);
  const counts = await Order.aggregate<{ _id: unknown; count: number }>([
    { $match: { user: { $in: users.map((user) => user._id) } } },
    { $group: { _id: '$user', count: { $sum: 1 } } },
  ]);
  const byUser = new Map(counts.map((row) => [String(row._id), row.count]));
  res.json(
    paged(
      users.map((user) => ({ ...adminUser(user), orderCount: byUser.get(user.id) ?? 0 })),
      total,
      query.page,
      query.limit
    )
  );
});

adminUsersRouter.get('/customers/:id', requirePermission('customers'), async (req, res) => {
  const { id } = idParams.parse(req.params);
  const user = await User.findOne({ _id: id, role: 'customer' });
  if (!user) throw new ApiError(404, 'not_found', 'Customer not found.');
  const [orders, spent] = await Promise.all([
    Order.find({ user: user._id })
      .select('orderNumber total status paymentStatus createdAt')
      .sort({ createdAt: -1 })
      .limit(50),
    Order.aggregate<{ total: number }>([
      { $match: { user: user._id, status: { $nin: ['canceled', 'pending_payment'] } } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]),
  ]);
  res.json({ customer: adminUser(user), orders, totalSpent: spent[0]?.total ?? 0 });
});

adminUsersRouter.patch('/customers/:id/status', requirePermission('customers'), async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { status } = z.object({ status: z.enum(['active', 'blocked']) }).parse(req.body);
  // Staff accounts are managed only through the staff screen.
  const user = await User.findOne({ _id: id, role: 'customer' });
  if (!user) throw new ApiError(404, 'not_found', 'Customer not found.');
  user.status = status;
  await user.save();
  if (status === 'blocked') await revokeAllSessions(user.id);
  res.json({ customer: adminUser(user) });
});

const staffRole = z.enum(['customer', 'editor', 'manager', 'super_admin']);

adminUsersRouter.get('/staff', requirePermission('staff'), async (_req, res) => {
  const users = await User.find({ role: { $in: STAFF_ROLES } }).sort({ name: 1 });
  res.json({ items: users.map(adminUser) });
});

// Promotes an existing account, so staff always set their own password.
adminUsersRouter.post('/staff', requirePermission('staff'), async (req, res) => {
  const body = z.object({ email: z.email().trim().toLowerCase(), role: z.enum(['editor', 'manager', 'super_admin']) }).parse(req.body);
  const user = await User.findOne({ email: body.email });
  if (!user) throw new ApiError(404, 'not_found', 'No account has this email. Ask them to sign up first.');
  user.role = body.role;
  await user.save();
  res.status(201).json({ staff: adminUser(user) });
});

adminUsersRouter.patch('/staff/:id', requirePermission('staff'), async (req, res) => {
  const { id } = idParams.parse(req.params);
  const body = z.object({ role: staffRole.optional(), status: z.enum(['active', 'blocked']).optional() }).parse(req.body);
  const user = await User.findOne({ _id: id, role: { $in: STAFF_ROLES } });
  if (!user) throw new ApiError(404, 'not_found', 'Staff member not found.');
  const losesSuperAdmin = (body.role && body.role !== 'super_admin') || body.status === 'blocked';
  if (losesSuperAdmin) await assertNotLastSuperAdmin(user);
  if (body.role) user.role = body.role;
  if (body.status) user.status = body.status;
  await user.save();
  if (body.status === 'blocked') await revokeAllSessions(user.id);
  res.json({ staff: adminUser(user) });
});

const roleParams = z.object({ role: z.enum(['manager', 'editor']) });

adminUsersRouter.get('/roles', requirePermission('staff'), async (_req, res) => {
  const saved = await RolePermission.find().lean();
  const read = (role: EditableRole) => saved.find((row) => row.role === role)?.permissions ?? DEFAULT_PERMISSIONS[role];
  res.json({ available: PERMISSIONS, roles: { manager: read('manager'), editor: read('editor') } });
});

adminUsersRouter.put('/roles/:role', requirePermission('staff'), async (req, res) => {
  const { role } = roleParams.parse(req.params);
  const { permissions } = z.object({ permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length) }).parse(req.body);
  await RolePermission.updateOne({ role }, { permissions: [...new Set(permissions)] }, { upsert: true });
  res.json({ role, permissions: [...new Set(permissions)] });
});

adminUsersRouter.get('/audit-logs', requirePermission('audit'), async (req, res) => {
  const { page, limit } = z.object(pagination).parse(req.query);
  const [items, total] = await Promise.all([
    AuditLog.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    AuditLog.countDocuments(),
  ]);
  res.json(paged(items, total, page, limit));
});
