import { Schema, Types, model } from 'mongoose';

interface IRolePermission {
  role: 'manager' | 'editor';
  permissions: string[];
}

const rolePermissionSchema = new Schema<IRolePermission>(
  {
    role: { type: String, enum: ['manager', 'editor'], required: true, unique: true },
    permissions: { type: [String], default: [] },
  },
  { timestamps: true }
);
export const RolePermission = model<IRolePermission>('RolePermission', rolePermissionSchema);

interface IAuditLog {
  actor: Types.ObjectId;
  actorName: string;
  actorEmail: string;
  method: string;
  path: string;
  fields: string[];
  status: number;
  ip?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, required: true },
    actorEmail: { type: String, required: true },
    method: { type: String, required: true },
    path: { type: String, required: true },
    fields: { type: [String], default: [] }, // Field names only, never their values.
    status: { type: Number, required: true },
    ip: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
auditLogSchema.index({ createdAt: -1 });
export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema);

interface ISetting {
  key: string;
  value: unknown;
}

const settingSchema = new Schema<ISetting>(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);
export const Setting = model<ISetting>('Setting', settingSchema);
