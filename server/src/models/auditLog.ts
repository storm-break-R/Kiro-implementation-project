import { Schema, model } from 'mongoose';

const auditLogSchema = new Schema(
  {
    seq: { type: Number, required: true, unique: true },
    ts: { type: Date, required: true },
    actorId: { type: String },
    actorRole: { type: String },
    action: { type: String, required: true },
    target: { type: String },
    ip: { type: String },
    meta: { type: Schema.Types.Mixed },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { timestamps: false, minimize: false },
);

export const AuditLog = model('AuditLog', auditLogSchema);
