import { useState, useEffect } from "react";

/*
 * LUXXPOOL — Public Miner Dashboard v0.3.1
 * For public miners connecting to the pool.
 * Views: Command (pool stats), Connect (setup), FAQ (how-to guide)
 * NO security details exposed. Clean, instructional, trustworthy.
 */

const T = {
  state: {
    mining:  { bg: "#0d2847", fg: "#4a9eff", border: "rgba(74,158,255,0.2)", glow: "rgba(74,158,255,0.1)" },
    found:   { bg: "#0d3521", fg: "#34d399", border: "rgba(52,211,153,0.25)", glow: "rgba(52,211,153,0.1)" },
    alert:   { bg: "#3b2010", fg: "#fb923c", border: "rgba(251,146,60,0.2)", glow: "rgba(251,146,60,0.1)" },
    idle:    { bg: "#141a24", fg: "#475569", border: "rgba(71,85,105,0.15)", glow: "transparent" },
    aux:     { bg: "#1a1535", fg: "#a78bfa", border: "rgba(167,139,250,0.2)", glow: "rgba(167,139,250,0.08)" },
  },
  type: { display: "'Unbounded', sans-serif", mono: "'IBM Plex Mono', monospace", body: "'DM Sans', sans-serif" },
  surface: { base: "#080c14", card: "#121a28", raised: "#0e1420" },
  radius: { sm: 4, md: 8, lg: 12 },
};

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

function cc(h, a=1) { return `hsla(${h},70%,60%,${a})`; }
function fmtHR(h) {
  if (!h) return "0 H/s";
  const u = [["EH/s",1e18],["PH/s",1e15],["TH/s",1e12],["GH/s",1e9],["MH/s",1e6],["KH/s",1e3],["H/s",1]];
  for (const [s,d] of u) if (h>=d) return (h/d).toFixed(2)+" "+s;
  return "0 H/s";
}

function Metric({ label, value, sub, state="mining" }) {
  const s = T.state[state];
  return (
    <div style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: T.radius.lg, padding: "14px 18px", boxShadow: `0 0 16px ${s.glow}` }}>
      <div style={{ fontSize: 10, color: "#4a5568", textTransform: "uppercase", letterSpacing: 2, fontFamily: T.type.mono }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: s.fg, fontFamily: T.type.display, marginTop: 4, letterSpacing: -1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#3a4a5a", fontFamily: T.type.mono, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function CodeBlock({ children, accent="#4a9eff" }) {
  return (
    <div style={{
      background: "#060a12", borderRadius: T.radius.sm, padding: "12px 16px",
      fontFamily: T.type.mono, fontSize: 14, color: accent,
      border: `1px solid ${accent}22`, position: "relative",
      userSelect: "all", cursor: "text",
    }}>{children}</div>
  );
}

