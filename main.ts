// Seasoned Dip — entrypoint for "Pump.fun Paper Sprint: Any Bot Can Win".
//
// Runs on Node 22 under the agent-fun/replay/v2 harness (`node main.ts`).
// The strategy lives in strategy.ts; this file only wires it to the harness
// shim in vendor/makefun-bot.ts. No network, no clock, no randomness: every
// decision is a pure function of the batches the harness delivers, so the two
// grading executions produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

// Hand the strategy to the harness: one reply per batch, diagnostics to
// stderr only (stdout carries replies). onDone only reports the outcome.
await runBot({
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
  onDone(state, done) {
    console.error(
      `done: ${done.reason}, cash ${state.cash} lamports, ` +
        `${state.positions.size} positions left open`,
    );
  },
});
