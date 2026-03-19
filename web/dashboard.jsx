import { useState, useEffect, useCallback, useRef } from "react";

const API_BASE = "/api/v1";

// ═══════════════════════════════════════════════════════════
// LUXXPOOL DASHBOARD — Scrypt Multi-Coin Mining Command Center
// ═══════════════════════════════════════════════════════════

const COINS = [
  { sym: "LTC", name: "Litecoin", color: "#345D9D", role: "parent" },
  { sym: "DOGE", name: "Dogecoin", color: "#C2A633", role: "aux" },
  { sym: "BELLS", name: "Bellscoin", color: "#D4763C", role: "aux" },
  { sym: "LKY", name: "Luckycoin", color: "#4CAF50", role: "aux" },
  { sym: "PEP", name: "Pepecoin", color: "#2E7D32", role: "aux" },
  { sym: "JKC", name: "Junkcoin", color: "#78909C", role: "aux" },
  { sym: "DINGO", name: "Dingocoin", color: "#E8891D", role: "aux" },
  { sym: "SHIC", name: "Shibacoin", color: "#FF6F00", role: "aux" },
  { sym: "TRMP", name: "TrumPOW", color: "#C62828", role: "aux" },
  { sym: "CRC", name: "CraftCoin", color: "#6A1B9A", role: "aux" },
];

function formatHashrate(h) {
  if (!h || h === 0) return "0 H/s";
  const units = [
    { s: "EH/s", d: 1e18 }, { s: "PH/s", d: 1e15 },
    { s: "TH/s", d: 1e12 }, { s: "GH/s", d: 1e9 },
    { s: "MH/s", d: 1e6 },  { s: "KH/s", d: 1e3 },
    { s: "H/s", d: 1 },
  ];
  for (const u of units) if (h >= u.d) return (h / u.d).toFixed(2) + " " + u.s;
  return h.toFixed(2) + " H/s";
}

function timeAgo(ts) {
  if (!ts) return "—";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return Math.floor(diff / 1000) + "s ago";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
  return Math.floor(diff / 86400000) + "d ago";
}

// ═══════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════

function MetricCard({ label, value, sub, accent, pulse }) {
  return (
    <div style={{
      background: "rgba(20,25,35,0.85)",
      border: "1px solid rgba(100,140,200,0.15)",
      borderLeft: `3px solid ${accent || "#4a90d9"}`,
      borderRadius: 6,
      padding: "16px 20px",
      position: "relative",
      overflow: "hidden",
    }}>
      {pulse && <div style={{
        position: "absolute", top: 10, right: 12,
        width: 8, height: 8, borderRadius: "50%",
        background: "#4CAF50",
        animation: "pulse 2s ease-in-out infinite",
      }} />}
      <div style={{ fontSize: 11, color: "#7a8fa8", textTransform: "uppercase", letterSpacing: 1.5, fontFamily: "'JetBrains Mono', monospace" }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: "#e8edf3", marginTop: 4, fontFamily: "'Oswald', sans-serif", letterSpacing: -0.5 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: "#5a7a99", marginTop: 2, fontFamily: "'JetBrains Mono', monospace" }}>{sub}</div>}
    </div>
  );
}

function CoinBadge({ coin, active }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 10px", borderRadius: 4, fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
      background: active ? `${coin.color}22` : "rgba(40,45,55,0.6)",
      border: `1px solid ${active ? coin.color + "55" : "rgba(60,70,80,0.4)"}`,
      color: active ? coin.color : "#556",
      opacity: active ? 1 : 0.5,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: active ? coin.color : "#444" }} />
      {coin.sym}
      {coin.role === "parent" && <span style={{ fontSize: 9, color: "#7a8fa8" }}>PARENT</span>}
    </div>
  );
}

function MinerRow({ miner, index }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "40px 1fr 140px 100px 80px",
      gap: 12, alignItems: "center",
      padding: "10px 16px",
      background: index % 2 === 0 ? "rgba(15,20,30,0.5)" : "transparent",
      borderBottom: "1px solid rgba(60,70,90,0.2)",
      fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
    }}>
      <span style={{ color: "#4a5568", fontSize: 11 }}>#{index + 1}</span>
      <span style={{ color: "#b8c7d9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {miner.worker || miner.address?.substring(0, 20) + "..."}
      </span>
      <span style={{ color: "#4a90d9" }}>{formatHashrate(miner.hashrate)}</span>
      <span style={{ color: miner.shares?.valid > 0 ? "#4CAF50" : "#555" }}>
        {miner.shares?.valid || 0} <span style={{ color: "#444", fontSize: 10 }}>shares</span>
      </span>
      <span style={{ color: "#5a7a99", fontSize: 11 }}>{timeAgo(miner.lastActivity)}</span>
    </div>
  );
}

