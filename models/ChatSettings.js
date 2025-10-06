import mongoose from "mongoose";

const ChatSettingsSchema = new mongoose.Schema({
  chatId: { type: String, required: true, unique: true },
  intervalMinutes: { type: Number, default: 1 },
  updatedAt: { type: Date, default: Date.now },
});

ChatSettingsSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.models.ChatSettings ||
  mongoose.model("ChatSettings", ChatSettingsSchema);
