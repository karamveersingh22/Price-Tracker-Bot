import axios from "axios";
import { load as cheerioLoad } from "cheerio";

export async function fetchHTML(url) {
	const res = await axios.get(url, {
		headers: {
			// More realistic browser headers improve success rate across sites
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
			"Accept":
				"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
			"Cache-Control": "no-cache",
			"Pragma": "no-cache",
			"Upgrade-Insecure-Requests": "1",
			"Sec-Fetch-Dest": "document",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Site": "none",
			"Sec-Fetch-User": "?1",
		},
		timeout: 20000,
		// Follow redirects and disable decompression errors on odd servers
		maxRedirects: 5,
		decompress: true,
		validateStatus: (s) => s >= 200 && s < 400,
	});
	return res.data;
}

export function extractPriceFromText(text) {
	if (!text) return null;
	// Normalize whitespace and separators
	const cleaned = text
		.replace(/[\n\r]/g, " ")
		.replace(/\u00A0/g, " ") // non-breaking space
		.replace(/[, ](?=\d{3}(\D|$))/g, "") // remove thousands separators like 1,299
		.trim();

	// Extract currency-aware patterns first
	const currencyMatch = cleaned.match(
		/(USD|EUR|GBP|INR|Rs\.?|₹|\$|€|£)\s*([\d]+(?:[\.,][\d]{2})?|[\d]+(?:[\.,][\d]{3})*(?:[\.,][\d]{2})?)/i
	);
	if (currencyMatch) {
		const raw = currencyMatch[2].replace(/,/g, "").replace(/\s/g, "");
		const normalized = raw.replace(/(\d+)\.(\d{3})(?!\d)/, "$1$2"); // 1.299 -> 1299 if likely thousands
		const num = parseFloat(normalized.replace(/(\d+),(\d{2})$/, "$1.$2"));
		if (!isNaN(num)) return num;
	}

	// Fallback: pick plausible largest number
	const m = cleaned.match(/(\d+(?:[\.,]\d+)?)/g);
	if (!m) return null;
	const numbers = m
		.map((x) => x.replace(/,/g, ""))
		.map((x) => parseFloat(x))
		.filter((n) => !isNaN(n));
	if (!numbers.length) return null;
	// Heuristic: sort descending, take the first reasonable price (> 1)
	const sorted = numbers.sort((a, b) => b - a);
	const candidate = sorted.find((n) => n >= 1) ?? sorted[0];
	return candidate;
}

function extractTitle($) {
	const og = $('meta[property="og:title"]').attr('content');
	if (og) return og.trim();
	const title = $('title').first().text();
	if (title) return title.trim();
	const h1 = $('h1').first().text();
	if (h1) return h1.trim();
	return null;
}

function tryJSONLD($) {
	try {
		const scripts = $('script[type="application/ld+json"]').toArray();
		for (const s of scripts) {
			const txt = $(s).contents().text();
			if (!txt) continue;
			let data;
			try { data = JSON.parse(txt); } catch { continue; }
			const nodes = Array.isArray(data) ? data : [data];
			for (const node of nodes) {
				// Try Offer or Product with offers
				if (node && typeof node === 'object') {
					if (node['@type'] === 'Offer' && node.price) {
						const p = extractPriceFromText(String(node.price));
						if (p) return p;
					}
					if (node['@type'] === 'Product' && node.offers) {
						const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
						for (const off of offers) {
							if (off && off.price) {
								const p = extractPriceFromText(String(off.price));
								if (p) return p;
							}
						}
					}
				}
			}
		}
	} catch {}
	return null;
}


export async function getPrice(url) {
	try {
		const html = await fetchHTML(url);
		const $ = cheerioLoad(html);

		// Site-specific quick wins
		const siteSpecific = [
			// Amazon
			"#priceblock_ourprice",
			"#priceblock_dealprice",
			"#priceblock_saleprice",
			"span.a-price.aok-align-center.reinventPricePriceToPayMargin.priceToPay",
			".a-price .a-offscreen",
			// Flipkart
			"._30jeq3._16Jk6d",
			// Generic
			"meta[itemprop='price']",
			"meta[property='product:price:amount']",
			"[itemprop='price']",
			".price, .product-price, . Price, .productPrice",
			"span[class*='price'], div[class*='price']",
			"#price",
		];

		for (const sel of siteSpecific) {
			const el = $(sel).first();
			if (el && el.length) {
				const txt = el.attr("content") || el.text();
				const p = extractPriceFromText(txt);
				if (p) return p;
			}
		}

		// Structured data often has it
		const jsonLdPrice = tryJSONLD($);
		if (jsonLdPrice) return jsonLdPrice;

		// Fallback: search the whole HTML for currency + number
		const fallback = html.match(/(?:INR|Rs\.?|₹|USD|\$|EUR|€|GBP|£)\s*([\d,.]+(?:\.[\d]+)?)/i);
		if (fallback) {
			const num = parseFloat(fallback[1].replace(/,/g, ""));
			if (!isNaN(num)) return num;
		}

		// Broad extraction: find numbers in visible text blocks
		const allText = $("body").text();
		const p = extractPriceFromText(allText);
		if (p) return p;

		return null;
	} catch (err) {
		console.error("getPrice error:", err.message);
		return null;
	}
}

export async function getProductInfo(url) {
	try {
		const html = await fetchHTML(url);
		const $ = cheerioLoad(html);
		const price = await getPrice(url); // reuse logic (will fetch again if we don't optimize)
		const title = extractTitle($);
		return { price, title };
	} catch (err) {
		console.error("getProductInfo error:", err.message);
		return { price: null, title: null };
	}
}