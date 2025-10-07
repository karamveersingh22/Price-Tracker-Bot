import dbConnect from "@/lib/dbConnect";
import Product from "@/models/Product";
import { getProductInfo, getPrice } from "@/lib/tracker";


export async function GET() {
const uri = process.env.MONGODB_URI;
await dbConnect(uri);
const products = await Product.find({}).sort({ updatedAt: -1 }).lean();
return new Response(JSON.stringify(products), { status: 200 });
}


export async function POST(request) {
const uri = process.env.MONGODB_URI;
await dbConnect(uri);
const body = await request.json();
const { url, chatId } = body;
if (!url) return new Response(JSON.stringify({ error: 'missing url' }), { status: 400 });


// Prevent duplicates across same chat if chatId provided, otherwise global URL duplicate
const existing = chatId ? await Product.findOne({ url, chatId }) : await Product.findOne({ url });
if (existing) return new Response(JSON.stringify({ error: 'already exists' }), { status: 409 });

// Try to fetch initial info (best-effort)
let initialPrice = null;
let title = null;
try {
	const info = await getProductInfo(url);
	initialPrice = info.price ?? null;
	title = info.title ?? null;
} catch {}

const p = new Product({ url, chatId, lastPrice: initialPrice, title });
await p.save();
return new Response(JSON.stringify(p), { status: 201 });
}


export async function DELETE(request) {
const uri = process.env.MONGODB_URI;
await dbConnect(uri);
const { url } = await request.json();
if (!url) return new Response(JSON.stringify({ error: 'missing url' }), { status: 400 });
await Product.deleteOne({ url });
return new Response(JSON.stringify({ ok: true }), { status: 200 });
}