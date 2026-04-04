import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface ITLDProposal extends Document {
  _id: Types.ObjectId;
  tld: string;
  proposedBy: Types.ObjectId;
  reason: string;
  status: "open" | "approved" | "rejected";
  createdAt: Date;
  updatedAt: Date;
}

const TLDProposalSchema = new Schema<ITLDProposal>(
  {
    tld: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    proposedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reason: {
      type: String,
      required: true,
      maxlength: 500,
    },
    status: {
      type: String,
      enum: ["open", "approved", "rejected"],
      default: "open",
    },
  },
  { timestamps: true }
);

export default mongoose.model<ITLDProposal>("TLDProposal", TLDProposalSchema);
