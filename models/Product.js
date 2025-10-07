import mongoose from "mongoose";

const ProductSchema = new mongoose.Schema({
  url: { type: String, required: true },
  lastPrice: { type: Number, required: false },
  chatId: { type: String, required: false },
  title: { type: String },
  lastCheckedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Ensure a chat can track the same URL independently of other chats
ProductSchema.index({ chatId: 1, url: 1 }, { unique: true });

ProductSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.models.Product ||
  mongoose.model("Product", ProductSchema);
