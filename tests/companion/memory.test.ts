import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '../../src/shared/types.js';
import { OrchestratorError } from '../../src/companion/orchestration/orchestrator.js';
import { textResponse, toolResponse, VALID_KEY } from '../helpers/fakeGemini.js';
import { createHarness, waitFor, type Harness } from '../helpers/harness.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.cleanup();
});

const PROPOSAL = {
  title: 'Add the health endpoint',
  instructions: 'Add GET /health returning {"ok":true} and a test for it.',
  context: 'Express app in src/server.ts.',
  acceptance_criteria: ['`npm test` passes'],
  rationale: 'Smallest verifiable first step.',
};
const REPLY = 'Added GET /health in src/server.ts. Ran npm test: 3 passed, 0 failed.';

function readProjectFile(id: string): Project {
  return JSON.parse(readFileSync(join(h.dataDir, 'projects', `${id}.json`), 'utf8')) as Project;
}

/** Builds a project with a plan, a decision, an issue, one verified task and a second task queued for Arena. */
async function populatedProject(): Promise<string> {
  const o = h.companion.orchestrator;
  const id = o.createProject({
    name: 'Billing service',
    objective: 'Expose a health endpoint and a metrics endpoint',
    instructions: 'Prefer small pull-request-sized steps.',
    constraints: ['Keep Node 20 compatibility'],
  }).project.id;

  h.fake.enqueue(
    toolResponse([
      { name: 'set_plan', args: { milestones: [{ title: 'Health endpoint' }, { title: 'Metrics endpoint' }] } },
      { name: 'record_decision', args: { summary: 'Use the built-in test runner', rationale: 'No new dependencies.' } },
      { name: 'record_issue', args: { title: 'CI is not configured yet', details: 'There is no workflow file, so nothing runs on push.', severity: 'medium' } },
    ]),
    toolResponse([{ name: 'dispatch_arena_task', args: { ...PROPOSAL, milestone_id: 'M-1' } }]),
    textResponse('Plan recorded; first task sent.'),
  );
  await o.sendMessage(id, 'Start with the health endpoint.').done;

  const claim = o.claimDispatch(id, 'T-1', { tabId: 1, tabUrl: 'https://arena.ai/a' });
  o.confirmDispatch(id, 'T-1', claim.dispatchId);
  h.fake.enqueue(
    toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-1', verdict: 'complete', summary: 'Endpoint added and tested.', evidence: ['3 passed, 0 failed'] } }]),
    toolResponse([
      { name: 'update_milestone', args: { milestone_id: 'M-1', status: 'done' } },
      { name: 'dispatch_arena_task', args: { ...PROPOSAL, title: 'Add the metrics endpoint', instructions: 'Add GET /metrics with request counters.', milestone_id: 'M-2' } },
    ]),
    textResponse('T-1 verified; metrics task sent.'),
  );
  o.recordArenaResponse(id, 'T-1', { dispatchId: claim.dispatchId, text: REPLY, source: 'auto' });
  await o.whenIdle(id);
  return id;
}

