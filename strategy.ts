// Twenty Tickets — a pump.fun paper-trading bot for agent-fun/replay/v2.
//
// Idea, written from the harness spec and calibrated on the dev window. Every
// directional signal tested on the dev data has negative expectancy after the
// harness's 2-slot latency and fees: dip-buying ends about -4% per trade,
// early momentum about -8%. The market is negative-sum for a trader, and the
// bounty is winner-takes-all with a single $2 place that only pays a net PnL
// above zero — so the right play is NOT to maximise volume. It is to take the
// minimum qualifying volume (20 round trips), on the highest-upside setups,
// and let variance do the work: a few small losers are survivable, one runner
// pays for all of them.
//
// So this bot buys exactly 20 tickets, then stops trading and holds cash:
//   - Entry: the first time a curve younger than ~30 minutes has at least 2
//     trades and at least 2 SOL of real reserves — early enough to catch a
//     run, late enough to skip instant deaths. Size 0.20 SOL, capped at 90%
//     of the harness per-mint size cap (1% of real reserves). One entry per
//     mint, ever.
//   - Pyramid: one add-on per winner — when a held coin is up 50% and its
//     real reserves reach 10 SOL, add 0.18 SOL. Winners get the size.
//   - Exits: no take profit. A 15% trailing stop from the post-entry peak
//     (which is also the stop loss while the price never rises), a 60-minute
//     max hold, and an exit when the mint goes quiet for ~15 minutes.
//   - Risk: at most 5 open positions; an equity circuit breaker halts new
//     buys after a 25% drawdown from peak equity. No shorts, no leverage.
//
// Every rule is deterministic: no clock, no Math.random, no environment reads
// — the two grading executions see the same decisions. Prices are exact
// BigInt rationals (virtual_quote_reserves / virtual_token_reserves).

import {
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Minimum trades seen on a curve before it can be bought. */
  minTrades: number;
  /** Minimum real SOL reserves (lamports) at decision time. */
  minRealLamports: bigint;
  /** Only buy this soon after the curve was created, in slots. */
  maxAgeSlots: number;
  /** Target buy size in lamports (capped by 90% of the per-mint size cap). */
  buyLamports: bigint;
  /** Trailing stop distance below the post-entry peak, in bps. */
  trailBps: number;
  /** Maximum hold, in slots. */
  maxHoldSlots: number;
  /** Sell when the mint has not traded for this many slots. */
  idleSlots: number;
  /** Halt new buys after equity falls this far below its peak, in bps. */
  breakerBps: number;
  /** Stop opening new tickets once this many are committed (done + open). */
  maxTickets: number;
  /** Add to a winner once it is up this far above entry, in bps. */
  pyramidTriggerBps: number;
  /** Minimum real SOL reserves (lamports) for the add-on buy. */
  pyramidMinRealLamports: bigint;
  /** Add-on buy size in lamports (capped by 90% of the per-mint size cap). */
  pyramidLamports: bigint;
}

export const DEFAULT_PARAMS: Params = {
  minTrades: 2,
  minRealLamports: 2_000_000_000n,
  maxAgeSlots: 8400,
  buyLamports: 20_000_000n,
  trailBps: 1500,
  maxHoldSlots: 16800,
  idleSlots: 4200,
  breakerBps: 2500,
  maxTickets: 20,
  pyramidTriggerBps: 5000,
  pyramidMinRealLamports: 10_000_000_000n,
  pyramidLamports: 180_000_000n,
};

/** A price as an exact rational: SOL per token = q / t. */
interface Price {
  q: bigint;
  t: bigint;
}