function BlockRow({ block }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "60px 100px 1fr 100px 100px",
      gap: 12, alignItems: "center",
      padding: "8px 16px",
      borderBottom: "1px solid rgba(60,70,90,0.15)",
      fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
    }}>
      <span style={{
        padding: "2px 8px", borderRadius: 3, fontSize: 10,
        background: block.coin === "LTC" ? "#345D9D22" : "#C2A63322",
        color: block.coin === "LTC" ? "#345D9D" : "#C2A633",
        border: `1px solid ${block.coin === "LTC" ? "#345D9D44" : "#C2A63344"}`,
      }}>{block.coin || "LTC"}</span>
      <span style={{ color: "#b8c7d9" }}>#{block.height}</span>
      <span style={{ color: "#5a7a99", overflow: "hidden", textOverflow: "ellipsis" }}>
        {block.hash?.substring(0, 24) || "pending..."}
      </span>
      <span style={{ color: block.confirmed ? "#4CAF50" : block.orphaned ? "#f44336" : "#FF9800", fontSize: 11 }}>
        {block.confirmed ? "Confirmed" : block.orphaned ? "Orphaned" : `${block.confirmations || 0} confs`}
      </span>
      <span style={{ color: "#5a7a99", fontSize: 11 }}>{timeAgo(block.created_at)}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// HASHRATE SPARKLINE (SVG mini-chart)
// ═══════════════════════════════════════════════════════════

