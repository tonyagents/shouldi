#!/usr/bin/env node
// shouldi — pre-trade reasoning gate over LIVE MoonAgents state.
// Pulls real balances via `mp` every run. No proceedToken, no swap.
//
// Usage:
//   shouldi buy <usd> <SYMBOL>            e.g.  shouldi buy 20 TripleT
//   shouldi sell <usd> <SYMBOL>           e.g.  shouldi sell 4 TripleT
//   shouldi rotate <usd> <FROM> <TO>      e.g.  shouldi rotate 4 TripleT USDC
//   flags: --wallet <name=main>  --chain <name=solana>  --execute  --yes
//
// Add --execute to actually fire the swap IF the gate opens (real funds).

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const C = { r:"\x1b[31m", g:"\x1b[32m", y:"\x1b[33m", c:"\x1b[36m", b:"\x1b[1m", d:"\x1b[2m", x:"\x1b[0m" };
const die = m => { console.error(`${C.r}${m}${C.x}`); process.exit(1); };
const mp = (...a) => JSON.parse(execFileSync("mp", ["--json", ...a], { encoding: "utf8" }));

// ---- Decision Memory: we store decisions, not transactions ----
const MEM = path.join(import.meta.dirname, "decisions.jsonl");
const loadMem = () => { try { return fs.readFileSync(MEM,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
const remember = rec => fs.appendFileSync(MEM, JSON.stringify(rec)+"\n");
const today = () => new Date().toISOString().slice(0,10);

// ---- args ----
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt  = (n,d) => { const i = argv.indexOf(n); return i>=0 ? argv[i+1] : d; };
const pos  = argv.filter(a => !a.startsWith("--") && argv[argv.indexOf(a)-1]?.startsWith("--") === false || (!a.startsWith("--")));
const positional = argv.filter((a,i) => !a.startsWith("--") && !(i>0 && ["--wallet","--chain"].includes(argv[i-1])));
const [action, usdRaw, A, B] = positional;
const WALLET = opt("--wallet","main"), CHAIN = opt("--chain","solana");
const usd = parseFloat(usdRaw);
if (!["buy","sell","rotate"].includes(action) || isNaN(usd)) die("usage: shouldi buy|sell|rotate <usd> <SYMBOL> [TO]");

// normalize to a rotate {from,to}
const STABLES = ["USDC","USDT","DAI"];
const intent = action==="buy"    ? { from:"USDC", to:A.toUpperCase(), usd }
            : action==="sell"   ? { from:A.toUpperCase(), to:"USDC", usd }
            :                      { from:A.toUpperCase(), to:B.toUpperCase(), usd };

// ---- thresholds ----
const CONC=0.40, FLOOR=0.20, SECTOR=0.50;
const sev={proceed:0,caution:1,reconsider:2};

// ---- pull LIVE state ----
console.log(`${C.d}pulling live state for "${WALLET}" on ${CHAIN}…${C.x}`);
const wallets = mp("wallet","list");
const w = wallets.find(x => x.name===WALLET) || die(`no wallet named "${WALLET}"`);
const addr = w.addresses[CHAIN] || die(`wallet has no ${CHAIN} address`);
const bal = mp("token","balance","list","--wallet",addr,"--chain",CHAIN).items || [];

const sectorOf = t => STABLES.includes(t.symbol) ? "stable"
  : /prestock|prestock/i.test(t.name) || ["OPENAI","ANTHRP","ANTHROPIC"].includes(t.symbol) ? "ai-prestock"
  : t.symbol==="SOL"||t.symbol==="ETH" ? "l1" : "other";
const holdings = bal.map(t => ({ sym:t.symbol, name:t.name, mint:t.address,
  value:t.balance.value, amount:t.balance.amount, price:t.balance.price, sector:sectorOf(t) }));
const total = holdings.reduce((s,h)=>s+h.value,0) || 0.0001;
const stables = holdings.filter(h=>h.sector==="stable").reduce((s,h)=>s+h.value,0);
const get = sym => holdings.find(h=>h.sym.toUpperCase()===sym.toUpperCase());

// resolve target mint/price (may not be held yet)
let toTok = get(intent.to);
if (!toTok && !STABLES.includes(intent.to)) {
  try { const s = mp("token","search","--query",intent.to,"--chain",CHAIN);
        const hit = (s.items||s)[0]; if (hit) toTok = { sym:intent.to, mint:hit.address, price:hit.priceUsd||hit.price, value:0, sector:"other" }; } catch {}
}
const fromTok = get(intent.from);

// ---- recall: what have we decided about this asset before? ----
const subject = intent.to==="USDC" ? intent.from : intent.to;
const mem = loadMem().filter(d => d.wallet===WALLET);
const priorOnSubject = mem.filter(d => d.subject?.toUpperCase()===subject.toUpperCase());

// ---- the 5 checks ----
const curTo = toTok?.value || 0, curFrom = fromTok?.value || 0;
const reasons = [];
const buyingStable = STABLES.includes(intent.to);
const grows = STABLES.includes(intent.from);              // stable-funded buy adds to the book
const newTotal = grows ? total + usd : total;            // rotate between assets keeps book flat

if (!buyingStable) {
  const w2 = (curTo + usd) / newTotal;                                  // 1 concentration
  if (w2 > CONC) reasons.push({ lvl: w2>0.6?"reconsider":"caution", k:"concentration",
    m:`${intent.to} → ${(w2*100).toFixed(0)}% of your $${newTotal.toFixed(2)} book (limit 40%, now ${(curTo/total*100).toFixed(0)}%).` });
  const sec = toTok?.sector || "other";                              // 3 redundant/sector (skip catch-all "other")
  if (sec!=="stable" && sec!=="other") { const sv = (holdings.filter(h=>h.sector===sec).reduce((s,h)=>s+h.value,0)+usd)/newTotal;
    if (sv>SECTOR) reasons.push({ lvl:"caution", k:"redundant",
      m:`Sector "${sec}" → ${(sv*100).toFixed(0)}% (you hold ${holdings.filter(h=>h.sector===sec).map(h=>h.sym).join(" + ")||"none"}).` }); }
}
if (intent.from==="USDC") {                                          // 2 runway (buy funded by stables)
  if (usd > stables) reasons.push({ lvl:"reconsider", k:"runway",
    m:`Not fundable: needs $${usd}, you hold $${stables.toFixed(2)} stables on ${CHAIN}.` });
  else if ((stables-usd)/total < FLOOR) reasons.push({ lvl:"caution", k:"runway",
    m:`Leaves $${(stables-usd).toFixed(2)} dry powder (<20% of book).` });
} else {                                                             // selling/rotating: need enough of FROM
  if (!fromTok || usd > curFrom) reasons.push({ lvl:"reconsider", k:"runway",
    m:`You only hold $${curFrom.toFixed(2)} of ${intent.from}.` });
}
const fromW = curFrom/total;                                         // de-risk bonus
if (buyingStable && fromW>CONC) reasons.push({ lvl:"proceed", k:"rebalance",
  m:`Trims ${intent.from} from ${(fromW*100).toFixed(0)}% → cuts your top concentration. Good hygiene.` });

if (priorOnSubject.length && !buyingStable && action!=="sell") {     // 6 memory: repeated ADD intent
  const last = priorOnSubject[priorOnSubject.length-1];
  reasons.push({ lvl:"caution", k:"memory",
    m:`You've weighed ${subject} ${priorOnSubject.length}× before — last verdict "${last.verdict}" on ${last.date}. Has anything actually changed?` });
}

const real = reasons.filter(r=>r.lvl!=="proceed");
const verdict = real.length ? Object.keys(sev).find(k=>sev[k]===Math.max(...real.map(r=>sev[r.lvl]))) : "proceed";

// ---- proceedToken: HMAC bound to exact intent ----
const SECRET = process.env.SHOULDI_KEY || "moonagents-decision-key";
const key = `${WALLET}:${CHAIN}:${intent.from}->${intent.to}:${usd}`;
const token = verdict==="proceed" ? "dec_"+crypto.createHmac("sha256",SECRET).update(key).digest("hex").slice(0,16) : null;

// ---- assemble the Decision Brief (slide 7 format) ----
const hardNo = reasons.some(r=>r.lvl==="reconsider");
const confidence = verdict==="proceed" ? (reasons.some(r=>r.k==="rebalance")?88:82)
  : hardNo ? Math.min(96, 80+real.length*5) : Math.min(80, 64+real.length*6);

const why = verdict==="proceed"
  ? (reasons.filter(r=>r.lvl==="proceed").map(r=>r.m).concat("Within every risk limit and consistent with your positioning.")).slice(0,2)
  : real.sort((a,b)=>sev[b.lvl]-sev[a.lvl]).map(r=>r.m);

const tradeoffs = [];
if (!buyingStable) tradeoffs.push(`Concentrates more capital into ${subject} and spends dry powder you can't quickly redeploy.`);
if (buyingStable || action!=="buy") tradeoffs.push(`Gives up upside if ${intent.from} keeps running, and locks the move in now.`);

const dom = real.sort((a,b)=>sev[b.lvl]-sev[a.lvl])[0]?.k;
const missing =
    dom==="runway" && intent.from==="USDC" ? `Whether you'll bring stables on-chain — you have off-chain USDC a bridge away, which alone flips fundability.`
  : dom==="concentration" ? `Your conviction and time-horizon on ${subject} — strong conviction can justify a heavier weight.`
  : dom==="redundant"     ? `Whether you treat your AI-prestocks as one bet or several.`
  : dom==="memory"        ? `What's actually changed since the last time you weighed ${subject}.`
  : verdict==="proceed"   ? `Your target weight for ${intent.from} — how far down you want to trim.`
  :                         `Your goal for this wallet: active trading vs. long-term hold.`;

const safeBuy = Math.max(0,(CONC*newTotal - curTo)/(1-CONC));
const next =
    verdict==="proceed" ? `Fire it → shouldi ${action} ${usd} ${subject}${action==="rotate"?" "+intent.to:""} --execute`
  : dom==="runway" && intent.from==="USDC" ? (usd>stables
      ? `Bridge stables to ${CHAIN}, or size down to ~$${stables.toFixed(2)} (your on-chain dry powder).`
      : `Trim the size so you keep >20% dry powder.`)
  : dom==="concentration" ? `Size down to ~$${safeBuy.toFixed(2)} to keep ${subject} under 40% of the book.`
  : dom==="redundant"     ? `Cap the AI-prestock sleeve, or rebalance an existing holding instead of adding.`
  :                         `Re-run at a smaller size, or override if you have conviction the checks can't see.`;

// ---- print Decision Brief ----
const recMap = {proceed:`${C.g}YES`, caution:`${C.y}YES — with caution`, reconsider:`${C.r}NO — not as framed`};
console.log(`\n${C.b}━━ DECISION BRIEF ━━${C.x}  ${C.d}${action} $${usd} ${subject}${action==="rotate"?" → "+intent.to:""} · "${WALLET}" · book $${total.toFixed(2)}${C.x}\n`);
console.log(`  ${C.b}RECOMMENDATION${C.x}   ${recMap[verdict]}${C.x}`);
console.log(`  ${C.b}CONFIDENCE${C.x}       ${confidence}%`);
console.log(`\n  ${C.b}WHY${C.x}`);          why.forEach(m=>console.log(`    • ${m}`));
console.log(`\n  ${C.b}TRADE-OFFS${C.x}`);   tradeoffs.slice(0,2).forEach(m=>console.log(`    • ${m}`));
console.log(`\n  ${C.b}MISSING INFO${C.x}\n    • ${missing}`);
console.log(`\n  ${C.b}NEXT ACTION${C.x}\n    • ${next}`);
console.log(`\n  ${C.d}execute() gate: ${token ? C.g+"OPEN "+token+C.x : C.r+"CLOSED (override required)"+C.x}`);

// ---- store the decision (we store decisions, not transactions) ----
const verb = verdict==="proceed" ? `cleared: ${action} ${subject}`
           : verdict==="reconsider" ? `declined: ${action} ${subject}` : `flagged: ${action} ${subject}`;
const line = `${verb} ($${usd}) — ${(why[0]||"").replace(/\.$/,"")}`;
const record = { ts:new Date().toISOString(), date:today(), wallet:WALLET, chain:CHAIN,
  action, subject, from:intent.from, to:intent.to, usd, verdict, confidence,
  brief:{ why, tradeoffs:tradeoffs.slice(0,2), missing, next }, line, executed:false };

if (priorOnSubject.length){
  console.log(`\n  ${C.b}DECISION MEMORY${C.x} ${C.d}· ${subject} (${priorOnSubject.length} prior)${C.x}`);
  for (const d of priorOnSubject.slice(-3)) console.log(`    ${C.d}${d.date}${C.x}  ${d.line}`);
}
remember(record);

// ---- execute (only if gate open + --execute) ----
if (!flag("--execute")) {
  console.log(`\n${C.d}add --execute to fire the swap when the gate is open.${C.x}`);
  process.exit(0);
}
if (verdict!=="proceed" || !token) die(`\n✗ BLOCKED — verdict is "${verdict}". The gate will not pass an unsafe trade.`);
if (!fromTok || !toTok?.mint) die("\n✗ can't resolve token mints for execution.");

const amtIn = +(usd / fromTok.price).toFixed(6);
console.log(`\n${C.c}gate open → quoting ${amtIn} ${fromTok.sym} → ${toTok.sym}…${C.x}`);
const q = mp("token","quote","--from-chain",CHAIN,"--from-token",fromTok.mint,"--from-amount",String(amtIn),
             "--to-chain",CHAIN,"--to-token",toTok.mint);
console.log(`  ${C.b}${q.message||JSON.stringify(q)}${C.x}`);
if (!flag("--yes")) { console.log(`\n${C.d}re-run with --yes to broadcast this swap on-chain.${C.x}`); process.exit(0); }
console.log(`${C.c}broadcasting…${C.x}`);
const r = mp("token","swap","--wallet",WALLET,"--chain",CHAIN,"--from-token",fromTok.mint,
             "--from-amount",String(amtIn),"--to-token",toTok.mint);
const tx = r.transactionId||r.txHash||"";
console.log(`${C.g}${C.b}✓ swapped.${C.x} ` + (tx||JSON.stringify(r)));
remember({ ...record, executed:true, tx, line:`executed: ${action} $${usd} ${subject} — ${q.message||""}`.trim() });
