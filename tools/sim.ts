// Local research simulator: an independent re-implementation of the replay's market model as RULES.txt
// and the kit's harness describe it (fills 2 slots after the decision, persistent self-impact, curve
// fees from the landing trade, tx fees, the seeded 2% failure draw keyed like the dev phase, closes on
// complete and at the end). It exists only to iterate on strategy.ts quickly and to print per-coin
// detail; the score that counts is always `agentfun grade-local`.
//
//   node tools/sim.ts [--params '{"tpBps":3000}'] [--verbose] [--kit <dir>]
//
// Not part of the bot: the grader runs main.ts only.

import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BotState, type Batch, type Fill, type Hello, type Mark, type Order } from '../vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';

interface CurveState {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
}
interface Offset {
  quote: bigint;
  tokens: bigint;
}
interface MintRt {
  state: CurveState;
  stateSlot: number;
  lastTrade: any | null;
  lastTradeSlot: number;
  complete: boolean;
  offset: Offset;
}
interface Pending {
  order: Order;
  seq: number;
  index: number;
  decidedSlot: number;
  fillSlot: number;
  reject: string | null;
  decision: CurveState | null;
}

const BPS = 10_000n;
const MASK = (1n << 64n) - 1n;
const GAMMA = 0x9e3779b97f4a7c15n;
function mix64(z0: bigint): bigint {
  let z = z0 & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return z ^ (z >> 31n);
}
function keyed(seed: bigint, ...parts: bigint[]): bigint {
  let h = mix64((seed + GAMMA) & MASK);
  for (const p of parts) h = mix64((h ^ (p & MASK)) + GAMMA);
  return h;
}
const FAILED_TX = 0x6661696c65642d74n;
const PUBLIC_FAIL_KEY = 0x6661696c2d6b6579n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const feeOf = (amount: bigint, bps: bigint) => ceilDiv(amount * bps, BPS);

function offsetReserves(r: CurveState, off: Offset): CurveState {
  let num = 1n;
  let den = 1n;
  if (off.tokens > r.rt) {
    num = r.rt;
    den = off.tokens;
  }
  if (off.quote < 0n && r.rq * den < num * -off.quote) {
    num = r.rq;
    den = -off.quote;
  }
  const scale = (x: bigint) => (num === den ? x : x >= 0n ? (x * num) / den : -((-x * num) / den));
  const q = scale(off.quote);
  const t = scale(off.tokens);
  return { vq: r.vq + q, rq: r.rq + q, vt: r.vt - t, rt: r.rt - t };
}

function quoteBuy(spend: bigint, s: CurveState, p: bigint, c: bigint) {
  const net0 = (spend * BPS) / (BPS + p + c);
  const fee = feeOf(net0, p);
  const cf = feeOf(net0, c);
  const over = net0 + fee + cf > spend ? net0 + fee + cf - spend : 0n;
  const q = net0 - over;
  const t = q <= 1n ? 0n : ((q - 1n) * s.vt) / (s.vq + q - 1n);
  if (t > s.rt) {
    const tc = s.rt;
    if (tc === 0n) return { q: 0n, t: 0n, fee: 0n, cf: 0n, paid: 0n };
    const qq = (tc * s.vq) / (s.vt - tc) + 1n;
    const f2 = feeOf(qq, p);
    const c2 = feeOf(qq, c);
    return { q: qq, t: tc, fee: f2, cf: c2, paid: qq + f2 + c2 };
  }
  return { q, t, fee, cf, paid: q + fee + cf };
}
function quoteSell(t: bigint, s: CurveState, p: bigint, c: bigint) {
  const q = (t * s.vq) / (s.vt + t);
  const fee = feeOf(q, p);
  const cf = feeOf(q, c);
  return { q, fee, cf, proceeds: q - fee - cf };
}

export interface SimResult {
  net: bigint;
  /** Net PnL of the coins created in the first and the second half of the window. */
  halves: [bigint, bigint];
  fills: number;
  mints: number;
  failed: number;
  rejected: Record<string, number>;
  maxDD: number;
  perMint: Map<string, bigint>;
  log: string[];
  stats: Record<string, number>;
}

