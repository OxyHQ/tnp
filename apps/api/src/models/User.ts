import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface IUser extends Document {
  _id: Types.ObjectId;
  oxyUserId: string;
  domains: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    oxyUserId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    domains: [
      {
        type: Schema.Types.ObjectId,
        ref: "Domain",
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model<IUser>("User", UserSchema);
