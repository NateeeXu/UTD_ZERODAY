// Triage Loop SpacetimeDB module entry. Exports the schema (default), lifecycle hooks, views and
// every reducer. Client reference: docs/SPACETIME_API.md.
import { t } from 'spacetimedb/server';
import spacetimedb, { adjusterRecommendation, assignment, member } from './schema';
import { ensureSingletons, SINGLETON } from './state';

export default spacetimedb;

/** Runs once when the database is first published (or republished with --delete-data). */
export const init = spacetimedb.init(ctx => {
  // The publisher becomes the module owner: only it may seed data.
  if (!ctx.db.config.id.find(SINGLETON))
    ctx.db.config.insert({ id: SINGLETON, owner: ctx.sender, staffPasscode: '', replyPasscode: '', worldStamp: 0n });
  ensureSingletons(ctx);
});

export const onConnect = spacetimedb.clientConnected(_ctx => {});
export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {});

/** The caller's own member row (role + name), if they joined. */
export const myMember = spacetimedb.view({ name: 'my_member', public: true }, t.option(member.rowType), ctx =>
  ctx.db.member.identity.find(ctx.sender) ?? undefined
);

/** The caller's own assignments (adjuster phone task list). */
export const myAssignments = spacetimedb.view(
  { name: 'my_assignments', public: true },
  t.array(assignment.rowType),
  ctx => [...ctx.db.assignment.adjuster.filter(ctx.sender)]
);

/** The caller's own "Next best" list (adjuster phone). */
export const myRecommendations = spacetimedb.view(
  { name: 'my_recommendations', public: true },
  t.array(adjusterRecommendation.rowType),
  ctx => [...ctx.db.adjusterRecommendation.adjuster.filter(ctx.sender)]
);

export * from './reducers/seed';
export * from './reducers/replay';
export * from './reducers/people';
export * from './reducers/disaster';
