import { useState, useEffect, useRef, useCallback } from "react";

/*
 * ═══════════════════════════════════════════════════════════════════
 * LUXXPOOL — GenUI Mining Dashboard v2.0
 * ═══════════════════════════════════════════════════════════════════
 *
 * Architecture: Declarative GenUI Pattern (Component Catalog)
 * The dashboard adapts its visual hierarchy based on real-time
 * pool state. When a block is found, the layout shifts to celebrate.
 * When security alerts fire, the security panel surfaces. When
 * hashrate changes, the sparkline redraws. The interface is a
 * "living decision surface" — not a static grid.
 *
 * Design System: Semantic Token Contract
 * Tokens encode INTENT not PIXELS:
 *   --state-mining   = active work
 *   --state-found    = block discovered
 *   --state-orphaned = block lost
 *   --state-alert    = security event
 *   --state-idle     = no activity
 *
 * GenUI Principles Applied:
 *   1. Interface Individualism (miner vs operator views)
 *   2. Temporal Logic (runtime-generated, not design-time)
 *   3. Representation Fluidity (text → chart → alert)
 *   4. Component Catalog (MetricCell, CoinPill, DataStream, etc.)
 */

// ═══════════════════════════════════════════════════════════
// SEMANTIC DESIGN TOKENS (Machine Contract)
// ═══════════════════════════════════════════════════════════
const TOKENS = {
  // Spatial rhythm
  space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },

  // State-driven semantic colors (NOT "blue" — "mining")
  state: {
    mining:    { bg: "#0d2847", fg: "#4a9eff", glow: "rgba(74,158,255,0.12)", border: "rgba(74,158,255,0.2)" },
    found:     { bg: "#0d3521", fg: "#34d399", glow: "rgba(52,211,153,0.15)", border: "rgba(52,211,153,0.3)" },
    orphaned:  { bg: "#3b1320", fg: "#f87171", glow: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.2)" },
    alert:     { bg: "#3b2010", fg: "#fb923c", glow: "rgba(251,146,60,0.12)", border: "rgba(251,146,60,0.2)" },
    idle:      { bg: "#141a24", fg: "#475569", glow: "transparent", border: "rgba(71,85,105,0.15)" },
    aux:       { bg: "#1a1535", fg: "#a78bfa", glow: "rgba(167,139,250,0.1)", border: "rgba(167,139,250,0.2)" },
  },

  // Typography scale (3 families: display, mono, body)
  type: {
    display: "'Unbounded', sans-serif",   // Bold, geometric — pool identity
    mono: "'IBM Plex Mono', monospace",   // Data, hashes, addresses
    body: "'DM Sans', sans-serif",        // Readable body text
  },

  // Surface layering
  surface: {
    base:   "#080c14",
    raised: "#0e1420",
    card:   "#121a28",
    hover:  "#182030",
    overlay: "rgba(8,12,20,0.95)",
  },

  // Radii
  radius: { sm: 4, md: 8, lg: 12, xl: 16 },
};

// Coin definitions with semantic state colors
const COINS = [
  { sym: "LTC", name: "Litecoin", hue: 215, role: "parent" },
  { sym: "DOGE", name: "Dogecoin", hue: 45, role: "aux" },
  { sym: "BELLS", name: "Bellscoin", hue: 25, role: "aux" },
  { sym: "LKY", name: "Luckycoin", hue: 140, role: "aux" },
  { sym: "PEP", name: "Pepecoin", hue: 150, role: "aux" },
  { sym: "JKC", name: "Junkcoin", hue: 200, role: "aux" },
  { sym: "DINGO", name: "Dingocoin", hue: 30, role: "aux" },
  { sym: "SHIC", name: "Shibacoin", hue: 35, role: "aux" },
  { sym: "TRMP", name: "TrumPOW", hue: 0, role: "aux" },
  { sym: "CRC", name: "CraftCoin", hue: 280, role: "aux" },
];