describe('persistent project memory', () => {
  it('writes every part of the project to disk as it changes', async () => {
    const id = await populatedProject();
    const onDisk = readProjectFile(id);

    expect(onDisk).toMatchObject({
      schemaVersion: 1,
      name: 'Billing service',
      objective: 'Expose a health endpoint and a metrics endpoint',
      instructions: 'Prefer small pull-request-sized steps.',
      constraints: ['Keep Node 20 compatibility'],
      currentMilestoneId: 'M-2',
      currentTaskId: 'T-2',
    });
    expect(onDisk.milestones.map((m) => [m.id, m.title, m.status])).toEqual([
      ['M-1', 'Health endpoint', 'done'],
      ['M-2', 'Metrics endpoint', 'in_progress'],
    ]);
    expect(onDisk.tasks.map((t) => [t.id, t.status])).toEqual([
      ['T-1', 'completed'],
      ['T-2', 'queued'],
    ]);
    expect(onDisk.tasks[0]?.arenaResponse?.text).toBe(REPLY);
    expect(onDisk.tasks[0]?.evaluation?.evidence).toEqual(['3 passed, 0 failed']);
    expect(onDisk.decisions[0]?.summary).toBe('Use the built-in test runner');
    expect(onDisk.issues[0]).toMatchObject({ id: 'I-1', title: 'CI is not configured yet', severity: 'medium', status: 'open' });
    expect(onDisk.session).toMatchObject({ status: 'running', tasksDispatched: 1 });
    expect(onDisk.conversation.length).toBeGreaterThanOrEqual(4);
    expect(onDisk.transcript.length).toBeGreaterThan(onDisk.conversation.length);
    expect(onDisk.timeline.map((e) => e.title)).toEqual(
      expect.arrayContaining(['Project created', 'Session started', 'Task T-1 sent to Arena', 'Arena replied to T-1']),
    );
  });

  it('keeps project files private and never writes the API key into them', async () => {
    const id = await populatedProject();
    const file = join(h.dataDir, 'projects', `${id}.json`);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(h.dataDir, 'projects')).mode & 0o777).toBe(0o700);
    }
    for (const name of readdirSync(join(h.dataDir, 'projects'))) {
      expect(readFileSync(join(h.dataDir, 'projects', name), 'utf8')).not.toContain(VALID_KEY);
    }
    expect(readFileSync(join(h.dataDir, 'state.json'), 'utf8')).not.toContain(VALID_KEY);
    expect(h.logs.join('\n')).not.toContain(VALID_KEY);
  });

  it('keeps long-term memory separate from the conversation: memory survives compaction', async () => {
    const id = await populatedProject();
    const o = h.companion.orchestrator;
    h.companion.settings.update({ contextBudgetChars: 24_000 });
    const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(120); // ~5.4k chars

    for (let i = 0; i < 4; i += 1) {
      h.fake.enqueue(textResponse(`Noted part ${i}.`));
      await o.sendMessage(id, `Background part ${i}: ${filler}`).done;
    }
    const before = readProjectFile(id);
    expect(before.contextSummary).toBe('');

    // The next turn exceeds the budget: older turns are summarised by Gemini, then the turn itself runs.
    h.fake.enqueue(textResponse('SUMMARY: user supplied background parts 0-3; T-1 verified.'), textResponse('Continuing with T-2.'));
    await o.sendMessage(id, `Background part 4: ${filler}`).done;

    const [summaryRequest, turnRequest] = h.fake.generateRequests.slice(-2);
    expect(summaryRequest!.body.tools).toBeUndefined();
    expect(JSON.stringify(summaryRequest!.body.contents)).toContain('Background part 0');

    const after = readProjectFile(id);
    expect(after.contextSummary).toBe('SUMMARY: user supplied background parts 0-3; T-1 verified.');
    expect(after.transcript.length).toBeLessThan(before.transcript.length);
    expect(after.transcript[0]?.role).toBe('user');
    // The visible conversation is never trimmed, and structured memory is untouched.
    expect(after.conversation.length).toBe(before.conversation.length + 2);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.milestones).toEqual(before.milestones);
    expect(after.decisions).toEqual(before.decisions);
    expect(after.timeline.some((e) => e.title === 'Conversation context compacted')).toBe(true);

    // Gemini still gets the full project memory plus the summary of what was dropped.
    const system = turnRequest!.body.systemInstruction.parts[0].text as string;
    expect(system).toContain('SUMMARY: user supplied background parts 0-3; T-1 verified.');
    expect(system).toContain('Use the built-in test runner');
    expect(system).toContain('CI is not configured yet');
    expect(system).toContain('T-1');
    expect(JSON.stringify(turnRequest!.body.contents)).not.toContain('Background part 0');
    expect(JSON.stringify(turnRequest!.body.contents)).toContain('Background part 4');
  });

  it('never splits a function call from its response when compacting', async () => {
    const id = await populatedProject();
    h.companion.settings.update({ contextBudgetChars: 20_000 });
    const filler = 'lorem ipsum dolor sit amet '.repeat(400);
    h.fake.enqueue(textResponse('ok'));
    await h.companion.orchestrator.sendMessage(id, filler).done;
    h.fake.enqueue(textResponse('summary of older turns'), textResponse('ok again'));
    await h.companion.orchestrator.sendMessage(id, filler).done;

    const contents = h.fake.lastGenerate().body.contents as { role: string; parts: Record<string, unknown>[] }[];
    expect(contents[0]?.role).toBe('user');
    expect(contents[0]?.parts.some((p) => 'functionResponse' in p)).toBe(false);
    const calls = contents.flatMap((c) => c.parts).filter((p) => 'functionCall' in p).length;
    const responses = contents.flatMap((c) => c.parts).filter((p) => 'functionResponse' in p).length;
    expect(calls).toBe(responses);
  });

  it('keeps several projects apart and remembers which one is active', async () => {
    const o = h.companion.orchestrator;
    const a = o.createProject({ name: 'Alpha', objective: 'First objective' }).project.id;
    const b = o.createProject({ name: 'Beta', objective: 'Second objective' }).project.id;
    expect(o.listProjects().activeProjectId).toBe(b);
    h.fake.enqueue(textResponse('Hello Alpha.'));
    await o.sendMessage(a, 'hi from alpha').done;
    expect(o.getProject(b).conversation).toHaveLength(0);
    o.activateProject(a);

    const next = h.restart();
    const list = next.orchestrator.listProjects();
    expect(list.activeProjectId).toBe(a);
    expect(list.projects.map((p) => p.name).sort()).toEqual(['Alpha', 'Beta']);

    next.orchestrator.deleteProject(a);
    expect(existsSync(join(h.dataDir, 'projects', `${a}.json`))).toBe(false);
    expect(next.orchestrator.listProjects().activeProjectId).toBe(b);
  });

  it('survives a damaged project file without losing the others', async () => {
    const o = h.companion.orchestrator;
    const good = o.createProject({ name: 'Good', objective: 'Stay readable' }).project.id;
    const bad = o.createProject({ name: 'Bad', objective: 'Get corrupted' }).project.id;
    writeFileSync(join(h.dataDir, 'projects', `${bad}.json`), '{ "this is": not json');

    const next = h.restart();
    expect(next.orchestrator.listProjects().projects.map((p) => p.id)).toEqual([good]);
    // The damaged file is kept for manual recovery rather than being deleted.
    expect(readdirSync(join(h.dataDir, 'projects')).some((n) => n.startsWith(bad))).toBe(true);
  });
});

