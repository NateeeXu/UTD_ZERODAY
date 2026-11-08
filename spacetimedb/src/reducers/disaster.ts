// The manager's "New random disaster" button. Generating and loading needs local data files and the
// owner token, so a reducer can only queue the request; scripts/disaster-worker.ts does the work.
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { memberOf, requireManager, requireOwner } from '../state';

const NEXT: Record<string, readonly string[]> = {
  queued: ['running', 'failed'],
  running: ['done', 'failed'],
};

export const requestNewDisaster = spacetimedb.reducer(
  { name: 'request_new_disaster' },
  { region: t.string() },
  (ctx, { region }) => {
    requireManager(ctx);
    if (region !== 'tx' && region !== 'ca') throw new SenderError("region must be 'tx' or 'ca'");
    const rows = [...ctx.db.disasterRequest.iter()];
    if (rows.some(r => r.status in NEXT)) throw new SenderError('a new disaster is already being loaded');
    for (const r of rows) ctx.db.disasterRequest.id.delete(r.id);
    ctx.db.disasterRequest.insert({
      id: 0n,
      region,
      status: 'queued',
      error: '',
      requestedBy: memberOf(ctx)?.name ?? 'Owner',
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }
);

/** Withdraw a request the worker has not started, for example when the worker is not running. */
export const cancelDisasterRequest = spacetimedb.reducer({ name: 'cancel_disaster_request' }, ctx => {
  requireManager(ctx);
  for (const r of ctx.db.disasterRequest.iter()) {
    if (r.status === 'running') throw new SenderError('this disaster is already loading');
    if (r.status === 'queued') ctx.db.disasterRequest.id.delete(r.id);
  }
});

/** Worker only. Moving to 'running' fails if the request was cancelled first, so a cancelled request never loads. */
export const updateDisasterRequest = spacetimedb.reducer(
  { name: 'update_disaster_request' },
  { id: t.u64(), status: t.string(), error: t.string() },
  (ctx, { id, status, error }) => {
    requireOwner(ctx);
    const row = ctx.db.disasterRequest.id.find(id);
    if (!row) throw new SenderError('unknown disaster request');
    if (!NEXT[row.status]?.includes(status)) throw new SenderError(`cannot go from ${row.status} to ${status}`);
    ctx.db.disasterRequest.id.update({ ...row, status, error: error.slice(0, 200), updatedAt: ctx.timestamp });
  }
);