function coinColor(hue, a = 1) { return `hsla(${hue}, 70%, 60%, ${a})`; }
function formatHR(h) {
  if (!h) return "0 H/s";
  const u = [["EH/s",1e18],["PH/s",1e15],["TH/s",1e12],["GH/s",1e9],["MH/s",1e6],["KH/s",1e3],["H/s",1]];
  for (const [s,d] of u) if (h >= d) return (h/d).toFixed(2) + " " + s;
  return "0 H/s";
}
function timeAgo(t) {
  if (!t) return "—";
  const d = Date.now() - new Date(t).getTime();
  if (d < 60000) return Math.floor(d/1000) + "s";
  if (d < 3600000) return Math.floor(d/60000) + "m";
  if (d < 86400000) return Math.floor(d/3600000) + "h";
  return Math.floor(d/86400000) + "d";
}

// ═══════════════════════════════════════════════════════════
// COMPONENT CATALOG (GenUI Palette)
// Each component is a self-contained "widget" the system
// can compose into any layout configuration.
// ═══════════════════════════════════════════════════════════

/** Adaptive metric cell — changes color based on semantic state */
function MetricCell({ label, value, sub, state = "mining", large, pulse }) {
  const tok = TOKENS.state[state] || TOKENS.state.idle;
  return (
    <div style={{
      background: tok.bg,
      border: `1px solid ${tok.border}`,
      borderRadius: TOKENS.radius.lg,
      padding: large ? "20px 24px" : "14px 18px",
      position: "relative",
      overflow: "hidden",
      boxShadow: `0 0 20px ${tok.glow}`,
      transition: "all 0.4s ease",
    }}>
      {pulse && <div style={{
        position: "absolute", top: 12, right: 14, width: 7, height: 7,
        borderRadius: "50%", background: tok.fg,
        animation: "pulse 2s infinite",
      }} />}
      <div style={{ fontSize: 10, color: "#4a5568", textTransform: "uppercase", letterSpacing: 2, fontFamily: TOKENS.type.mono }}>{label}</div>
      <div style={{ fontSize: large ? 36 : 26, fontWeight: 800, color: tok.fg, fontFamily: TOKENS.type.display, marginTop: 4, letterSpacing: -1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#3a4a5a", fontFamily: TOKENS.type.mono, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/** Coin status pill — glows when active */
function CoinPill({ coin, active, blocksFound }) {
  const c = coinColor(coin.hue);
  const ca = coinColor(coin.hue, 0.15);
  const cb = coinColor(coin.hue, 0.3);
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "5px 12px", borderRadius: 20, fontSize: 11,
      fontFamily: TOKENS.type.mono, fontWeight: 500,
      background: active ? ca : TOKENS.surface.card,
      border: `1px solid ${active ? cb : TOKENS.state.idle.border}`,
      color: active ? c : "#3a4a5a",
      transition: "all 0.3s",
      cursor: "default",
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: active ? c : "#2a3040",
        boxShadow: active ? `0 0 6px ${c}` : "none",
        transition: "all 0.3s",
      }} />
      <span>{coin.sym}</span>
      {blocksFound > 0 && <span style={{ fontSize: 9, opacity: 0.6 }}>({blocksFound})</span>}
    </div>
  );
}

/** Live data stream visualization (sparkline) */
function DataStream({ data = [], width = 400, height = 50, hue = 215 }) {
  if (data.length < 2) return <div style={{ width, height, background: TOKENS.surface.card, borderRadius: TOKENS.radius.md }} />;
  const max = Math.max(...data, 1);
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => `${i * step},${height - (v / max) * (height - 6)}`).join(" ");
  const fill = `0,${height} ${pts} ${width},${height}`;
  const c = coinColor(hue);
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <defs>
        <linearGradient id={`sf${hue}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity="0.25" />
          <stop offset="100%" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={fill} fill={`url(#sf${hue})`} />
      <polyline points={pts} fill="none" stroke={c} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** Security status indicator — Layer visualization */
function SecurityLayer({ name, layer, status, detail }) {
  const st = status === "active" ? TOKENS.state.found : status === "alert" ? TOKENS.state.alert : TOKENS.state.idle;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "10px 14px", background: st.bg,
      border: `1px solid ${st.border}`,
      borderRadius: TOKENS.radius.md,
      transition: "all 0.3s",
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: TOKENS.radius.sm,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: `${st.fg}22`, color: st.fg,
        fontFamily: TOKENS.type.display, fontWeight: 800, fontSize: 13,
      }}>{layer}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: st.fg, fontFamily: TOKENS.type.body }}>{name}</div>
        <div style={{ fontSize: 10, color: "#4a5568", fontFamily: TOKENS.type.mono }}>{detail}</div>
      </div>
      <div style={{
        width: 8, height: 8, borderRadius: "50%",
        background: status === "active" ? "#34d399" : status === "alert" ? "#fb923c" : "#2a3040",
        boxShadow: status === "active" ? "0 0 6px #34d399" : "none",
        animation: status === "alert" ? "pulse 1s infinite" : "none",
      }} />
    </div>
  );
}