describe('restart recovery', () => {
  it('restores the whole project and carries on by itself, without asking Gemini anything it already knows', async () => {
    const id = await populatedProject();
    const requestsBefore = h.fake.requests.length;

    const next = h.restart();
    await next.orchestrator.whenIdle(id);
    // T-2 is queued for Arena, so the next move is the extension's: nothing needs to be asked of Gemini.
    expect(h.fake.requests).toHaveLength(requestsBefore);

    const view = next.orchestrator.getProject(id);
    expect(view.project).toMatchObject({ name: 'Billing service', currentMilestoneId: 'M-2', currentTaskId: 'T-2' });
    expect(view.project.session).toMatchObject({ status: 'running', blocker: null });
    expect(view.project.tasks.map((t) => t.status)).toEqual(['completed', 'queued']);
    expect(view.project.decisions).toHaveLength(1);
    expect(view.project.issues).toHaveLength(1);
    expect(view.conversation.at(-1)?.text).toBe('T-1 verified; metrics task sent.');
    expect(view.project.timeline.at(-1)?.title).toBe('Session resumed after a restart');
    // The queued task is offered to the extension at once.
    expect(next.orchestrator.relayWork().items.map((i) => [i.task.id, i.task.status])).toEqual([['T-2', 'queued']]);

    // The same conversation continues with the same history.
    h.fake.enqueue(textResponse('Welcome back.'));
    await next.orchestrator.sendMessage(id, 'where were we?').done;
    const contents = h.fake.lastGenerate().body.contents;
    expect(contents[0].parts[0].text).toBe('Start with the health endpoint.');
    expect(contents.at(-1).parts[0].text).toContain('where were we?');
    expect(JSON.stringify(contents)).toContain(REPLY);
  });

  it('picks the work up again after a restart when nothing was in motion', async () => {
    const o = h.companion.orchestrator;
    h.fake.enqueue(toolResponse([{ name: 'set_plan', args: { milestones: [{ title: 'Health endpoint' }] } }]), { kind: 'hang' });
    const id = o.createProject({ name: 'Billing service', objective: 'Expose a health endpoint', start: true }).project.id;
    await waitFor(() => readProjectFile(id).milestones.length === 1 && h.fake.generateRequests.length === 2, 'the plan to be saved and the turn to go on');

    // The process dies in the middle of a turn; the new one continues without being told to.
    h.fake.enqueue(toolResponse([{ name: 'dispatch_arena_task', args: PROPOSAL }]), textResponse('Sent.'));
    const next = h.restart();
    await next.orchestrator.whenIdle(id);
    const view = next.orchestrator.getProject(id);
    expect(view.project.session.status).toBe('running');
    expect(view.project.tasks.map((t) => [t.id, t.status])).toEqual([['T-1', 'queued']]);
    expect(view.project.milestones).toHaveLength(1);
  });

  it('does not re-send a task that was mid-delivery when the app stopped', async () => {
    const id = await populatedProject();
    const o = h.companion.orchestrator;
    o.claimDispatch(id, 'T-2', { tabId: 4, tabUrl: 'https://arena.ai/b' });
    expect(readProjectFile(id).tasks[1]?.status).toBe('dispatching');

    const next = h.restart();
    const task = next.orchestrator.getTask(id, 'T-2');
    expect(task.status).toBe('awaiting_response');
    expect(task.dispatch).toMatchObject({ unconfirmed: true, attempt: 1 });
    expect(task.dispatch?.error).toContain('restarted');

    // It is offered to the extension for checking against the page, not for sending again.
    expect(next.orchestrator.relayWork().items.map((i) => [i.task.id, i.task.status])).toEqual([['T-2', 'awaiting_response']]);
    let refused: unknown;
    try {
      next.orchestrator.claimDispatch(id, 'T-2');
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(OrchestratorError);
    expect((refused as OrchestratorError).code).toBe('not_dispatchable');

    // If Arena did receive it, the reply is collected and evaluated as usual.
    h.fake.enqueue(
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-2', verdict: 'complete', summary: 'Metrics added.', evidence: ['GET /metrics now returns counters'] } }]),
      toolResponse([
        { name: 'update_milestone', args: { milestone_id: 'M-2', status: 'done' } },
        { name: 'mark_objective_complete', args: { summary: 'Both endpoints exist and are tested.' } },
      ]),
      textResponse('Verified.'),
    );
    next.orchestrator.recordArenaResponse(id, 'T-2', { dispatchId: task.dispatch!.dispatchId, text: 'GET /metrics now returns counters. Tests pass.', source: 'auto' });
    await next.orchestrator.whenIdle(id);
    expect(next.orchestrator.getTask(id, 'T-2').status).toBe('completed');
    expect(next.orchestrator.getProject(id).project.session.status).toBe('completed');
  });

  it('re-sends a task that was mid-delivery only after the page showed it never arrived', async () => {
    const id = await populatedProject();
    h.companion.orchestrator.claimDispatch(id, 'T-2', { tabId: 4, tabUrl: 'https://arena.ai/b' });
    const next = h.restart();
    const task = next.orchestrator.getTask(id, 'T-2');
    next.orchestrator.resetDispatch(id, 'T-2', { dispatchId: task.dispatch!.dispatchId, reason: 'The task is not in the Arena conversation.' });
    expect(next.orchestrator.getTask(id, 'T-2').status).toBe('queued');
    expect(next.orchestrator.claimDispatch(id, 'T-2').task.dispatch?.attempt).toBe(2);
  });

  it('keeps waiting for Arena across a restart and evaluates the reply afterwards', async () => {
    const id = await populatedProject();
    const o = h.companion.orchestrator;
    const claim = o.claimDispatch(id, 'T-2');
    o.confirmDispatch(id, 'T-2', claim.dispatchId);

    const next = h.restart();
    expect(next.orchestrator.getTask(id, 'T-2')).toMatchObject({ status: 'awaiting_response' });
    expect(next.orchestrator.getTask(id, 'T-2').dispatch).toMatchObject({ dispatchId: claim.dispatchId, unconfirmed: false });
    h.fake.enqueue(
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-2', verdict: 'failed', summary: 'Arena reported an error.', evidence: ['TypeError: app.get is not a function'] } }]),
      toolResponse([{ name: 'dispatch_arena_task', args: { ...PROPOSAL, title: 'Fix the metrics endpoint', instructions: 'The previous attempt crashed with a TypeError; fix it.' } }]),
      textResponse('It failed; a fix is on its way.'),
    );
    next.orchestrator.recordArenaResponse(id, 'T-2', { dispatchId: claim.dispatchId, text: 'It crashed with TypeError: app.get is not a function', source: 'auto' });
    await next.orchestrator.whenIdle(id);
    expect(next.orchestrator.getTask(id, 'T-2').status).toBe('failed');
    expect(next.orchestrator.getTask(id, 'T-3').status).toBe('queued');
  });

  it('repairs a reply that was being streamed when the process died', async () => {
    const o = h.companion.orchestrator;
    const id = o.createProject({ name: 'Crash', objective: 'Recover cleanly' }).project.id;
    h.fake.enqueue(textResponse('First half of the answer and then the second half of it.', { pieces: 2, chunkDelayMs: 400 }));
    void o.sendMessage(id, 'explain').done.catch(() => undefined);
    await waitFor(() => (readProjectFile(id).conversation.at(-1)?.status === 'streaming'), 'the streaming reply to be saved');
    expect(readProjectFile(id).activeTurn).not.toBeNull();

    // Simulate a crash: a new process reads whatever was on disk at this moment.
    h.fake.enqueue(toolResponse([{ name: 'dispatch_arena_task', args: PROPOSAL }]), textResponse('Here is the task.'));
    const next = h.restart();
    const repaired = next.orchestrator.getProject(id).conversation.find((e) => e.role === 'coordinator');
    expect(repaired).toMatchObject({ role: 'coordinator', status: 'interrupted' });
    await next.orchestrator.whenIdle(id);

    // The interrupted reply is closed off in the history, and the session went straight on.
    const sent = h.fake.lastGenerate().body.contents as { role: string; parts: { text?: string }[] }[];
    expect(sent.slice(0, 3).map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(sent[2]?.parts[0]?.text).toContain('restarted');
    const view = next.orchestrator.getProject(id);
    expect(view.project.session.status).toBe('running');
    expect(view.project.tasks.map((t) => t.status)).toEqual(['queued']);
    expect(next.store.get(id)!.activeTurn).toBeNull();
  });

  it('holds an unevaluated Arena reply across a restart and evaluates it on resume', async () => {
    const id = await populatedProject();
    const o = h.companion.orchestrator;
    const claim = o.claimDispatch(id, 'T-2');
    o.confirmDispatch(id, 'T-2', claim.dispatchId);
    o.controlSession(id, 'pause');
    o.recordArenaResponse(id, 'T-2', { dispatchId: claim.dispatchId, text: 'Added /metrics. npm test: 5 passed.', source: 'auto' });

    const next = h.restart();
    expect(next.orchestrator.getTask(id, 'T-2').status).toBe('evaluating');
    h.fake.enqueue(
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-2', verdict: 'complete', summary: 'ok', evidence: ['npm test: 5 passed'] } }]),
      toolResponse([
        { name: 'update_milestone', args: { milestone_id: 'M-2', status: 'done' } },
        { name: 'mark_objective_complete', args: { summary: 'Both endpoints exist and are tested.' } },
      ]),
      textResponse('Verified after restart.'),
    );
    next.orchestrator.controlSession(id, 'resume');
    await next.orchestrator.whenIdle(id);
    expect(next.orchestrator.getTask(id, 'T-2').status).toBe('completed');
  });

  it('carries on with a project saved by the version that waited for approval: its sent task is followed, its proposed task goes out', async () => {
    const id = await populatedProject();
    const o = h.companion.orchestrator;
    const claim = o.claimDispatch(id, 'T-2', { tabId: 4, tabUrl: 'https://arena.ai/b' });
    o.confirmDispatch(id, 'T-2', claim.dispatchId);

    // Rewrite the file the way version 1.0.0 would have left it: T-2 approved by the user and sent to Arena,
    // the session paused by a restart, and none of the fields the autonomous loop added.
    const file = join(h.dataDir, 'projects', `${id}.json`);
    const old = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    old.session = { status: 'paused', startedAt: old.session.startedAt, updatedAt: old.session.updatedAt, pauseReason: 'restart', tasksDispatched: 2, note: 'Paused after a restart.' };
    delete old.pendingNotices;
    for (const task of old.tasks) {
      delete task.relay;
      delete task.evaluationAttempts;
      delete task.closedReason;
      if (task.dispatch) delete task.dispatch.ref;
      if (task.arenaResponse) delete task.arenaResponse.completion;
      Object.assign(task, { editedByUser: false, approvedAt: task.createdAt, rejection: null });
    }
    writeFileSync(file, JSON.stringify(old));

    const requestsBefore = h.fake.generateRequests.length;
    const next = h.restart();
    const view = next.orchestrator.getProject(id).project;
    expect(view.session).toMatchObject({ status: 'running', blocker: null, idleTurns: 0 });
    expect(view.session).not.toHaveProperty('pauseReason');
    const task = next.orchestrator.getTask(id, 'T-2');
    expect(task).toMatchObject({ status: 'awaiting_response', relay: null, evaluationAttempts: 0, closedReason: null });
    expect(task.dispatch).toMatchObject({ dispatchId: claim.dispatchId, ref: '', unconfirmed: false });
    expect(task).not.toHaveProperty('approvedAt');
    expect(next.orchestrator.getTask(id, 'T-1').arenaResponse?.completion).toBe('quiet');
    // The task Arena already has is handed to the extension to collect its report; Gemini is not asked anything.
    expect(next.orchestrator.relayWork().items.map((i) => [i.task.id, i.task.status])).toEqual([['T-2', 'awaiting_response']]);
    expect(h.fake.generateRequests).toHaveLength(requestsBefore);

    // The report that was waiting in the Arena tab is reviewed, and the next task follows without anyone approving it.
    h.fake.enqueue(
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-2', verdict: 'complete', summary: 'Metrics added.', evidence: ['GET /metrics now returns counters'] } }]),
      toolResponse([{ name: 'dispatch_arena_task', args: { ...PROPOSAL, title: 'Document both endpoints', instructions: 'Describe GET /health and GET /metrics in README.md.' } }]),
      textResponse('T-2 is verified. T-3 is on its way.'),
    );
    next.orchestrator.recordArenaResponse(id, 'T-2', { dispatchId: claim.dispatchId, text: 'GET /metrics now returns counters. Tests pass.', source: 'auto', completion: 'quiet' });
    await next.orchestrator.whenIdle(id);
    expect(next.orchestrator.getTask(id, 'T-2').status).toBe('completed');
    expect(next.orchestrator.getTask(id, 'T-3').status).toBe('queued');
    expect(next.orchestrator.relayWork().items.map((i) => i.task.id)).toEqual(['T-3']);

    // A task that the old version had only proposed is queued for Arena as it is.
    const legacy = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    legacy.tasks[2].status = 'proposed';
    writeFileSync(file, JSON.stringify(legacy));
    const again = h.restart();
    expect(again.orchestrator.getTask(id, 'T-3').status).toBe('queued');
    expect(again.orchestrator.claimDispatch(id, 'T-3').prompt).toContain('Task T-3: Document both endpoints');
  });

  it('keeps the pairing token, settings and saved key across restarts', async () => {
    h.companion.settings.update({ model: 'gemini-4-argon', maxTasksPerSession: 7 });
    const next = h.restart();
    expect(next.token).toBe(h.companion.token);
    expect(next.credentials.resolve()?.apiKey).toBe(VALID_KEY);
    // The harness re-applies only its fast timeouts; user choices persist.
    expect(next.settings.get()).toMatchObject({ model: 'gemini-4-argon', maxTasksPerSession: 7 });
    // A restored key is not reported as connected until it has actually been checked.
    expect(next.gemini.status()).toMatchObject({ state: 'unverified', keyConfigured: true });
  });
});
