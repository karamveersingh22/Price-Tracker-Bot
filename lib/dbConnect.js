import mongoose from "mongoose";


let cached = global.mongoose;
if (!cached) cached = global.mongoose = { conn: null, promise: null };

export default async function dbConnect(uri) {
if (cached.conn) return cached.conn;
if (!cached.promise) {
cached.promise = mongoose.connect(uri, {
dbName: "pricebot",
}).then((m) => m.connection);
}
cached.conn = await cached.promise;
return cached.conn;
};