/** Block event row — adapts color to confirmed/orphaned/pending state */
function BlockEvent({ block }) {
  const coin = COINS.find(c => c.sym === (block.coin || "LTC"));
  const st = block.confirmed ? "found" : block.orphaned ? "orphaned" : "mining";
  const tok = TOKENS.state[st];
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "56px 90px 1fr 90px 60px",
      gap: 10, alignItems: "center", padding: "8px 14px",
      borderLeft: `2px solid ${tok.fg}`,
      background: `${tok.bg}80`,
      borderRadius: `0 ${TOKENS.radius.sm}px ${TOKENS.radius.sm}px 0`,
      marginBottom: 2, fontSize: 12, fontFamily: TOKENS.type.mono,
    }}>
      <span style={{ color: coinColor(coin?.hue || 215), fontWeight: 600 }}>{block.coin || "LTC"}</span>
      <span style={{ color: "#8a9ab0" }}>#{block.height}</span>
      <span style={{ color: "#4a5568", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>{block.hash || "pending..."}</span>
      <span style={{ color: tok.fg, fontSize: 10, fontWeight: 500 }}>
        {block.confirmed ? "✓ Confirmed" : block.orphaned ? "✗ Orphaned" : `${block.confirmations} confs`}
      </span>
      <span style={{ color: "#3a4a5a", fontSize: 10 }}>{timeAgo(block.created_at)}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// MAIN DASHBOARD — GenUI Orchestrator
// Adapts layout based on pool state (Temporal Logic)
// ═══════════════════════════════════════════════════════════

export default function LuxxpoolGenUI() {
  const [view, setView] = useState("command");
  const [tick, setTick] = useState(0);
  const [recentBlockFound, setRecentBlockFound] = useState(false);

  // Simulated live data (replace with API in production)
  const poolHashrate = 325e9 + Math.sin(tick * 0.1) * 15e9;
  const minerCount = 20;
  const workerCount = 24;
  const networkDiff = 28462819;
  const blockHeight = 2847261 + Math.floor(tick / 12);
  const auxActive = 7;
  const totalBlocks = 287;
  const securityAlerts = 0;
  const hashHistory = Array.from({ length: 60 }, (_, i) => 300e9 + Math.sin((i + tick) * 0.15) * 30e9 + Math.random() * 10e9);

  const auxStats = { DOGE: { blocks: 142, active: true }, BELLS: { blocks: 38, active: true }, LKY: { blocks: 21, active: true },
    PEP: { blocks: 17, active: true }, JKC: { blocks: 0, active: false }, DINGO: { blocks: 9, active: true },
    SHIC: { blocks: 55, active: true }, TRMP: { blocks: 0, active: false }, CRC: { blocks: 0, active: false } };

  const blocks = [
    { coin: "LTC", height: 2847261, hash: "a3f8e2d1c4b5a697e8f2...cb41", confirmed: true, confirmations: 142, created_at: Date.now() - 3600000 },
    { coin: "DOGE", height: 5281034, hash: "d7c2b8a1e5f3d2c1...9e72", confirmed: true, confirmations: 89, created_at: Date.now() - 1800000 },
    { coin: "SHIC", height: 52019, hash: "f1e2d3c4b5a6e7f8...3a1b", confirmed: false, confirmations: 12, created_at: Date.now() - 600000 },
    { coin: "BELLS", height: 189234, confirmed: false, confirmations: 3, created_at: Date.now() - 120000 },
    { coin: "LTC", height: 2847262, confirmed: false, orphaned: false, confirmations: 0, created_at: Date.now() - 15000 },
  ];

  useEffect(() => {
    const t = setInterval(() => setTick(k => k + 1), 3000);
    return () => clearInterval(t);
  }, []);

  // GenUI: simulate block found event (shifts layout priority)
  useEffect(() => {
    if (tick > 0 && tick % 20 === 0) {
      setRecentBlockFound(true);
      setTimeout(() => setRecentBlockFound(false), 8000);
    }
  }, [tick]);

  const views = [
    { id: "command", label: "Command" },
    { id: "security", label: "Security" },
    { id: "connect", label: "Connect" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: TOKENS.surface.base, color: "#b0bfd0", fontFamily: TOKENS.type.body }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Unbounded:wght@400;600;800;900&family=IBM+Plex+Mono:wght@400;500;600&family=DM+Sans:wght@400;500;600;700&display=swap');
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.3 } }
        @keyframes slideUp { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:translateY(0) } }
        @keyframes glowPulse { 0%,100% { box-shadow: 0 0 20px rgba(52,211,153,0.1) } 50% { box-shadow: 0 0 40px rgba(52,211,153,0.3) } }
        * { margin:0; padding:0; box-sizing:border-box; }
        ::-webkit-scrollbar { width:5px }
        ::-webkit-scrollbar-track { background:${TOKENS.surface.base} }
        ::-webkit-scrollbar-thumb { background:#1e2a3a; border-radius:3px }
      `}</style>

      {/* ═══ HEADER ═══ */}
      <header style={{
        padding: "14px 28px", display: "flex", justifyContent: "space-between", alignItems: "center",
        borderBottom: `1px solid ${TOKENS.state.idle.border}`,
        background: TOKENS.surface.overlay, backdropFilter: "blur(16px)",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {/* Logo: geometric mark */}
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, #4a9eff 0%, #a78bfa 100%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontFamily: TOKENS.type.display, fontSize: 16, fontWeight: 900, color: "#080c14" }}>L</span>
          </div>
          <div>
            <div style={{ fontFamily: TOKENS.type.display, fontSize: 20, fontWeight: 800, color: "#e2e8f0", letterSpacing: 1 }}>
              LUXX<span style={{ color: "#4a9eff" }}>POOL</span>
            </div>
            <div style={{ fontSize: 9, color: "#3a4a5a", fontFamily: TOKENS.type.mono, letterSpacing: 1.5 }}>Scrypt multi-coin merged mining</div>
          </div>
        </div>

        <nav style={{ display: "flex", gap: 2 }}>
          {views.map(v => (
            <button key={v.id} onClick={() => setView(v.id)} style={{
              padding: "7px 16px", border: "none", borderRadius: TOKENS.radius.sm, cursor: "pointer",
              fontSize: 10, letterSpacing: 2, fontFamily: TOKENS.type.mono, fontWeight: 600,
              background: view === v.id ? TOKENS.state.mining.bg : "transparent",
              color: view === v.id ? TOKENS.state.mining.fg : "#3a4a5a",
              transition: "all 0.2s",
            }}>{v.label}</button>
          ))}
        </nav>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#34d399", boxShadow: "0 0 8px #34d399", animation: "pulse 2s infinite" }} />
          <span style={{ fontSize: 10, fontFamily: TOKENS.type.mono, color: "#34d399" }}>LIVE</span>
        </div>
      </header>

      {/* ═══ ACTIVE COINS STRIP ═══ */}
      <div style={{ padding: "8px 28px", display: "flex", gap: 6, flexWrap: "wrap", borderBottom: `1px solid ${TOKENS.state.idle.border}`, background: `${TOKENS.surface.raised}80` }}>
        {COINS.map(c => (
          <CoinPill key={c.sym} coin={c} active={c.role === "parent" || auxStats[c.sym]?.active}
            blocksFound={c.sym === "LTC" ? totalBlocks : auxStats[c.sym]?.blocks} />
        ))}
      </div>

      {/* ═══ MAIN CONTENT ═══ */}
      <main style={{ padding: "20px 28px", maxWidth: 1440, margin: "0 auto" }}>

        {/* ══════════ COMMAND VIEW ══════════ */}
        {view === "command" && (
          <div style={{ animation: "slideUp 0.3s ease" }}>
            {/* Block Found Banner (GenUI: surfaces contextually) */}
            {recentBlockFound && (
              <div style={{
                padding: "14px 20px", marginBottom: 16, borderRadius: TOKENS.radius.lg,
                background: TOKENS.state.found.bg, border: `1px solid ${TOKENS.state.found.border}`,
                animation: "glowPulse 2s infinite", display: "flex", alignItems: "center", gap: 12,
              }}>
                <span style={{ fontSize: 24 }}>⛏</span>
                <div>
                  <div style={{ fontFamily: TOKENS.type.display, fontSize: 16, fontWeight: 800, color: TOKENS.state.found.fg }}>BLOCK FOUND!</div>
                  <div style={{ fontSize: 11, color: "#4a5568", fontFamily: TOKENS.type.mono }}>LTC #{blockHeight} — reward distributed to pool</div>
                </div>
              </div>
            )}

            {/* Primary Metrics Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginBottom: 20 }}>
              <MetricCell label="Pool Hashrate" value={formatHR(poolHashrate)} sub="20× Antminer L9" state="mining" large pulse />
              <MetricCell label="Active Miners" value={minerCount} sub={`${workerCount} workers`} state="found" />
              <MetricCell label="Network Diff" value={(networkDiff / 1e6).toFixed(1) + "M"} sub={`Height ${blockHeight.toLocaleString()}`} state="idle" />
              <MetricCell label="Chains Mining" value={`${1 + auxActive}`} sub="LTC + aux coins" state="aux" />
              <MetricCell label="Blocks Found" value={totalBlocks} sub="across all coins" state={recentBlockFound ? "found" : "mining"} />
              <MetricCell label="Security" value={securityAlerts === 0 ? "CLEAR" : `${securityAlerts} ALERTS`} sub="3-layer protection" state={securityAlerts > 0 ? "alert" : "found"} />
            </div>

            {/* Hashrate Stream */}
            <div style={{ background: TOKENS.surface.card, border: `1px solid ${TOKENS.state.idle.border}`, borderRadius: TOKENS.radius.lg, padding: "14px 18px", marginBottom: 20 }}>
              <div style={{ fontSize: 10, color: "#3a4a5a", fontFamily: TOKENS.type.mono, letterSpacing: 2, marginBottom: 10 }}>HASHRATE STREAM — 24H</div>
              <DataStream data={hashHistory} width={1370} height={70} hue={215} />
            </div>

            {/* Two-column: Aux Chains + Recent Blocks */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {/* Aux Chain Grid */}
              <div>
                <div style={{ fontSize: 10, color: "#3a4a5a", fontFamily: TOKENS.type.mono, letterSpacing: 2, marginBottom: 10 }}>MERGED MINING — AUXILIARY CHAINS</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {COINS.filter(c => c.role === "aux").map(coin => {
                    const s = auxStats[coin.sym];
                    const active = s?.active;
                    return (
                      <div key={coin.sym} style={{
                        background: active ? `hsla(${coin.hue},70%,60%,0.06)` : TOKENS.surface.card,
                        border: `1px solid ${active ? `hsla(${coin.hue},70%,60%,0.2)` : TOKENS.state.idle.border}`,
                        borderRadius: TOKENS.radius.md, padding: "10px 14px",
                        opacity: active ? 1 : 0.4, transition: "all 0.3s",
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontFamily: TOKENS.type.display, fontWeight: 800, fontSize: 15, color: active ? coinColor(coin.hue) : "#2a3040" }}>{coin.sym}</span>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: active ? "#34d399" : "#f87171" }} />
                        </div>
                        <div style={{ fontFamily: TOKENS.type.display, fontSize: 22, fontWeight: 800, color: "#e2e8f0", marginTop: 2 }}>{s?.blocks || 0}</div>
                        <div style={{ fontSize: 9, color: "#3a4a5a", fontFamily: TOKENS.type.mono }}>blocks</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Recent Blocks */}
              <div>
                <div style={{ fontSize: 10, color: "#3a4a5a", fontFamily: TOKENS.type.mono, letterSpacing: 2, marginBottom: 10 }}>BLOCK EVENTS</div>
                <div style={{ background: TOKENS.surface.card, borderRadius: TOKENS.radius.lg, padding: "8px", border: `1px solid ${TOKENS.state.idle.border}` }}>
                  {blocks.map((b, i) => <BlockEvent key={i} block={b} />)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ══════════ SECURITY VIEW ══════════ */}
        {view === "security" && (
          <div style={{ animation: "slideUp 0.3s ease", maxWidth: 800 }}>
            <div style={{ fontSize: 10, color: "#3a4a5a", fontFamily: TOKENS.type.mono, letterSpacing: 2, marginBottom: 16 }}>TRIPLE-LAYERED SECURITY ENGINE</div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
              <SecurityLayer layer="1" name="Mining Cookies" status="active"
                detail="Per-connection HMAC secrets — anti-hijack (BiteCoin/WireGhost defense)" />
              <SecurityLayer layer="2" name="Share Fingerprinting" status="active"
                detail="Statistical BWH detection — tracking 20 miners, 0 alerts" />
              <SecurityLayer layer="3" name="Behavioral Anomaly Engine" status="active"
                detail="Real-time: share floods, ntime manipulation, vardiff gaming, Sybil detection" />
            </div>

            <div style={{ fontSize: 10, color: "#3a4a5a", fontFamily: TOKENS.type.mono, letterSpacing: 2, marginBottom: 10 }}>THREAT MODEL — COVERED VECTORS</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                { threat: "MitM Share Hijacking", defense: "Mining cookies + TLS", layer: "1" },
                { threat: "Block Withholding (BWH)", defense: "Statistical share analysis", layer: "2" },
                { threat: "Fork After Withholding", defense: "Share fingerprinting", layer: "2" },
                { threat: "Selfish Mining Infiltration", defense: "Hashrate anomaly detection", layer: "3" },
                { threat: "DDoS / Share Flooding", defense: "Rate limiting + auto-ban", layer: "3" },
                { threat: "Stratum Protocol Abuse", defense: "Buffer limits + JSON validation", layer: "1" },
                { threat: "VarDiff Gaming", defense: "Difficulty variance monitoring", layer: "3" },
                { threat: "Nonce/Ntime Manipulation", defense: "Server-time deviation checks", layer: "3" },
                { threat: "Sybil Attack (Multi-Address)", defense: "Per-IP address clustering", layer: "3" },
                { threat: "Address Impersonation", defense: "Cryptographic address validation", layer: "1" },
              ].map((item, i) => (
                <div key={i} style={{
                  padding: "10px 14px", background: TOKENS.surface.card,
                  border: `1px solid ${TOKENS.state.idle.border}`,
                  borderRadius: TOKENS.radius.md, fontSize: 12,
                }}>
                  <div style={{ fontFamily: TOKENS.type.body, fontWeight: 600, color: "#e2e8f0", marginBottom: 2 }}>{item.threat}</div>
                  <div style={{ fontSize: 10, color: "#4a5568", fontFamily: TOKENS.type.mono }}>
                    L{item.layer}: {item.defense}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══════════ CONNECT VIEW ══════════ */}
        {view === "connect" && (
          <div style={{ animation: "slideUp 0.3s ease", maxWidth: 700 }}>
            <div style={{ fontSize: 10, color: "#3a4a5a", fontFamily: TOKENS.type.mono, letterSpacing: 2, marginBottom: 16 }}>CONNECTION GUIDE</div>

            {/* Pool Mining */}
            <div style={{ background: TOKENS.state.mining.bg, border: `1px solid ${TOKENS.state.mining.border}`, borderRadius: TOKENS.radius.lg, padding: 24, marginBottom: 12 }}>
              <div style={{ fontFamily: TOKENS.type.display, fontSize: 18, fontWeight: 800, color: TOKENS.state.mining.fg, marginBottom: 16 }}>Pool Mining</div>
              {[
                { label: "STRATUM", value: "stratum+tcp://luxxpool.io:3333", color: TOKENS.state.mining.fg },
                { label: "SSL", value: "stratum+ssl://luxxpool.io:3334", color: "#34d399" },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 9, color: "#3a4a5a", fontFamily: TOKENS.type.mono, letterSpacing: 2, marginBottom: 4 }}>{label}</div>
                  <div style={{ background: TOKENS.surface.base, borderRadius: TOKENS.radius.sm, padding: "10px 14px", fontFamily: TOKENS.type.mono, fontSize: 14, color, border: `1px solid ${color}33` }}>{value}</div>
                </div>
              ))}
              <div style={{ fontSize: 9, color: "#3a4a5a", fontFamily: TOKENS.type.mono, letterSpacing: 2, marginTop: 12, marginBottom: 4 }}>WORKER</div>
              <div style={{ background: TOKENS.surface.base, borderRadius: TOKENS.radius.sm, padding: "10px 14px", fontFamily: TOKENS.type.mono, fontSize: 13, color: "#8a9ab0", border: `1px solid ${TOKENS.state.idle.border}` }}>
                <span style={{ color: "#fb923c" }}>YOUR_LTC_ADDRESS</span>.<span style={{ color: "#a78bfa" }}>workerName</span>
              </div>
            </div>

            {/* Solo Mining */}
            <div style={{ background: TOKENS.state.alert.bg, border: `1px solid ${TOKENS.state.alert.border}`, borderRadius: TOKENS.radius.lg, padding: 24, marginBottom: 12 }}>
              <div style={{ fontFamily: TOKENS.type.display, fontSize: 18, fontWeight: 800, color: TOKENS.state.alert.fg, marginBottom: 12 }}>Solo Mining</div>
              <div style={{ fontSize: 9, color: "#3a4a5a", fontFamily: TOKENS.type.mono, letterSpacing: 2, marginBottom: 4 }}>SOLO STRATUM</div>
              <div style={{ background: TOKENS.surface.base, borderRadius: TOKENS.radius.sm, padding: "10px 14px", fontFamily: TOKENS.type.mono, fontSize: 14, color: TOKENS.state.alert.fg, border: `1px solid ${TOKENS.state.alert.fg}33` }}>stratum+tcp://luxxpool.io:3336</div>
              <div style={{ fontSize: 11, color: "#4a5568", fontFamily: TOKENS.type.mono, marginTop: 8 }}>1% fee — you keep 99% of all block rewards</div>
            </div>

            {/* Merged Mining */}
            <div style={{ background: TOKENS.state.aux.bg, border: `1px solid ${TOKENS.state.aux.border}`, borderRadius: TOKENS.radius.lg, padding: 24 }}>
              <div style={{ fontFamily: TOKENS.type.display, fontSize: 18, fontWeight: 800, color: TOKENS.state.aux.fg, marginBottom: 12 }}>Merged Mining — Automatic</div>
              <div style={{ fontSize: 12, color: "#6a7a8a", lineHeight: 1.6, marginBottom: 12, fontFamily: TOKENS.type.body }}>
                Connect once. Mine LTC. Earn all auxiliary coin rewards automatically via AuxPoW. Register wallet addresses per coin to receive payouts.
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {COINS.filter(c => c.role === "aux").map(c => (
                  <span key={c.sym} style={{
                    padding: "4px 10px", borderRadius: 16, fontSize: 11, fontFamily: TOKENS.type.mono,
                    background: `hsla(${c.hue},70%,60%,0.1)`, border: `1px solid hsla(${c.hue},70%,60%,0.2)`,
                    color: coinColor(c.hue),
                  }}>+ {c.sym}</span>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ═══ FOOTER ═══ */}
      <footer style={{
        padding: "12px 28px", borderTop: `1px solid ${TOKENS.state.idle.border}`,
        display: "flex", justifyContent: "space-between",
        fontSize: 9, color: "#2a3040", fontFamily: TOKENS.type.mono,
      }}>
        <span>LUXXPOOL v0.3.1 — Christina Lake, BC</span>
        <span>{COINS.length} Scrypt coins · Triple-layer security · GenUI Dashboard</span>
      </footer>
    </div>
  );
}