function FaqSection({ num, title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <div style={{
          width: 32, height: 32, borderRadius: T.radius.md,
          background: T.state.mining.bg, border: `1px solid ${T.state.mining.border}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: T.type.display, fontWeight: 800, fontSize: 14, color: T.state.mining.fg,
        }}>{num}</div>
        <div style={{ fontFamily: T.type.display, fontSize: 17, fontWeight: 700, color: "#e2e8f0" }}>{title}</div>
      </div>
      <div style={{
        background: T.surface.card, border: `1px solid ${T.state.idle.border}`,
        borderRadius: T.radius.lg, padding: 20,
        fontSize: 13, color: "#8a9ab0", lineHeight: 1.7, fontFamily: T.type.body,
      }}>{children}</div>
    </div>
  );
}

function Sparkline({ data=[], w=400, h=50, hue=215 }) {
  if (data.length < 2) return <div style={{ width:w, height:h, background: T.surface.card, borderRadius: T.radius.md }} />;
  const max = Math.max(...data,1);
  const step = w/(data.length-1);
  const pts = data.map((v,i) => `${i*step},${h-(v/max)*(h-6)}`).join(" ");
  const c = cc(hue);
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <defs><linearGradient id="spf" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c} stopOpacity="0.2" /><stop offset="100%" stopColor={c} stopOpacity="0" /></linearGradient></defs>
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill="url(#spf)" />
      <polyline points={pts} fill="none" stroke={c} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export default function PublicDashboard() {
  const [view, setView] = useState("command");
  const [tick, setTick] = useState(0);

  useEffect(() => { const t = setInterval(() => setTick(k => k+1), 4000); return () => clearInterval(t); }, []);

  // Simulated live data (→ replace with fetch('/api/v1/pool/stats') in production)
  const poolHR = 325e9 + Math.sin(tick * 0.1) * 15e9;
  const miners = 20;
  const netDiff = 28462819;
  const height = 2847261 + Math.floor(tick / 12);
  const auxActive = 7;
  const hashHist = Array.from({length:48}, (_,i) => 300e9+Math.sin((i+tick)*0.15)*30e9+Math.random()*10e9);
  const fee = "2%";
  const soloFee = "1%";

  const views = [
    { id: "command", label: "Pool stats" },
    { id: "connect", label: "Connect" },
    { id: "faq", label: "Setup guide" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: T.surface.base, color: "#b0bfd0", fontFamily: T.type.body }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Unbounded:wght@400;600;800;900&family=IBM+Plex+Mono:wght@400;500;600&family=DM+Sans:wght@400;500;600;700&display=swap');
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes slideUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
        *{margin:0;padding:0;box-sizing:border-box}
        ::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-track{background:#080c14} ::-webkit-scrollbar-thumb{background:#1e2a3a;border-radius:3px}
      `}</style>

      {/* Header */}
      <header style={{ padding:"14px 28px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:`1px solid ${T.state.idle.border}`, background:"rgba(8,12,20,0.95)", backdropFilter:"blur(16px)", position:"sticky", top:0, zIndex:100 }}>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <div style={{ width:32, height:32, borderRadius:8, background:"linear-gradient(135deg, #4a9eff 0%, #a78bfa 100%)", display:"flex", alignItems:"center", justifyContent:"center" }}>
            <span style={{ fontFamily:T.type.display, fontSize:16, fontWeight:900, color:"#080c14" }}>L</span>
          </div>
          <div>
            <div style={{ fontFamily:T.type.display, fontSize:20, fontWeight:800, color:"#e2e8f0", letterSpacing:1 }}>LUXX<span style={{color:"#4a9eff"}}>POOL</span></div>
            <div style={{ fontSize:9, color:"#3a4a5a", fontFamily:T.type.mono, letterSpacing:1.5 }}>Scrypt multi-coin merged mining</div>
          </div>
        </div>
        <nav style={{ display:"flex", gap:2 }}>
          {views.map(v => (
            <button key={v.id} onClick={() => setView(v.id)} style={{
              padding:"7px 16px", border:"none", borderRadius:T.radius.sm, cursor:"pointer",
              fontSize:10, letterSpacing:2, fontFamily:T.type.mono, fontWeight:600,
              background: view===v.id ? T.state.mining.bg : "transparent",
              color: view===v.id ? T.state.mining.fg : "#3a4a5a", transition:"all 0.2s",
            }}>{v.label}</button>
          ))}
        </nav>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={{ width:7, height:7, borderRadius:"50%", background:"#34d399", boxShadow:"0 0 8px #34d399", animation:"pulse 2s infinite" }} />
          <span style={{ fontSize:10, fontFamily:T.type.mono, color:"#34d399" }}>LIVE</span>
        </div>
      </header>

      {/* Coin Strip */}
      <div style={{ padding:"8px 28px", display:"flex", gap:6, flexWrap:"wrap", borderBottom:`1px solid ${T.state.idle.border}`, background:`${T.surface.raised}80` }}>
        {COINS.filter(c => c.role==="parent" || ["DOGE","BELLS","LKY","PEP","DINGO","SHIC"].includes(c.sym)).map(c => (
          <span key={c.sym} style={{ display:"inline-flex", alignItems:"center", gap:5, padding:"4px 10px", borderRadius:16, fontSize:11, fontFamily:T.type.mono,
            background:`hsla(${c.hue},70%,60%,0.08)`, border:`1px solid hsla(${c.hue},70%,60%,0.2)`, color:cc(c.hue) }}>
            <span style={{ width:5, height:5, borderRadius:"50%", background:cc(c.hue), boxShadow:`0 0 4px ${cc(c.hue)}` }} />
            {c.sym}
          </span>
        ))}
      </div>

      <main style={{ padding:"20px 28px", maxWidth:1200, margin:"0 auto" }}>

        {/* ══════ POOL STATS ══════ */}
        {view === "command" && (
          <div style={{ animation:"slideUp 0.3s" }}>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))", gap:12, marginBottom:20 }}>
              <Metric label="Pool Hashrate" value={fmtHR(poolHR)} sub="Scrypt (N=1024)" state="mining" />
              <Metric label="Active Miners" value={miners} sub="pool + solo" state="found" />
              <Metric label="Network Difficulty" value={(netDiff/1e6).toFixed(1)+"M"} sub={`Block ${height.toLocaleString()}`} state="idle" />
              <Metric label="Coins Mining" value={`${1+auxActive}`} sub="LTC + merged aux" state="aux" />
              <Metric label="Pool Fee" value={fee} sub={`Solo: ${soloFee}`} state="mining" />
            </div>
            <div style={{ background:T.surface.card, border:`1px solid ${T.state.idle.border}`, borderRadius:T.radius.lg, padding:"14px 18px", marginBottom:20 }}>
              <div style={{ fontSize:10, color:"#3a4a5a", fontFamily:T.type.mono, letterSpacing:2, marginBottom:10 }}>Pool hashrate — 24h</div>
              <Sparkline data={hashHist} w={1120} h={60} hue={215} />
            </div>
            <div style={{ fontSize:10, color:"#3a4a5a", fontFamily:T.type.mono, letterSpacing:2, marginBottom:10 }}>Merged mining — earn all coins automatically AUTOMATICALLY</div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(140px, 1fr))", gap:8 }}>
              {COINS.filter(c => c.role==="aux").map(c => (
                <div key={c.sym} style={{ background:`hsla(${c.hue},70%,60%,0.05)`, border:`1px solid hsla(${c.hue},70%,60%,0.15)`, borderRadius:T.radius.md, padding:"10px 14px" }}>
                  <div style={{ fontFamily:T.type.display, fontWeight:800, fontSize:15, color:cc(c.hue) }}>{c.sym}</div>
                  <div style={{ fontSize:10, color:"#4a5568", fontFamily:T.type.mono }}>{c.name}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══════ CONNECT ══════ */}
        {view === "connect" && (
          <div style={{ animation:"slideUp 0.3s", maxWidth:700 }}>
            <div style={{ fontSize:10, color:"#3a4a5a", fontFamily:T.type.mono, letterSpacing:2, marginBottom:16 }}>QUICK CONNECT</div>

            <div style={{ background:T.state.mining.bg, border:`1px solid ${T.state.mining.border}`, borderRadius:T.radius.lg, padding:24, marginBottom:12 }}>
              <div style={{ fontFamily:T.type.display, fontSize:18, fontWeight:800, color:T.state.mining.fg, marginBottom:14 }}>Pool Mining <span style={{fontWeight:400, fontSize:13, color:"#4a5568"}}>(2% fee)</span></div>
              <div style={{ fontSize:9, color:"#3a4a5a", fontFamily:T.type.mono, letterSpacing:2, marginBottom:4 }}>STRATUM URL</div>
              <CodeBlock accent="#4a9eff">stratum+tcp://luxxpool.io:3333</CodeBlock>
              <div style={{ fontSize:9, color:"#3a4a5a", fontFamily:T.type.mono, letterSpacing:2, marginTop:12, marginBottom:4 }}>SSL STRATUM (ENCRYPTED)</div>
              <CodeBlock accent="#34d399">stratum+ssl://luxxpool.io:3334</CodeBlock>
              <div style={{ fontSize:9, color:"#3a4a5a", fontFamily:T.type.mono, letterSpacing:2, marginTop:12, marginBottom:4 }}>WORKER NAME</div>
              <CodeBlock accent="#8a9ab0"><span style={{color:"#fb923c"}}>YOUR_LTC_ADDRESS</span>.<span style={{color:"#a78bfa"}}>workerName</span></CodeBlock>
              <div style={{ fontSize:9, color:"#3a4a5a", fontFamily:T.type.mono, letterSpacing:2, marginTop:12, marginBottom:4 }}>PASSWORD</div>
              <CodeBlock accent="#5a6a7a">x</CodeBlock>
            </div>

            <div style={{ background:T.state.alert.bg, border:`1px solid ${T.state.alert.border}`, borderRadius:T.radius.lg, padding:24 }}>
              <div style={{ fontFamily:T.type.display, fontSize:18, fontWeight:800, color:T.state.alert.fg, marginBottom:14 }}>Solo Mining <span style={{fontWeight:400, fontSize:13, color:"#4a5568"}}>(1% fee — keep 99%)</span></div>
              <div style={{ fontSize:9, color:"#3a4a5a", fontFamily:T.type.mono, letterSpacing:2, marginBottom:4 }}>SOLO STRATUM</div>
              <CodeBlock accent="#fb923c">stratum+tcp://luxxpool.io:3336</CodeBlock>
            </div>
          </div>
        )}

        {/* ══════ FAQ & SETUP GUIDE ══════ */}
        {view === "faq" && (
          <div style={{ animation:"slideUp 0.3s", maxWidth:800 }}>
            <div style={{ fontFamily:T.type.display, fontSize:22, fontWeight:800, color:"#e2e8f0", marginBottom:6 }}>How to Mine Litecoin with LUXXPOOL</div>
            <div style={{ fontSize:13, color:"#4a5568", fontFamily:T.type.body, marginBottom:24 }}>Complete setup guide for ASIC miners (Antminer L9, L7, L3+, ElphaPex, VOLCMINER, and any Scrypt ASIC)</div>

            <FaqSection num="1" title="Get a Litecoin Wallet">
              <p style={{marginBottom:10}}>Before mining, you need a Litecoin (LTC) wallet address to receive payouts. Your wallet address is your identity on the pool — it's where all mined LTC is sent.</p>
              <p style={{marginBottom:10}}><strong style={{color:"#e2e8f0"}}>Recommended wallets:</strong></p>
              <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:10 }}>
                {[
                  { name: "Litecoin Core", desc: "Official full node wallet — most secure, syncs entire blockchain" },
                  { name: "Tangem", desc: "Hardware card wallet — cold storage, highly secure" },
                  { name: "Trust Wallet", desc: "Mobile wallet — easy to use, supports LTC + DOGE" },
                  { name: "Exodus", desc: "Desktop + mobile — multi-coin, built-in exchange" },
                ].map(w => (
                  <div key={w.name} style={{ padding:"8px 12px", background:"#0a0e17", borderRadius:T.radius.sm, border:`1px solid ${T.state.idle.border}` }}>
                    <span style={{ color:"#4a9eff", fontFamily:T.type.mono, fontSize:12, fontWeight:600 }}>{w.name}</span>
                    <span style={{ color:"#4a5568", fontSize:12 }}> — {w.desc}</span>
                  </div>
                ))}
              </div>
              <p style={{color:"#fb923c", fontSize:12}}>⚠ Never use an exchange deposit address as your mining payout address. Use a wallet you control.</p>
            </FaqSection>

            <FaqSection num="2" title="Hardware Requirements">
              <p style={{marginBottom:10}}>LUXXPOOL uses the <strong style={{color:"#e2e8f0"}}>Scrypt algorithm</strong> (N=1024, r=1, p=1). You need a Scrypt ASIC miner — GPU and CPU mining are not profitable for Litecoin.</p>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:10 }}>
                {[
                  { name: "Bitmain Antminer L9", hr: "16-17 GH/s", power: "3,260-3,360W" },
                  { name: "Bitmain Antminer L7", hr: "9.5 GH/s", power: "3,425W" },
                  { name: "ElphaPex DG2", hr: "17 GH/s", power: "3,420W" },
                  { name: "VOLCMINER D1", hr: "11 GH/s", power: "3,200W" },
                ].map(m => (
                  <div key={m.name} style={{ padding:"10px 12px", background:"#0a0e17", borderRadius:T.radius.sm, border:`1px solid ${T.state.idle.border}` }}>
                    <div style={{ color:"#e2e8f0", fontFamily:T.type.mono, fontSize:12, fontWeight:600 }}>{m.name}</div>
                    <div style={{ color:"#4a5568", fontSize:11, fontFamily:T.type.mono }}>{m.hr} · {m.power}</div>
                  </div>
                ))}
              </div>
              <p style={{fontSize:12}}>You also need: <strong style={{color:"#e2e8f0"}}>240V 30A dedicated circuit</strong>, ethernet cable (not WiFi), PDU rated for your miner's wattage, and adequate ventilation (miners generate significant heat and noise ~75dB).</p>
            </FaqSection>

            <FaqSection num="3" title="Configure Your Miner">
              <p style={{marginBottom:10}}>These steps work for any Antminer L-series. Other Scrypt ASICs follow a similar process.</p>
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                {[
                  { step: "Power on and connect ethernet", detail: "Plug your miner into a 240V outlet and connect an ethernet cable to your router. Wait for fans to spin up and the green LED to flash." },
                  { step: "Find your miner's IP address", detail: "Use Bitmain's IP Reporter tool, Angry IP Scanner, or check your router's DHCP client list. The miner will appear as a new device." },
                  { step: "Open the web interface", detail: "Enter the IP address in your browser (e.g., http://192.168.1.100). Login with default credentials: username root, password root." },
                  { step: "Go to Miner Configuration", detail: "Click 'Miner Configuration' or 'Settings' in the web interface. You'll see three pool URL fields (Pool 1, Pool 2, Pool 3)." },
                  { step: "Enter LUXXPOOL settings", detail: "Configure as shown below:" },
                ].map((s, i) => (
                  <div key={i} style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
                    <div style={{ minWidth:24, height:24, borderRadius:"50%", background:T.state.mining.bg, border:`1px solid ${T.state.mining.border}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, color:T.state.mining.fg, fontFamily:T.type.mono, fontWeight:600 }}>{String.fromCharCode(65+i)}</div>
                    <div>
                      <div style={{ color:"#e2e8f0", fontWeight:600, fontSize:13, marginBottom:2 }}>{s.step}</div>
                      <div style={{ color:"#6a7a8a", fontSize:12 }}>{s.detail}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop:16, padding:16, background:"#060a12", borderRadius:T.radius.md, border:`1px solid ${T.state.mining.border}` }}>
                <div style={{ fontSize:10, color:T.state.mining.fg, fontFamily:T.type.mono, letterSpacing:2, marginBottom:10 }}>MINER CONFIGURATION FIELDS</div>
                <div style={{ display:"grid", gridTemplateColumns:"100px 1fr", gap:"6px 12px", fontFamily:T.type.mono, fontSize:12 }}>
                  <span style={{color:"#4a5568"}}>Pool 1 URL:</span>
                  <span style={{color:"#4a9eff"}}>stratum+tcp://luxxpool.io:3333</span>
                  <span style={{color:"#4a5568"}}>Pool 2 URL:</span>
                  <span style={{color:"#34d399"}}>stratum+ssl://luxxpool.io:3334</span>
                  <span style={{color:"#4a5568"}}>Pool 3 URL:</span>
                  <span style={{color:"#6a7a8a"}}>(leave empty or add a backup pool)</span>
                  <span style={{color:"#4a5568"}}>Worker:</span>
                  <span><span style={{color:"#fb923c"}}>LTC_ADDRESS</span>.<span style={{color:"#a78bfa"}}>L9_01</span></span>
                  <span style={{color:"#4a5568"}}>Password:</span>
                  <span style={{color:"#6a7a8a"}}>x</span>
                </div>
              </div>

              <div style={{ marginTop:12, padding:"10px 14px", background:T.state.found.bg, border:`1px solid ${T.state.found.border}`, borderRadius:T.radius.sm }}>
                <span style={{ color:T.state.found.fg, fontFamily:T.type.mono, fontSize:12 }}>✓ Click "Save & Apply" — your miner will restart and begin hashing within 1-2 minutes</span>
              </div>
            </FaqSection>

            <FaqSection num="4" title="Merged Mining — Earn 10 Coins at Once">
              <p style={{marginBottom:10}}>LUXXPOOL uses <strong style={{color:"#e2e8f0"}}>Auxiliary Proof of Work (AuxPoW)</strong> to mine Litecoin and up to 9 additional Scrypt coins simultaneously. You earn all coins with zero extra configuration, zero extra power, and zero extra hardware.</p>
              <p style={{marginBottom:10}}>When you mine LTC, every share you submit is automatically checked against the difficulty targets of all auxiliary chains. If your share is strong enough to solve a block on DOGE, BELLS, or any other chain, that block is submitted and you earn those rewards too.</p>
              <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:12 }}>
                {COINS.map(c => (
                  <span key={c.sym} style={{ padding:"4px 10px", borderRadius:14, fontSize:11, fontFamily:T.type.mono,
                    background:`hsla(${c.hue},70%,60%,0.08)`, border:`1px solid hsla(${c.hue},70%,60%,0.2)`, color:cc(c.hue) }}>
                    {c.role==="parent" ? "⛏ " : "+ "}{c.sym}
                  </span>
                ))}
              </div>
              <p style={{fontSize:12, color:"#fb923c"}}>To receive rewards for auxiliary coins, register your wallet address for each coin via the API or dashboard settings. If no wallet is registered, rewards accumulate and are held until you register.</p>
            </FaqSection>

            <FaqSection num="5" title="Pool vs Solo Mining">
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                <div style={{ padding:14, background:T.state.mining.bg, border:`1px solid ${T.state.mining.border}`, borderRadius:T.radius.md }}>
                  <div style={{ fontFamily:T.type.display, fontWeight:700, fontSize:14, color:T.state.mining.fg, marginBottom:6 }}>Pool Mining</div>
                  <div style={{ fontSize:12, color:"#6a7a8a", lineHeight:1.6 }}>
                    Port <strong style={{color:"#e2e8f0"}}>3333</strong> · Fee: <strong style={{color:"#e2e8f0"}}>2%</strong><br/>
                    Shares block rewards across all pool miners proportionally (PPLNS). More consistent payouts. Recommended for most miners.
                  </div>
                </div>
                <div style={{ padding:14, background:T.state.alert.bg, border:`1px solid ${T.state.alert.border}`, borderRadius:T.radius.md }}>
                  <div style={{ fontFamily:T.type.display, fontWeight:700, fontSize:14, color:T.state.alert.fg, marginBottom:6 }}>Solo Mining</div>
                  <div style={{ fontSize:12, color:"#6a7a8a", lineHeight:1.6 }}>
                    Port <strong style={{color:"#e2e8f0"}}>3336</strong> · Fee: <strong style={{color:"#e2e8f0"}}>1%</strong><br/>
                    You keep 99% of any block you find. Higher variance — you may go days without a block, but when you hit one, it's all yours.
                  </div>
                </div>
              </div>
            </FaqSection>

            <FaqSection num="6" title="Payouts">
              <p style={{marginBottom:8}}>LUXXPOOL uses <strong style={{color:"#e2e8f0"}}>PPLNS (Pay Per Last N Shares)</strong> — your payout is proportional to your contributed shares within the recent window.</p>
              <div style={{ display:"grid", gridTemplateColumns:"140px 1fr", gap:"4px 12px", fontFamily:T.type.mono, fontSize:12, marginTop:8 }}>
                <span style={{color:"#4a5568"}}>Min LTC Payout:</span><span style={{color:"#e2e8f0"}}>0.01 LTC</span>
                <span style={{color:"#4a5568"}}>Min DOGE Payout:</span><span style={{color:"#e2e8f0"}}>40 DOGE</span>
                <span style={{color:"#4a5568"}}>Payout Interval:</span><span style={{color:"#e2e8f0"}}>Every 10 minutes (when threshold met)</span>
                <span style={{color:"#4a5568"}}>Block Maturity:</span><span style={{color:"#e2e8f0"}}>100 confirmations (LTC)</span>
                <span style={{color:"#4a5568"}}>LTC Block Reward:</span><span style={{color:"#e2e8f0"}}>6.25 LTC (post-halving)</span>
              </div>
            </FaqSection>

            <FaqSection num="7" title="Troubleshooting">
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                {[
                  { q: "Miner shows 0 hashrate on pool dashboard", a: "Wait 5-10 minutes after connecting. Hashrate is estimated from shares — it takes a window of submissions to calculate accurately." },
                  { q: "\"Stratum connection failed\" error", a: "Verify URL is stratum+tcp://luxxpool.io:3333 (not http://). Check your ethernet connection. Ensure port 3333 is not blocked by your firewall." },
                  { q: "Shares rejected / high reject rate", a: "Ensure your miner's clock is synchronized. Check that you're not sharing a worker name with another miner. If reject rate exceeds 2%, contact support." },
                  { q: "Not receiving DOGE / aux coin rewards", a: "Register your DOGE wallet address via the dashboard or API. Without a registered address, rewards are held but not lost." },
                  { q: "Can I use multiple miners with the same address?", a: "Yes. Use the same LTC address but different worker names: LTC_ADDRESS.miner1, LTC_ADDRESS.miner2, etc." },
                ].map((item, i) => (
                  <div key={i} style={{ padding:"10px 14px", background:"#0a0e17", borderRadius:T.radius.sm, border:`1px solid ${T.state.idle.border}` }}>
                    <div style={{ color:"#e2e8f0", fontWeight:600, fontSize:12, marginBottom:4 }}>{item.q}</div>
                    <div style={{ color:"#6a7a8a", fontSize:12 }}>{item.a}</div>
                  </div>
                ))}
              </div>
            </FaqSection>
          </div>
        )}
      </main>

      <footer style={{ padding:"12px 28px", borderTop:`1px solid ${T.state.idle.border}`, display:"flex", justifyContent:"space-between", fontSize:9, color:"#1e2a3a", fontFamily:T.type.mono }}>
        <span>LUXXPOOL v0.3.1 — Christina Lake, BC</span>
        <span>Scrypt Multi-Coin Merged Mining · {COINS.length} coins</span>
      </footer>
    </div>
  );
}
