[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/vedreal/pump-fun-paper-01/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/vedreal/pump-fun-paper-01/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Seasoned Dip — Pump.fun Paper Sprint

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. It paper-trades pump.fun bonding curves on a 6-hour replay; highest net PnL wins.

## Strategy

Every directional signal tested on the dev window has negative expectancy
after the harness's 2-slot latency and fees: dip-buying ends about −4% per
trade, early momentum about −8%. The market is negative-sum for a trader,
and the bounty is winner-takes-all with a single $2 place that only pays a
net PnL above zero — so the right play is NOT to maximise volume. It is to
take the minimum qualifying volume (20 round trips), on the highest-upside
setups, and let variance do the work: a few small losers are survivable, one
runner pays for all of them.

So this bot buys exactly 20 tickets, then stops trading and holds cash:

- **Entry:** the first time a curve younger than ~30 minutes has at least 2
  trades and at least 2 SOL of real reserves. Size 0.20 SOL, capped at 90%
  of the harness per-mint size cap (1% of real reserves). One entry per mint,
  ever.
- **Pyramid:** one add-on per winner — when a held coin is up 50% and its
  real reserves reach 10 SOL, add 0.18 SOL. Winners get the size.
- **Exits:** no take profit. A 15% trailing stop from the post-entry peak
  (which is also the stop loss while the price never rises), a 60-minute max
  hold, and an exit when the mint goes quiet for ~15 minutes.
- **Risk:** at most 5 open positions; an equity circuit breaker halts new
  buys after a 25% drawdown from peak equity. No shorts, no leverage.

Everything is deterministic — no clock, no randomness, no environment reads —
so the two grading executions produce byte-identical action logs.

## Layout

- `main.ts` — entrypoint (`node main.ts` under agent-fun/replay/v2).
- `strategy.ts` — the Seasoned Dip strategy.
- `vendor/makefun-bot.ts` — the harness shim (kit SDK, unmodified).
- `tools/sim.ts` — local research simulator (independent re-implementation
  of the replay's market model from the kit; not part of the graded bot).

## Local backtest

```sh
node tools/sim.ts --kit <path to unpacked kit>
```

## License

MIT — see [LICENSE](LICENSE).
