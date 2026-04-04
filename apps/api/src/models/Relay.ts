import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface IRelayCapacity {
  maxConnections: number;
  bandwidth: number;
}

export interface IRelay extends Document {
  _id: Types.ObjectId;
  endpoint: string;
  publicKey: string;
  operator: "oxy" | "community";
  operatorUserId: string;
  capacity: IRelayCapacity;
  location: string;
  status: "active" | "degraded" | "offline";
  lastSeen: Date;
  createdAt: Date;
  updatedAt: Date;
}

const RelaySchema = new Schema<IRelay>(
  {
    endpoint: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    publicKey: {
      type: String,
      required: true,
    },
    operator: {
      type: String,
      enum: ["oxy", "community"],
      required: true,
    },
    operatorUserId: {
      type: String,
      required: true,
      index: true,
    },
    capacity: {
      maxConnections: { type: Number, required: true },
      bandwidth: { type: Number, required: true },
    },
    location: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["active", "degraded", "offline"],
      default: "offline",
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

export default mongoose.model<IRelay>("Relay", RelaySchema);
