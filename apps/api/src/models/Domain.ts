import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface IRecord {
  _id?: Types.ObjectId;
  type: "A" | "AAAA" | "CNAME" | "TXT" | "MX" | "NS";
  name: string;
  value: string;
  ttl: number;
}

export interface IDomain extends Document {
  _id: Types.ObjectId;
  name: string;
  tld: string;
  ownerId: Types.ObjectId;
  oxyUserId: string;
  status: "active" | "pending" | "suspended";
  records: IRecord[];
  serviceNodeId?: Types.ObjectId;
  serviceNodePubKey?: string;
  createdAt: Date;
  expiresAt: Date;
  updatedAt: Date;
}

const RecordSchema = new Schema<IRecord>(
  {
    type: {
      type: String,
      enum: ["A", "AAAA", "CNAME", "TXT", "MX", "NS"],
      required: true,
    },
    name: { type: String, required: true, default: "@" },
    value: { type: String, required: true },
    ttl: { type: Number, default: 3600 },
  },
  { _id: true }
);

const DomainSchema = new Schema<IDomain>(
  {
    name: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    tld: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    oxyUserId: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "pending", "suspended"],
      default: "active",
    },
    records: [RecordSchema],
    serviceNodeId: {
      type: Schema.Types.ObjectId,
      ref: "ServiceNode",
    },
    serviceNodePubKey: {
      type: String,
    },
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

DomainSchema.index({ name: 1, tld: 1 }, { unique: true });

export default mongoose.model<IDomain>("Domain", DomainSchema);
