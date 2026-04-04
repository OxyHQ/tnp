import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface IServiceNode extends Document {
  _id: Types.ObjectId;
  domainId: Types.ObjectId;
  oxyUserId: string;
  publicKey: string;
  connectedRelay: string;
  status: "online" | "offline";
  lastSeen: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ServiceNodeSchema = new Schema<IServiceNode>(
  {
    domainId: {
      type: Schema.Types.ObjectId,
      ref: "Domain",
      required: true,
      unique: true,
      index: true,
    },
    oxyUserId: {
      type: String,
      required: true,
      index: true,
    },
    publicKey: {
      type: String,
      required: true,
    },
    connectedRelay: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["online", "offline"],
      default: "offline",
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

export default mongoose.model<IServiceNode>("ServiceNode", ServiceNodeSchema);
