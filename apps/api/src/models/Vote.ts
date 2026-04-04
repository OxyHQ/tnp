import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface IVote extends Document {
  _id: Types.ObjectId;
  proposal: Types.ObjectId;
  user: Types.ObjectId;
  direction: "up" | "down";
  createdAt: Date;
  updatedAt: Date;
}

const VoteSchema = new Schema<IVote>(
  {
    proposal: {
      type: Schema.Types.ObjectId,
      ref: "TLDProposal",
      required: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    direction: {
      type: String,
      enum: ["up", "down"],
      required: true,
    },
  },
  { timestamps: true }
);

VoteSchema.index({ proposal: 1, user: 1 }, { unique: true });

export default mongoose.model<IVote>("Vote", VoteSchema);
