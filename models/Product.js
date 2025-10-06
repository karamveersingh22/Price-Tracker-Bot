import mongoose from "mongoose";

const ProductSchema = new mongoose.Schema({
  url: { type: String, required: true, unique: true },
  lastPrice: { type: Number, required: false },
  chatId: { type: String, required: false },
  title: { type: String },
  lastCheckedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

ProductSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.models.Product ||
  mongoose.model("Product", ProductSchema);
