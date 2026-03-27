import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface ITLD extends Document {
  _id: Types.ObjectId;
  name: string;
  status: "active" | "proposed" | "pending";
  proposedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const TLDSchema = new Schema<ITLD>(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "proposed", "pending"],
      default: "proposed",
    },
    proposedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

export default mongoose.model<ITLD>("TLD", TLDSchema);
