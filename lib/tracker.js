import axios from "axios";
import { load as cheerioLoad } from "cheerio";

export async function fetchHTML(url) {
	const origin = (() => { try { return new URL(url).origin; } catch { return undefined; } })();
	const res = await axios.get(url, {
		headers: {
			// More realistic browser headers improve success rate across sites
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
			"Accept":
				"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
			// Bias for India retail sites
			"Accept-Language": "en-IN,en;q=0.9",
			// Some CDNs require a referer to serve content
			...(origin ? { Referer: origin } : {}),
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

function parseNumberFlexible(str) {
	if (!str) return null;
	let s = String(str).trim();
	// Remove currency symbols and spaces
	s = s.replace(/[₹$€£]|INR|USD|EUR|GBP|Rs\.?/gi, "").replace(/\s+/g, "");
	// Normalize Indian numbering commas by removing all commas
	s = s.replace(/,/g, "");
	// If multiple dots, keep only the first as decimal separator by removing others
	const parts = s.split('.');
	if (parts.length > 2) {
		s = parts.slice(0, parts.length - 1).join('') + '.' + parts[parts.length - 1];
	}
	const num = parseFloat(s);
	return Number.isFinite(num) ? num : null;
}

function extractAllCurrencyPrices(text) {
	if (!text) return [];
	const out = [];
	const re = /(?:INR|Rs\.?|₹|USD|\$|EUR|€|GBP|£)\s*([\d.,]+(?:\.[\d]{1,2})?)/gi;
	let m;
	while ((m = re.exec(text)) !== null) {
		const raw = m[1];
		const num = parseNumberFlexible(raw);
		if (num != null) out.push(num);
	}
	return out;
}

function pickBestPrice(candidates, currencyHint) {
	const uniq = Array.from(new Set(candidates.filter((n) => Number.isFinite(n) && n > 0)));
	if (!uniq.length) return null;
	// Heuristics: for INR, ignore tiny amounts that are likely shipping/addons
	const minByCurrency = (currencyHint || '').toUpperCase().includes('INR') || currencyHint === '₹' ? 50 : 0.5;
	const filtered = uniq.filter((n) => n >= minByCurrency);
	if (!filtered.length) return Math.min(...uniq);
	// Prefer the most frequent value if duplicates exist
	const counts = new Map();
	for (const n of filtered) counts.set(n, (counts.get(n) || 0) + 1);
	const sorted = [...filtered].sort((a, b) => (counts.get(b) - counts.get(a)) || a - b);
	return sorted[0];
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
			const flatten = (obj) => Array.isArray(obj) ? obj : (obj && obj['@graph'] ? obj['@graph'] : [obj]);
			const nodes = flatten(data).filter(Boolean);
			const found = [];
			for (const node of nodes) {
				if (typeof node !== 'object') continue;
				const type = Array.isArray(node['@type']) ? node['@type'].join(',') : node['@type'];
				const currency = node.priceCurrency || node.currency || node.pricingCurrency || '';
				const pushIf = (val) => { const n = parseNumberFlexible(val); if (n != null) found.push({ n, currency }); };
				if (type && /Offer/i.test(type)) {
					if (node.price) pushIf(node.price);
					if (node.lowPrice) pushIf(node.lowPrice);
					if (node.highPrice) pushIf(node.highPrice);
				}
				if (type && /Product/i.test(type)) {
					if (node.offers) {
						const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
						for (const off of offers) {
							if (!off) continue;
							const cur = off.priceCurrency || currency;
							['price', 'lowPrice', 'highPrice'].forEach((k) => {
								if (off[k] != null) {
									const n = parseNumberFlexible(off[k]);
									if (n != null) found.push({ n, currency: cur });
								}
							});
						}
					}
				}
			}
			if (found.length) {
				// Prefer the lowest offer price
				const prices = found.map((x) => x.n);
				return Math.min(...prices);
			}
		}
	} catch {}
	return null;
}

function tryEmbeddedJSON($, html, hostname) {
	try {
		const texts = $('script').toArray().map((s) => $(s).contents().text()).filter(Boolean);
		const prices = [];
		const push = (n) => { const x = parseNumberFlexible(n); if (x != null) prices.push(x); };
		for (const txt of texts) {
			// Flipkart specific keys observed in embedded state
			// Look for objects containing finalPrice/sellingPrice with amount/value
			const re1 = /\b(finalPrice|sellingPrice|marketplaceSellerSellingPrice|price)\b\s*:\s*\{[^}]*?(amount|value)\s*:\s*(\d+(?:\.\d+)?)\b/gi;
			let m1;
			while ((m1 = re1.exec(txt)) !== null) {
				push(m1[3]);
			}
			// Generic: price value pairs like "price":12345 or "price":"12345"
			const re2 = /\bprice\b\s*:\s*"?(\d{3,}(?:\.\d{1,2})?)"?/gi;
			let m2;
			while ((m2 = re2.exec(txt)) !== null) {
				push(m2[1]);
			}
			// Generic amount fields
			const re3 = /\b(amount|value)\b\s*:\s*"?(\d{3,}(?:\.\d{1,2})?)"?/gi;
			let m3;
			while ((m3 = re3.exec(txt)) !== null) {
				push(m3[2]);
			}
		}
		if (prices.length) return Math.min(...prices);
	} catch {}
	return null;
}

function domainSpecificSelectors(hostname) {
	const h = (hostname || '').toLowerCase();
	const sel = [];
	if (h.includes('amazon')) {
		sel.push(
			"#corePrice_feature_div .a-price .a-offscreen",
			"#priceblock_ourprice",
			"#priceblock_dealprice",
			"#priceblock_saleprice",
			".a-price .a-offscreen",
			"span.a-price-whole"
		);
	}
		if (h.includes('flipkart')) {
			sel.push(
				"._30jeq3._16Jk6d",
				"._30jeq3",
				"._16Jk6d",
				"._25b18c ._30jeq3",
				"div[class*='price'] span[class*='_30jeq3']",
				"meta[itemprop='price']",
				"meta[property='og:price:amount']"
			);
		}
	if (h.includes('myntra')) {
		sel.push(
			".pdp-price .pdp-price_value",
			"span.pdp-price"
		);
	}
	if (h.includes('ajio')) {
		sel.push(
			".prod-sp",
			".price-now",
			".product-price .price"
		);
	}
	if (h.includes('croma')) {
		sel.push(
			"#pdp-product-price",
			".pdpPrice",
			"[data-amount]"
		);
	}
	if (h.includes('reliancedigital')) {
		sel.push(
			".pdp__price",
			"[itemprop='price']"
		);
	}
	if (h.includes('tatacliq')) {
		sel.push(
			"[data-test='pdpSalePrice']",
			"[data-test='pdpMrpPrice']"
		);
	}
	if (h.includes('snapdeal')) {
		sel.push(
			".payBlkBig",
			"[itemprop='price']"
		);
	}
	if (h.includes('meesho')) {
		sel.push(
			"[class*='price']",
			"[itemprop='price']"
		);
	}
	// Generic selectors at the end
	sel.push(
		"meta[itemprop='price']",
		"meta[property='product:price:amount']",
		"meta[property='og:price:amount']",
		"meta[name='twitter:data1']",
		"[itemprop='price']",
		".price, .product-price, . Price, .productPrice",
		"span[class*='price'], div[class*='price']",
		"#price"
	);
	return sel;
}

function extractFromSelectors($, html, selectors) {
	const candidates = [];
	for (const sel of selectors) {
		const el = $(sel).first();
		if (!el || !el.length) continue;
		const txt = el.attr("content") || el.attr("data-amount") || el.text();
		const n1 = extractPriceFromText(txt);
		const n2 = parseNumberFlexible(txt);
		if (n1 != null) candidates.push(n1);
		if (n2 != null) candidates.push(n2);
	}
	// twitter:data1 may contain "Price: ₹1,234"; try to parse trailing number
	const twitter = $('meta[name="twitter:data1"]').attr('content');
	if (twitter) {
		const prices = extractAllCurrencyPrices(twitter);
		candidates.push(...prices);
	}
	return candidates;
}

export async function getPrice(url) {
	try {
		const html = await fetchHTML(url);
		const $ = cheerioLoad(html);
		const { hostname } = new URL(url);

		// 1) Domain-specific + strong generic selectors
		const selectors = domainSpecificSelectors(hostname);
		const cands1 = extractFromSelectors($, html, selectors);
		const price1 = pickBestPrice(cands1, html.includes('₹') ? 'INR' : '');
		if (price1 != null) return price1;

		// 2) Structured data (JSON-LD)
		const jsonLdPrice = tryJSONLD($);
		if (jsonLdPrice != null) return jsonLdPrice;

		// 2b) Embedded JSON blobs (Flipkart and others emit window state)
		const embedded = tryEmbeddedJSON($, html, hostname);
		if (embedded != null) return embedded;

		// 3) Currency-anchored regex across HTML
		const pricesInHtml = extractAllCurrencyPrices(html);
		const price2 = pickBestPrice(pricesInHtml, html.includes('₹') ? 'INR' : '');
		if (price2 != null) return price2;

		// 4) Visible body text scan anchored by currency
		const allText = $("body").text();
		const pricesInText = extractAllCurrencyPrices(allText);
		const price3 = pickBestPrice(pricesInText, allText.includes('₹') ? 'INR' : '');
		if (price3 != null) return price3;

		// 5) Label-guided scan (MRP|Price|Deal Price) followed by number
		const labelMatch = allText.match(/(?:Deal Price|Price|MRP)\s*[:\-]?\s*([₹$€£]?[\s\d,.]+)/i);
		if (labelMatch) {
			const n = parseNumberFlexible(labelMatch[1]);
			if (n != null) return n;
		}

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
		const title = extractTitle($);
		// Avoid double-fetch: reuse parsed html via internal extraction
		const tmpDocUrl = new URL(url);
		const price = (function() {
			// Inline similar steps to getPrice but reusing $ and html
			const selectors = domainSpecificSelectors(tmpDocUrl.hostname);
			const cands1 = extractFromSelectors($, html, selectors);
			const price1 = pickBestPrice(cands1, html.includes('₹') ? 'INR' : '');
			if (price1 != null) return price1;
			const jsonLdPrice = tryJSONLD($);
			if (jsonLdPrice != null) return jsonLdPrice;
			const embedded = tryEmbeddedJSON($, html, tmpDocUrl.hostname);
			if (embedded != null) return embedded;
			const pricesInHtml = extractAllCurrencyPrices(html);
			const price2 = pickBestPrice(pricesInHtml, html.includes('₹') ? 'INR' : '');
			if (price2 != null) return price2;
			const allText = $("body").text();
			const pricesInText = extractAllCurrencyPrices(allText);
			const price3 = pickBestPrice(pricesInText, allText.includes('₹') ? 'INR' : '');
			if (price3 != null) return price3;
			const labelMatch = allText.match(/(?:Deal Price|Price|MRP)\s*[:\-]?\s*([₹$€£]?[\s\d,.]+)/i);
			if (labelMatch) {
				const n = parseNumberFlexible(labelMatch[1]);
				if (n != null) return n;
			}
			return null;
		})();
		return { price, title };
	} catch (err) {
		console.error("getProductInfo error:", err.message);
		return { price: null, title: null };
	}
}