function cmpPrice(a: Price, b: Price): number {
  const l = a.q * b.t;
  const r = b.q * a.t;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** Price scaled by num/den (bps math: num and den in the same units). */
function scalePrice(p: Price, num: bigint, den: bigint): Price {
  return { q: p.q * num, t: p.t * den };
}

interface MintTrack {
  createdSlot: number;
  trades: number;
  price: Price;
  lastTradeSlot: number;
  realQuote: bigint;
  complete: boolean;
}

interface Held {
  entry: Price;
  entrySlot: number;
  peak: Price;
  /** Whether the one pyramid add-on already fired for this position. */
  added: boolean;
}

const BPS = 10_000n;
const MAX_SLIPPAGE_BPS = 500;

export function createStrategy(params: Params = DEFAULT_PARAMS) {
  // Normalise the lamport params: JSON overrides arrive as numbers, the
  // defaults are bigints; arithmetic below needs bigints throughout.
  params = {
    ...params,
    minRealLamports: BigInt(params.minRealLamports),
    buyLamports: BigInt(params.buyLamports),
    pyramidMinRealLamports: BigInt(params.pyramidMinRealLamports),
    pyramidLamports: BigInt(params.pyramidLamports),
  };
  const tracks = new Map<string, MintTrack>();
  const held = new Map<string, Held>();
  /** Mints already traded once: one entry per mint, ever. */
  const dead = new Set<string>();
  /** Mints with a sell already in flight: never stack a second sell on them. */
  const pendingSell = new Set<string>();
  /** Round trips finished (a sell fill after a buy fill). */
  let ticketsDone = 0;
  let peakEquity = 0n;
  let breakerTripped = false;
  // Diagnostic counters (harmless in grading; no I/O here).
  const stats = {
    tradedSeen: 0,
    failTrades: 0,
    failReal: 0,
    failAge: 0,
    failDead: 0,
    failHeld: 0,
    failPending: 0,
    failSize: 0,
    failCash: 0,
    failTickets: 0,
    passed: 0,
    pyramid: 0,
  };

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = batch.slot;
    const traded = new Set<string>();

    // 1. Fold this batch's events into per-mint tracks.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const tr: MintTrack = {
          createdSlot: e.slot,
          trades: 0,
          price: {
            q: BigInt(e.virtual_quote_reserves),
            t: BigInt(e.virtual_token_reserves),
          },
          lastTradeSlot: e.slot,
          realQuote: 0n,
          complete: false,
        };
        tracks.set(e.mint, tr);
      } else if (e.event === 'TradeEvent') {
        let tr = tracks.get(e.mint);
        if (tr === undefined) {
          tr = {
            createdSlot: e.slot,
            trades: 0,
            price: {
              q: BigInt(e.virtual_quote_reserves),
              t: BigInt(e.virtual_token_reserves),
            },
            lastTradeSlot: e.slot,
            realQuote: 0n,
            complete: false,
          };
          tracks.set(e.mint, tr);
        }
        tr.price = {
          q: BigInt(e.virtual_quote_reserves),
          t: BigInt(e.virtual_token_reserves),
        };
        tr.trades += 1;
        tr.lastTradeSlot = e.slot;
        tr.realQuote = BigInt(e.real_quote_reserves);
        traded.add(e.mint);
      } else {
        const tr = tracks.get(e.mint);
        if (tr !== undefined) tr.complete = true;
      }
    }

    // 2. Fold fills: record entry prices, count finished round trips.
    for (const f of batch.fills) {
      if (f.side === 'sell') {
        pendingSell.delete(f.mint);
        dead.add(f.mint);
      }
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        const paid = BigInt(f.quote_lamports);
        const tokens = BigInt(f.token_amount);
        if (paid > 0n && tokens > 0n) {
          const entry: Price = { q: paid, t: tokens };
          const prev = held.get(f.mint);
          if (prev === undefined) {
            held.set(f.mint, { entry, entrySlot: f.slot, peak: entry, added: false });
          } else {
            // Pyramid add-on: re-derive the blended entry from the
            // position's cost basis the harness reports (cost per token,
            // fees included), keep the original entry slot and peak.
            const pos = state.positions.get(f.mint);
            if (pos !== undefined && pos.token_amount > 0n) {
              held.set(f.mint, {
                entry: { q: BigInt(pos.cost_lamports), t: pos.token_amount },
                entrySlot: prev.entrySlot,
                peak: prev.peak,
                added: true,
              });
            }
          }
        }
      } else {
        if (held.has(f.mint)) ticketsDone += 1;
        held.delete(f.mint);
      }
    }

    // 3. Equity circuit breaker: mark positions at the latest known price.
    let equity = state.cash;
    for (const [mint] of held) {
      const pos = state.positions.get(mint);
      const tr = tracks.get(mint);
      if (pos === undefined || tr === undefined) continue;
      // Mark value of the position at the latest known price.
      equity += (pos.token_amount * tr.price.q) / tr.price.t;
    }
    if (equity > peakEquity) peakEquity = equity;
    if (peakEquity > 0n && equity * BPS < peakEquity * (BPS - BigInt(params.breakerBps))) {
      breakerTripped = true;
    }

    // 4. Exits for every held position: trailing stop, max hold, inactivity.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const tr = tracks.get(mint);
      if (pos === undefined || tr === undefined || tr.complete) continue;
      if (pendingSell.has(mint)) continue;
      const price = tr.price;
      if (cmpPrice(price, h.peak) > 0) h.peak = price;
      const trailLine = scalePrice(h.peak, BPS - BigInt(params.trailBps), BPS);
      const trailing = cmpPrice(price, trailLine) <= 0;
      const stale = slot - tr.lastTradeSlot >= params.idleSlots;
      const tooOld = slot - h.entrySlot >= params.maxHoldSlots;
      if (trailing || stale || tooOld) {
        pendingSell.add(mint);
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }

    // 5. Pyramid: one add-on per winner, up 50% with real reserves >= 10 SOL.
    for (const [mint, h] of held) {
      if (h.added) continue;
      const tr = tracks.get(mint);
      if (tr === undefined || tr.complete) continue;
      if (pendingSell.has(mint)) continue;
      const trigger = scalePrice(h.entry, BPS + BigInt(params.pyramidTriggerBps), BPS);
      if (cmpPrice(tr.price, trigger) < 0) continue;
      if (tr.realQuote < params.pyramidMinRealLamports) continue;
      let pendingBuy = false;
      for (const p of state.pending.values()) {
        if (p.order.mint === mint && p.order.side === 'buy') {
          pendingBuy = true;
          break;
        }
      }
      if (pendingBuy) continue;
      const cap = state.maxBuyLamports(mint);
      let size = params.pyramidLamports;
      const sizedCap = (cap * 9n) / 10n;
      if (size > sizedCap) size = sizedCap;
      if (size < 10_000_000n) continue;
      if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
      h.added = true;
      stats.pyramid++;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }

    // 6. New tickets: first time a young curve shows real demand, while the
    // breaker is clear, a position slot is free, and the ticket budget lasts.
    const committed =
      ticketsDone +
      held.size +
      [...state.pending.values()].filter((p) => p.order.side === 'buy').length;
    if (
      !breakerTripped &&
      committed < params.maxTickets &&
      state.committedPositionCount() < state.hello.caps.max_open_positions
    ) {
      const txFee = state.txFeeLamports();
      for (const mint of traded) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) break;
        if (ticketsDone + held.size + orders.filter((o) => o.side === 'buy').length >= params.maxTickets) break;
        const tr = tracks.get(mint);
        if (tr === undefined || tr.complete) continue;
        stats.tradedSeen++;
        if (tr.trades < params.minTrades) { stats.failTrades++; continue; }
        if (tr.realQuote < params.minRealLamports) { stats.failReal++; continue; }
        if (slot - tr.createdSlot > params.maxAgeSlots) { stats.failAge++; continue; }
        if (dead.has(mint)) { stats.failDead++; continue; }
        if (held.has(mint)) { stats.failHeld++; continue; }
        let pendingBuy = false;
        for (const p of state.pending.values()) {
          if (p.order.mint === mint && p.order.side === 'buy') {
            pendingBuy = true;
            break;
          }
        }
        if (pendingBuy) { stats.failPending++; continue; }
        // Size: target size, capped at 90% of the per-mint size cap.
        const cap = state.maxBuyLamports(mint);
        let size = params.buyLamports;
        const sizedCap = (cap * 9n) / 10n;
        if (size > sizedCap) size = sizedCap;
        if (size < 10_000_000n) { stats.failSize++; continue; }
        if (state.freeCashLamports() < size + txFee) { stats.failCash++; continue; }
        stats.passed++;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: size,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    } else if (committed >= params.maxTickets) {
      stats.failTickets++;
    }

    return orders;
  }

  return { onBatch, stats };
}
