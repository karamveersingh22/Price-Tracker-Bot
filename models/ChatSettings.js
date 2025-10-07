import mongoose from "mongoose";

const ChatSettingsSchema = new mongoose.Schema({
  chatId: { type: String, required: true, unique: true },
  // Default to 180 minutes (3 hours) as requested
  intervalMinutes: { type: Number, default: 180 },
  updatedAt: { type: Date, default: Date.now },
});

ChatSettingsSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.models.ChatSettings ||
  mongoose.model("ChatSettings", ChatSettingsSchema);
