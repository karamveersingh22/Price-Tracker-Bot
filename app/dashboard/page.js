"use client";
import React, { useState, useEffect } from "react";

export default function Dashboard() {
  const [products, setProducts] = useState([]);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [auto, setAuto] = useState(false);

  async function load() {
    const res = await fetch("/api/products");
    const arr = await res.json();
    setProducts(arr);
  }

  useEffect(() => {
    load();
  }, []);

  // Auto check every 60s when enabled
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => {
      triggerCheck();
    }, 60_000);
    return () => clearInterval(id);
  }, [auto]);

  async function add() {
    setLoading(true);
    setMessage("");
    const res = await fetch("/api/products", {
      method: "POST",
      body: JSON.stringify({ url }),
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (res.ok) {
      setMessage(`Added: ${data.title ? data.title + " — " : ""}${data.url} ${data.lastPrice != null ? "(₹" + data.lastPrice + ")" : ""}`);
      setUrl("");
      await load();
    } else {
      setMessage(data?.error || "Failed to add");
    }
    setLoading(false);
  }

  async function triggerCheck() {
    setLoading(true);
    setMessage("");
    const res = await fetch("/api/check", {
      method: "POST",
      headers: { "x-check-secret": process.env.NEXT_PUBLIC_CHECK_SECRET || "" },
    });
    try {
      const json = await res.json();
      if (json && Array.isArray(json.results)) {
        const changed = json.results.filter(r => r.status === 'changed');
        const nochange = json.results.filter(r => r.status === 'no-change');
        const initialized = json.results.filter(r => r.status === 'initialized');
        if (changed.length) {
          setMessage(`Price changed for ${changed.length} item(s).`);
        } else if (initialized.length) {
          setMessage(`Initialized ${initialized.length} item(s).`);
        } else if (nochange.length) {
          setMessage(`No price change for ${nochange.length} item(s).`);
        } else {
          setMessage("No results.");
        }
      }
    } catch {}
    await load();
    setLoading(false);
  }

  async function remove(u) {
    await fetch("/api/products", {
      method: "DELETE",
      body: JSON.stringify({ url: u }),
      headers: { "Content-Type": "application/json" },
    });
    await load();
  }

  return (
    <main className="w-screen h-full bg-gray-800 flex flex-col p-2 m-auto">
      <h1>Price Tracker Dashboard</h1>
      {message ? (
        <div className="bg-blue-900 text-amber-500 font-bold p-2 m-2">{message}</div>
      ) : null}
      <div className="flex w-1/2 gap-2 m-2 p-2 text-amber-500 bg-blue-900">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
          style={{ width: 400 }}
        />
        <button onClick={add} disabled={loading || !url}>
          {loading ? 'Working…' : 'Add'}
        </button>
        <button onClick={triggerCheck} disabled={loading}>
          {loading ? 'Checking…' : 'Trigger Check'}
        </button>
        <label>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-check every 1 min
        </label>
      </div>

      <ul>
        {products.map((p) => (
          <li key={p._id} style={{ marginTop: 8 }}>
            <a href={p.url} target="_blank" rel="noreferrer">
              {p.url}
            </a>{" "}
            - {p.title ? `${p.title} — ` : ''}Last: {p.lastPrice ?? "N/A"}
            {p.lastCheckedAt ? (
              <span style={{marginLeft: 8, color: '#666'}}>
                (checked {new Date(p.lastCheckedAt).toLocaleString()})
              </span>
            ) : null}
            <button onClick={() => remove(p.url)}>Remove</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