const cache = new Map<string, { manifest: any; events: any[] }>();
function load(kit: string) {
  let c = cache.get(kit);
  if (c === undefined) {
    const events: any[] = [];
    for (const part of ['part-00000', 'part-00001', 'part-00002']) {
      const raw = gunzipSync(readFileSync(`${kit}/dataset/events/${part}.ndjson.gz`)).toString('utf8');
      for (const l of raw.split('\n')) if (l.length > 0) events.push(JSON.parse(l));
    }
    c = { manifest: JSON.parse(readFileSync(`${kit}/dataset/manifest.json`, 'utf8')), events };
    cache.set(kit, c);
  }
  return c;
}

export function simulate(kit: string, params: Params, verbose = false, range?: { from: number; to: number }): SimResult {
  const { manifest, events } = load(kit);
  const evs = range === undefined ? events : events.filter((e) => e.slot >= range.from && e.slot <= range.to);
  const evList = evs;
  const sample = manifest.universe.sample;
  const universe = new Set<string>();
  for (const e of evList) {
    if (e.event !== 'CreateEvent') continue;
    if (e.quote_mint !== '11111111111111111111111111111111' || e.is_mayhem_mode || e.is_cashback_enabled) continue;
    const h = BigInt(`0x${createHash('sha256').update(e.mint, 'utf8').digest('hex')}`);
    if (h % BigInt(sample.modulus) === BigInt(sample.residue)) universe.add(e.mint);
  }
  const batches: { slot: number; events: any[] }[] = [];
  for (const e of evList) {
    if (!universe.has(e.mint)) continue;
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  const endSlot: number = range === undefined ? manifest.window.end_slot : range.to;
  const hello: Hello = {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed: '1351489192800835981',
    universe: { program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', quote: 'SOL', mayhem: 'excluded', exclude_cashback: true, sample },
    capital: { lamports: '10000000000' },
    caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
    latency_slots: 2,
    fees: { protocol_bps_fallback: 95, creator_bps_fallback: 30, base_fee_lamports: '5000', priority_fee_lamports: '100000', failed_tx_bps: 200 },
  };
  const failKey = keyed(BigInt(hello.seed), PUBLIC_FAIL_KEY);
  const txFee = 105_000n;
  const start = 10_000_000_000n;
  let cash = start;
  const mints = new Map<string, MintRt>();
  const positions = new Map<string, { tokens: bigint; cost: bigint }>();
  const pending: Pending[] = [];
  const usedIds = new Set<string>();
  let undelivered: Fill[] = [];
  const perMint = new Map<string, bigint>();
  const log: string[] = [];
  const rejected: Record<string, number> = {};
  let fills = 0;
  let failed = 0;
  const filledMints = new Set<string>();
  let closeCounter = 0;
  const spent = { seq: -1, byMint: new Map<string, bigint>() };
  let peak = 0n;
  let maxDD = 0;
  const addPnl = (mint: string, d: bigint) => perMint.set(mint, (perMint.get(mint) ?? 0n) + d);
  const reserves = (m: MintRt) => offsetReserves(m.state, m.offset);
  const feesFor = (landing: any | null) =>
    landing !== null && BigInt(landing.fee_basis_points) > 0n
      ? { p: BigInt(landing.fee_basis_points), c: BigInt(landing.creator_fee_basis_points), fallback: false }
      : { p: 95n, c: 30n, fallback: true };
  const fillBase = (p: Pending): Fill => ({
    client_id: p.order.client_id,
    mint: p.order.mint,
    side: p.order.side,
    status: 'rejected',
    reason: null,
    decided_slot: p.decidedSlot,
    slot: p.fillSlot,
    quote_lamports: '0',
    token_amount: '0',
    fee_lamports: '0',
    tx_fee_lamports: '0',
    fee_fallback: false,
  });
  const reject = (p: Pending, reason: string) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
    undelivered.push({ ...fillBase(p), reason: reason as any });
  };
  const openCount = () => positions.size;
  const failedDraw = (p: Pending) => keyed(failKey, FAILED_TX, BigInt(p.seq), BigInt(p.index)) % 10_000n < 200n;

  const resolve = (p: Pending, curSlot: number) => {
    if (p.reject !== null) return reject(p, p.reject);
    const m = mints.get(p.order.mint)!;
    if (m.complete) return reject(p, 'token_complete');
    const landing = m.lastTradeSlot === p.fillSlot ? m.lastTrade : null;
    const bps = feesFor(landing);
    const slip = BigInt(p.order.max_slippage_bps);
    const s = reserves(m);
    if (p.order.side === 'sell') {
      const pos = positions.get(p.order.mint);
      const t = BigInt(p.order.token_amount);
      if (pos === undefined || pos.tokens < t) return reject(p, 'insufficient_tokens');
      const sq = quoteSell(t, s, bps.p, bps.c);
      if (sq.q > s.rq) return reject(p, 'max_order_size');
      if (sq.proceeds <= 0n) return reject(p, 'zero_amount');
      const expected = quoteSell(t, p.decision!, bps.p, bps.c).proceeds;
      if (sq.proceeds * BPS < expected * (BPS - slip)) return reject(p, 'max_slippage');
      if (cash < txFee) return reject(p, 'insufficient_cash');
      if (failedDraw(p)) {
        cash -= txFee;
        addPnl(p.order.mint, -txFee);
        failed++;
        undelivered.push({ ...fillBase(p), status: 'failed', tx_fee_lamports: txFee.toString() });
        return;
      }
      cash += sq.proceeds - txFee;
      addPnl(p.order.mint, sq.proceeds - txFee);
      const removed = pos.tokens === t ? pos.cost : (pos.cost * t) / pos.tokens;
      pos.tokens -= t;
      pos.cost -= removed;
      m.offset = { quote: m.offset.quote - sq.q, tokens: m.offset.tokens - t };
      if (pos.tokens === 0n) positions.delete(p.order.mint);
      fills++;
      filledMints.add(p.order.mint);
      if (verbose) log.push(`${curSlot} SELL ${p.order.mint.slice(0, 6)} ${p.order.client_id} tokens=${t} proceeds=${Number(sq.proceeds) / 1e9}`);
      undelivered.push({
        ...fillBase(p),
        status: 'filled',
        quote_lamports: sq.proceeds.toString(),
        token_amount: t.toString(),
        fee_lamports: (sq.fee + sq.cf).toString(),
        tx_fee_lamports: txFee.toString(),
        fee_fallback: bps.fallback,
      });
      return;
    }
    const spend = BigInt(p.order.quote_lamports);
    const held = positions.get(p.order.mint);
    if (held === undefined && openCount() >= 5) return reject(p, 'max_open_positions');
    if (spent.seq !== p.seq) {
      spent.seq = p.seq;
      spent.byMint.clear();
    }
    const total = (spent.byMint.get(p.order.mint) ?? 0n) + spend;
    if (total * BPS > p.decision!.rq * 100n) return reject(p, 'max_order_size');
    spent.byMint.set(p.order.mint, total);
    const bq = quoteBuy(spend, s, bps.p, bps.c);
    if (bq.t === 0n) return reject(p, 'zero_amount');
    const expected = quoteBuy(spend, p.decision!, bps.p, bps.c).t;
    if (bq.t * BPS < expected * (BPS - slip)) return reject(p, 'max_slippage');
    if (cash < spend + txFee) return reject(p, 'insufficient_cash');
    if (failedDraw(p)) {
      cash -= txFee;
      addPnl(p.order.mint, -txFee);
      failed++;
      undelivered.push({ ...fillBase(p), status: 'failed', tx_fee_lamports: txFee.toString() });
      return;
    }
    cash -= bq.paid + txFee;
    addPnl(p.order.mint, -(bq.paid + txFee));
    const pos = held ?? { tokens: 0n, cost: 0n };
    pos.tokens += bq.t;
    pos.cost += bq.paid;
    positions.set(p.order.mint, pos);
    m.offset = { quote: m.offset.quote + bq.q, tokens: m.offset.tokens + bq.t };
    fills++;
    filledMints.add(p.order.mint);
    if (verbose) log.push(`${curSlot} BUY  ${p.order.mint.slice(0, 6)} ${p.order.client_id} paid=${Number(bq.paid) / 1e9} rq=${Number(s.rq) / 1e9}`);
    undelivered.push({
      ...fillBase(p),
      status: 'filled',
      quote_lamports: bq.paid.toString(),
      token_amount: bq.t.toString(),
      fee_lamports: (bq.fee + bq.cf).toString(),
      tx_fee_lamports: txFee.toString(),
      fee_fallback: bps.fallback,
    });
  };

  const closeQuote = (m: MintRt, tokens: bigint) => {
    const s = reserves(m);
    const bps = feesFor(m.lastTrade);
    const sq = quoteSell(tokens, s, bps.p, bps.c);
    const q = sq.q > s.rq ? s.rq : sq.q;
    const proceeds = q - feeOf(q, bps.p) - feeOf(q, bps.c);
    return { q, proceeds, net: proceeds - txFee, abandon: proceeds - txFee <= 0n };
  };
  const forceClose = (mint: string, why: string, slot: number) => {
    const pos = positions.get(mint)!;
    const m = mints.get(mint)!;
    const c = closeQuote(m, pos.tokens);
    const n = closeCounter++;
    if (!c.abandon) {
      cash += c.net;
      addPnl(mint, c.net);
      m.offset = { quote: m.offset.quote - c.q, tokens: m.offset.tokens - pos.tokens };
    }
    if (verbose) log.push(`${slot} CLOSE(${why}) ${mint.slice(0, 6)} net=${Number(c.net) / 1e9}`);
    positions.delete(mint);
    undelivered.push({
      client_id: `_${c.abandon ? 'writeoff' : why}_${n}`,
      mint,
      side: 'sell',
      status: 'filled',
      reason: null,
      decided_slot: slot,
      slot,
      quote_lamports: c.abandon ? '0' : c.proceeds.toString(),
      token_amount: pos.tokens.toString(),
      fee_lamports: '0',
      tx_fee_lamports: c.abandon ? '0' : txFee.toString(),
      fee_fallback: false,
    });
  };
  const equity = () => {
    let e = cash;
    for (const [mint, p] of positions) {
      const c = closeQuote(mints.get(mint)!, p.tokens);
      if (!c.abandon) e += c.net;
    }
    return e;
  };
  const track = (e: bigint) => {
    if (e > peak) peak = e;
    if (peak > 0n) {
      const dd = Number(peak - e) / Number(peak);
      if (dd > maxDD) maxDD = dd;
    }
  };
  const account = () => ({
    cash_lamports: cash.toString(),
    positions: [...positions.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([mint, p]) => ({ mint, token_amount: p.tokens.toString(), cost_lamports: p.cost.toString() })),
  });

  const state = new BotState(hello);
  const strategy = createStrategy(params);
  track(cash);
  let seq = 0;
  for (const b of batches) {
    const x = b.slot;
    while (pending.length > 0 && pending[0]!.fillSlot < x) {
      const p = pending.shift()!;
      resolve(p, p.fillSlot);
    }
    const completed: string[] = [];
    for (const e of b.events) {
      if (e.event === 'CreateEvent') {
        mints.set(e.mint, {
          state: { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves), rq: 0n, rt: BigInt(e.real_token_reserves) },
          stateSlot: x,
          lastTrade: null,
          lastTradeSlot: -1,
          complete: false,
          offset: { quote: 0n, tokens: 0n },
        });
      } else if (e.event === 'TradeEvent') {
        const m = mints.get(e.mint)!;
        m.state = { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves), rq: BigInt(e.real_quote_reserves), rt: BigInt(e.real_token_reserves) };
        m.stateSlot = x;
        m.lastTrade = e;
        m.lastTradeSlot = x;
      } else {
        mints.get(e.mint)!.complete = true;
        completed.push(e.mint);
      }
    }
    for (const mint of completed) if (positions.has(mint)) forceClose(mint, 'complete', x);
    while (pending.length > 0 && pending[0]!.fillSlot === x) resolve(pending.shift()!, x);
    const want = new Set<string>(positions.keys());
    for (const p of pending) if (mints.has(p.order.mint)) want.add(p.order.mint);
    const marks: Mark[] = [...want].sort().map((mint) => {
      const m = mints.get(mint)!;
      const s = reserves(m);
      return { mint, slot: m.stateSlot, virtual_token_reserves: s.vt.toString(), virtual_quote_reserves: s.vq.toString(), real_token_reserves: s.rt.toString(), real_quote_reserves: s.rq.toString() };
    });
    const batch: Batch = { type: 'batch', seq, slot: x, events: b.events, marks, fills: undelivered, account: account() };
    undelivered = [];
    track(equity());
    state.applyBatch(batch);
    const orders = state.toOrders(strategy.onBatch(state, batch));
    state.recordOrders(orders);
    orders.forEach((order, index) => {
      let rej: string | null = null;
      const amount = order.side === 'buy' ? order.quote_lamports : order.token_amount;
      if (index >= 16) rej = 'max_orders_per_batch';
      else if (usedIds.has(order.client_id)) rej = 'duplicate_client_id';
      else if (amount === '0') rej = 'zero_amount';
      else if (!mints.has(order.mint)) rej = 'not_in_universe';
      usedIds.add(order.client_id);
      const m = mints.get(order.mint);
      pending.push({ order, seq, index, decidedSlot: x, fillSlot: x + 2, reject: rej, decision: m ? reserves(m) : null });
    });
    seq++;
  }
  while (pending.length > 0) {
    const p = pending.shift()!;
    if (p.fillSlot > endSlot) reject(p, 'after_end');
    else resolve(p, endSlot);
  }
  for (const mint of [...positions.keys()].sort()) forceClose(mint, 'flatten', endSlot);
  track(cash);
  const mid = (manifest.window.start_slot + endSlot) / 2;
  const halves: [bigint, bigint] = [0n, 0n];
  for (const e of events) if (e.event === 'CreateEvent' && perMint.has(e.mint)) halves[e.slot < mid ? 0 : 1] += perMint.get(e.mint)!;
  return { net: cash - start, halves, fills, mints: filledMints.size, failed, rejected, maxDD, perMint, log, stats: (strategy as any).stats };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const kit = get('--kit') ?? '/home/hatch/workspace/makefun/kit-pump-fun-paper/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-kit';
  const params: Params = { ...DEFAULT_PARAMS, ...JSON.parse(get('--params') ?? '{}') };
  const verbose = args.includes('--verbose');
  const sf = get('--slot-from');
  const st = get('--slot-to');
  const range = sf !== undefined && st !== undefined ? { from: Number(sf), to: Number(st) } : undefined;
  const r = simulate(kit, params, verbose, range);
  if (verbose) for (const l of r.log) console.log(l);
  if (args.includes('--per-mint')) {
    const rows = [...r.perMint.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1));
    for (const [m, v] of rows) console.log(m.slice(0, 8), (Number(v) / 1e9).toFixed(6));
  }
  console.log('strategy stats', JSON.stringify(r.stats));
  console.log(
    `net ${(Number(r.net) / 1e9).toFixed(6)} SOL  halves ${(Number(r.halves[0]) / 1e9).toFixed(3)}/${(Number(r.halves[1]) / 1e9).toFixed(3)}  fills ${r.fills}  mints ${r.mints}  failed ${r.failed}  maxDD ${r.maxDD.toFixed(4)}  rejected ${JSON.stringify(r.rejected)}`,
  );
}