function Sparkline({ data = [], width = 300, height = 60, color = "#4a90d9" }) {
  if (data.length < 2) return <div style={{ width, height, background: "rgba(20,25,35,0.5)", borderRadius: 4 }} />;

  const max = Math.max(...data, 1);
  const step = width / (data.length - 1);
  const points = data.map((v, i) => `${i * step},${height - (v / max) * (height - 8)}`).join(" ");
  const fillPoints = `0,${height} ${points} ${width},${height}`;

  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={fillPoints} fill="url(#sparkFill)" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ═══════════════════════════════════════════════════════════

export default function LuxxpoolDashboard() {
  const [tab, setTab] = useState("overview");
  const [poolStats, setPoolStats] = useState(null);
  const [miners, setMiners] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [searchAddr, setSearchAddr] = useState("");
  const [tick, setTick] = useState(0);

  // Simulated data for demo (replace with real API calls in production)
  useEffect(() => {
    setPoolStats({
      pool: { hashrate: 325e9, miners: 20, workers: 24, fee: "2%", totalShares: 1847392 },
      network: { difficulty: 28462819.12, hashrate: 1.2e15, height: 2847261 },
      auxChains: {
        DOGE: { connected: true, blocksFound: 142 },
        BELLS: { connected: true, blocksFound: 38 },
        LKY: { connected: true, blocksFound: 21 },
        PEP: { connected: true, blocksFound: 17 },
        JKC: { connected: false, blocksFound: 0 },
        DINGO: { connected: true, blocksFound: 9 },
        SHIC: { connected: true, blocksFound: 55 },
      },
    });

    setMiners(Array.from({ length: 20 }, (_, i) => ({
      worker: `L${["tc1q", "M8x", "ltc1"][i % 3]}...${String(i).padStart(3, "0")}.antminer_${i + 1}`,
      address: `Ltc1...${i}`,
      hashrate: (16.25e9 + Math.random() * 2e9),
      shares: { valid: Math.floor(5000 + Math.random() * 20000), invalid: Math.floor(Math.random() * 50) },
      difficulty: 512 * Math.pow(2, Math.floor(Math.random() * 4)),
      lastActivity: Date.now() - Math.random() * 60000,
    })));

    setBlocks([
      { coin: "LTC", height: 2847255, hash: "a3f8e2d1c4b5a69...", confirmed: true, confirmations: 142, created_at: Date.now() - 3600000 },
      { coin: "DOGE", height: 5281034, hash: "d7c2b8a1e5f3...", confirmed: true, confirmations: 89, created_at: Date.now() - 1800000 },
      { coin: "SHIC", height: 52019, hash: "f1e2d3c4b5a6...", confirmed: false, confirmations: 12, created_at: Date.now() - 600000 },
      { coin: "BELLS", height: 189234, hash: null, confirmed: false, confirmations: 3, created_at: Date.now() - 120000 },
      { coin: "LTC", height: 2847261, hash: null, confirmed: false, orphaned: false, confirmations: 0, created_at: Date.now() - 30000 },
    ]);

    const timer = setInterval(() => setTick(t => t + 1), 5000);
    return () => clearInterval(timer);
  }, []);

  const hashrateHistory = Array.from({ length: 48 }, (_, i) => 300e9 + Math.sin(i * 0.3) * 30e9 + Math.random() * 20e9);
  const activeAux = COINS.filter(c => c.role === "aux" && poolStats?.auxChains?.[c.sym]?.connected);

  const tabs = [
    { id: "overview", label: "OVERVIEW" },
    { id: "miners", label: "MINERS" },
    { id: "blocks", label: "BLOCKS" },
    { id: "connect", label: "CONNECT" },
  ];

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #0a0e17 0%, #111827 50%, #0d1321 100%)",
      color: "#c8d6e5",
      fontFamily: "'Inter', sans-serif",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700&family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500;600&display=swap');
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes slideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0a0e17; }
        ::-webkit-scrollbar-thumb { background: #2a3a4a; border-radius: 3px; }
      `}</style>

      {/* ── Header ── */}
      <header style={{
        padding: "16px 32px",
        borderBottom: "1px solid rgba(74,144,217,0.15)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        background: "rgba(10,14,23,0.9)",
        backdropFilter: "blur(12px)",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 26, fontWeight: 700, letterSpacing: 3, color: "#e8edf3" }}>
            LUXX<span style={{ color: "#4a90d9" }}>POOL</span>
          </div>
          <div style={{
            fontSize: 9, padding: "3px 8px", borderRadius: 3,
            background: "rgba(74,144,217,0.15)", color: "#4a90d9",
            fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1,
          }}>SCRYPT MULTI-COIN</div>
        </div>

        <nav style={{ display: "flex", gap: 4 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "8px 18px", border: "none", borderRadius: 4, cursor: "pointer",
              fontSize: 11, letterSpacing: 1.5, fontFamily: "'JetBrains Mono', monospace",
              background: tab === t.id ? "rgba(74,144,217,0.2)" : "transparent",
              color: tab === t.id ? "#4a90d9" : "#5a7a99",
              borderBottom: tab === t.id ? "2px solid #4a90d9" : "2px solid transparent",
              transition: "all 0.2s",
            }}>{t.label}</button>
          ))}
        </nav>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4CAF50", animation: "pulse 2s infinite" }} />
          <span style={{ fontSize: 11, color: "#5a7a99", fontFamily: "'JetBrains Mono', monospace" }}>ONLINE</span>
        </div>
      </header>

      {/* ── Active Coin Strip ── */}
      <div style={{
        padding: "10px 32px",
        borderBottom: "1px solid rgba(60,70,90,0.15)",
        display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
        background: "rgba(15,20,30,0.5)",
      }}>
        <span style={{ fontSize: 10, color: "#4a5568", fontFamily: "'JetBrains Mono', monospace", marginRight: 4 }}>MINING:</span>
        {COINS.map(c => (
          <CoinBadge key={c.sym} coin={c} active={c.role === "parent" || poolStats?.auxChains?.[c.sym]?.connected} />
        ))}
      </div>

      {/* ── Main Content ── */}
      <main style={{ padding: "24px 32px", maxWidth: 1400, margin: "0 auto" }}>

        {/* OVERVIEW TAB */}
        {tab === "overview" && (
          <div style={{ animation: "slideIn 0.3s ease" }}>
            {/* Top Metrics */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 24 }}>
              <MetricCard label="Pool Hashrate" value={formatHashrate(poolStats?.pool?.hashrate)} sub="325 GH/s — 20× L9 miners" accent="#4a90d9" pulse />
              <MetricCard label="Active Miners" value={poolStats?.pool?.miners || 0} sub={`${poolStats?.pool?.workers || 0} workers`} accent="#4CAF50" />
              <MetricCard label="Network Difficulty" value={poolStats?.network?.difficulty?.toLocaleString(undefined, { maximumFractionDigits: 0 }) || "—"} sub={`Height: ${poolStats?.network?.height?.toLocaleString() || "—"}`} accent="#FF9800" />
              <MetricCard label="Active Chains" value={`${1 + activeAux.length} / ${COINS.length}`} sub="LTC + aux coins mining" accent="#AB47BC" />
              <MetricCard label="Total Shares" value={(poolStats?.pool?.totalShares || 0).toLocaleString()} accent="#26A69A" />
            </div>

            {/* Hashrate Chart */}
            <div style={{
              background: "rgba(20,25,35,0.85)", border: "1px solid rgba(100,140,200,0.1)",
              borderRadius: 6, padding: "16px 20px", marginBottom: 24,
            }}>
              <div style={{ fontSize: 11, color: "#7a8fa8", fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1.5, marginBottom: 12 }}>
                POOL HASHRATE — 24H
              </div>
              <Sparkline data={hashrateHistory} width={1300} height={80} color="#4a90d9" />
            </div>

            {/* Aux Chain Stats Grid */}
            <div style={{ fontSize: 11, color: "#7a8fa8", fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1.5, marginBottom: 12 }}>
              MERGED MINING — AUXILIARY CHAINS
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginBottom: 24 }}>
              {COINS.filter(c => c.role === "aux").map(coin => {
                const stats = poolStats?.auxChains?.[coin.sym];
                return (
                  <div key={coin.sym} style={{
                    background: "rgba(20,25,35,0.7)", border: `1px solid ${stats?.connected ? coin.color + "33" : "rgba(40,50,60,0.3)"}`,
                    borderRadius: 6, padding: "12px 16px",
                    opacity: stats?.connected ? 1 : 0.4,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, color: stats?.connected ? coin.color : "#444", fontWeight: 600 }}>{coin.sym}</span>
                      <span style={{
                        width: 6, height: 6, borderRadius: "50%",
                        background: stats?.connected ? "#4CAF50" : "#f44336",
                      }} />
                    </div>
                    <div style={{ fontSize: 11, color: "#5a7a99", fontFamily: "'JetBrains Mono', monospace" }}>{coin.name}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#e8edf3", fontFamily: "'Oswald', sans-serif", marginTop: 4 }}>
                      {stats?.blocksFound || 0}
                    </div>
                    <div style={{ fontSize: 10, color: "#4a5568" }}>blocks found</div>
                  </div>
                );
              })}
            </div>

            {/* Recent Blocks */}
            <div style={{ fontSize: 11, color: "#7a8fa8", fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1.5, marginBottom: 12 }}>
              RECENT BLOCKS
            </div>
            <div style={{ background: "rgba(20,25,35,0.85)", border: "1px solid rgba(100,140,200,0.1)", borderRadius: 6, overflow: "hidden" }}>
              <div style={{
                display: "grid", gridTemplateColumns: "60px 100px 1fr 100px 100px",
                gap: 12, padding: "8px 16px", fontSize: 10, color: "#4a5568",
                fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase",
                borderBottom: "1px solid rgba(60,70,90,0.3)", letterSpacing: 1,
              }}>
                <span>Coin</span><span>Height</span><span>Hash</span><span>Status</span><span>Found</span>
              </div>
              {blocks.map((b, i) => <BlockRow key={i} block={b} />)}
            </div>
          </div>
        )}

        {/* MINERS TAB */}
        {tab === "miners" && (
          <div style={{ animation: "slideIn 0.3s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "#7a8fa8", fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1.5 }}>
                CONNECTED MINERS — {miners.length}
              </div>
            </div>
            <div style={{ background: "rgba(20,25,35,0.85)", border: "1px solid rgba(100,140,200,0.1)", borderRadius: 6, overflow: "hidden" }}>
              <div style={{
                display: "grid", gridTemplateColumns: "40px 1fr 140px 100px 80px",
                gap: 12, padding: "8px 16px", fontSize: 10, color: "#4a5568",
                fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase",
                borderBottom: "1px solid rgba(60,70,90,0.3)", letterSpacing: 1,
              }}>
                <span>#</span><span>Worker</span><span>Hashrate</span><span>Shares</span><span>Last</span>
              </div>
              {miners.sort((a, b) => b.hashrate - a.hashrate).map((m, i) => <MinerRow key={i} miner={m} index={i} />)}
            </div>
          </div>
        )}

        {/* BLOCKS TAB */}
        {tab === "blocks" && (
          <div style={{ animation: "slideIn 0.3s ease" }}>
            <div style={{ fontSize: 11, color: "#7a8fa8", fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1.5, marginBottom: 12 }}>
              ALL BLOCKS FOUND
            </div>
            <div style={{ background: "rgba(20,25,35,0.85)", border: "1px solid rgba(100,140,200,0.1)", borderRadius: 6, overflow: "hidden" }}>
              <div style={{
                display: "grid", gridTemplateColumns: "60px 100px 1fr 100px 100px",
                gap: 12, padding: "8px 16px", fontSize: 10, color: "#4a5568",
                fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase",
                borderBottom: "1px solid rgba(60,70,90,0.3)", letterSpacing: 1,
              }}>
                <span>Coin</span><span>Height</span><span>Hash</span><span>Status</span><span>Found</span>
              </div>
              {blocks.map((b, i) => <BlockRow key={i} block={b} />)}
            </div>
          </div>
        )}

        {/* CONNECT TAB */}
        {tab === "connect" && (
          <div style={{ animation: "slideIn 0.3s ease", maxWidth: 720 }}>
            <div style={{ fontSize: 11, color: "#7a8fa8", fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1.5, marginBottom: 16 }}>
              MINER CONNECTION GUIDE
            </div>

            <div style={{ background: "rgba(20,25,35,0.85)", border: "1px solid rgba(100,140,200,0.1)", borderRadius: 6, padding: 24, marginBottom: 16 }}>
              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 18, color: "#e8edf3", marginBottom: 16 }}>Pool Mining <span style={{ color: "#4a90d9" }}>(Shared Rewards)</span></div>

              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#7a8fa8", marginBottom: 6 }}>STRATUM URL</div>
              <div style={{ background: "#0a0e17", borderRadius: 4, padding: "10px 14px", fontFamily: "'JetBrains Mono', monospace", fontSize: 14, color: "#4a90d9", marginBottom: 16, border: "1px solid rgba(74,144,217,0.2)" }}>
                stratum+tcp://luxxpool.io:3333
              </div>

              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#7a8fa8", marginBottom: 6 }}>SSL STRATUM</div>
              <div style={{ background: "#0a0e17", borderRadius: 4, padding: "10px 14px", fontFamily: "'JetBrains Mono', monospace", fontSize: 14, color: "#26A69A", marginBottom: 16, border: "1px solid rgba(38,166,154,0.2)" }}>
                stratum+ssl://luxxpool.io:3334
              </div>

              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#7a8fa8", marginBottom: 6 }}>WORKER FORMAT</div>
              <div style={{ background: "#0a0e17", borderRadius: 4, padding: "10px 14px", fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: "#b8c7d9", marginBottom: 8, border: "1px solid rgba(60,70,90,0.3)" }}>
                Worker: <span style={{ color: "#FF9800" }}>YOUR_LTC_ADDRESS</span>.<span style={{ color: "#AB47BC" }}>workerName</span>
              </div>
              <div style={{ background: "#0a0e17", borderRadius: 4, padding: "10px 14px", fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: "#b8c7d9", border: "1px solid rgba(60,70,90,0.3)" }}>
                Password: <span style={{ color: "#5a7a99" }}>x</span>
              </div>
            </div>

            <div style={{ background: "rgba(20,25,35,0.85)", border: "1px solid rgba(100,140,200,0.1)", borderRadius: 6, padding: 24, marginBottom: 16 }}>
              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 18, color: "#e8edf3", marginBottom: 16 }}>Solo Mining <span style={{ color: "#FF9800" }}>(Keep 100% Rewards)</span></div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#7a8fa8", marginBottom: 6 }}>SOLO STRATUM URL</div>
              <div style={{ background: "#0a0e17", borderRadius: 4, padding: "10px 14px", fontFamily: "'JetBrains Mono', monospace", fontSize: 14, color: "#FF9800", border: "1px solid rgba(255,152,0,0.2)" }}>
                stratum+tcp://luxxpool.io:3336
              </div>
              <div style={{ fontSize: 12, color: "#5a7a99", marginTop: 8, fontFamily: "'JetBrains Mono', monospace" }}>
                Solo fee: 1% — You keep 99% of all block rewards
              </div>
            </div>

            <div style={{ background: "rgba(20,25,35,0.85)", border: "1px solid rgba(74,144,217,0.1)", borderRadius: 6, padding: 24 }}>
              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 18, color: "#e8edf3", marginBottom: 12 }}>Merged Mining — <span style={{ color: "#4CAF50" }}>Automatic</span></div>
              <div style={{ fontSize: 13, color: "#7a8fa8", lineHeight: 1.6, marginBottom: 12 }}>
                Connect once to mine LTC and earn all auxiliary coin rewards automatically.
                No extra configuration needed. Register wallet addresses for each coin to receive rewards.
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {COINS.filter(c => c.role === "aux").map(c => (
                  <div key={c.sym} style={{
                    padding: "6px 12px", borderRadius: 4,
                    background: `${c.color}15`, border: `1px solid ${c.color}33`,
                    fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: c.color,
                  }}>
                    + {c.sym}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer style={{
        padding: "16px 32px",
        borderTop: "1px solid rgba(60,70,90,0.15)",
        display: "flex", justifyContent: "space-between",
        fontSize: 10, color: "#3a4a5a",
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        <span>LUXXPOOL v0.2.0 — Christina Lake, BC, Canada</span>
        <span>Scrypt Multi-Coin Merged Mining Pool — {COINS.length} coins supported</span>
      </footer>
    </div>
  );
}
