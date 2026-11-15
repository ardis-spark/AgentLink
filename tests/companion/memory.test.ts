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

/** Builds a project with a plan, a decision, an issue, one verified task and a second proposed task. */
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
    toolResponse([{ name: 'propose_arena_task', args: { ...PROPOSAL, milestone_id: 'M-1' } }]),
    textResponse('Plan recorded; first task proposed.'),
  );
  await o.sendMessage(id, 'Start with the health endpoint.').done;

  o.approveTask(id, 'T-1');
  const claim = o.claimDispatch(id, 'T-1', { tabId: 1, tabUrl: 'https://arena.ai/a' });
  o.confirmDispatch(id, 'T-1', claim.dispatchId);
  h.fake.enqueue(
    toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-1', verdict: 'complete', summary: 'Endpoint added and tested.', evidence: ['3 passed, 0 failed'] } }]),
    toolResponse([
      { name: 'update_milestone', args: { milestone_id: 'M-1', status: 'done' } },
      { name: 'propose_arena_task', args: { ...PROPOSAL, title: 'Add the metrics endpoint', instructions: 'Add GET /metrics with request counters.', milestone_id: 'M-2' } },
    ]),
    textResponse('T-1 verified; metrics task proposed.'),
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
      ['T-2', 'proposed'],
    ]);
    expect(onDisk.tasks[0]?.arenaResponse?.text).toBe(REPLY);
    expect(onDisk.tasks[0]?.evaluation?.evidence).toEqual(['3 passed, 0 failed']);
    expect(onDisk.decisions[0]?.summary).toBe('Use the built-in test runner');
    expect(onDisk.issues[0]).toMatchObject({ id: 'I-1', title: 'CI is not configured yet', severity: 'medium', status: 'open' });
    expect(onDisk.session).toMatchObject({ status: 'running', tasksDispatched: 1 });
    expect(onDisk.conversation.length).toBeGreaterThanOrEqual(4);
    expect(onDisk.transcript.length).toBeGreaterThan(onDisk.conversation.length);
    expect(onDisk.timeline.map((e) => e.title)).toEqual(
      expect.arrayContaining(['Project created', 'Task T-1 approved by you', 'Task T-1 sent to Arena', 'Arena replied to T-1']),
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
    h.companion.settings.update({ contextBudgetChars: 20_000 });
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
  it('restores the whole project and comes back paused, never running on its own', async () => {
    const id = await populatedProject();
    const requestsBefore = h.fake.requests.length;

    const next = h.restart();
    await next.orchestrator.whenIdle(id);
    expect(h.fake.requests).toHaveLength(requestsBefore); // nothing was sent to Gemini by starting up

    const view = next.orchestrator.getProject(id);
    expect(view.project).toMatchObject({ name: 'Billing service', currentMilestoneId: 'M-2', currentTaskId: 'T-2' });
    expect(view.project.session).toMatchObject({ status: 'paused', pauseReason: 'restart' });
    expect(view.project.tasks.map((t) => t.status)).toEqual(['completed', 'proposed']);
    expect(view.project.decisions).toHaveLength(1);
    expect(view.project.issues).toHaveLength(1);
    expect(view.conversation.at(-1)?.text).toBe('T-1 verified; metrics task proposed.');
    expect(view.project.timeline.at(-1)?.title).toBe('Session restored after restart');

    // Resuming continues the same conversation with the same history.
    next.orchestrator.controlSession(id, 'resume');
    h.fake.enqueue(textResponse('Welcome back.'));
    await next.orchestrator.sendMessage(id, 'where were we?').done;
    const contents = h.fake.lastGenerate().body.contents;
    expect(contents[0].parts[0].text).toBe('Start with the health endpoint.');
    expect(contents.at(-1).parts[0].text).toContain('where were we?');
    expect(JSON.stringify(contents)).toContain(REPLY);
  });

  it('does not re-send a task that was mid-delivery when the app stopped', async () => {
    const id = await populatedProject();
    const o = h.companion.orchestrator;
    o.approveTask(id, 'T-2');
    o.claimDispatch(id, 'T-2', { tabId: 4, tabUrl: 'https://arena.ai/b' });
    expect(readProjectFile(id).tasks[1]?.status).toBe('dispatching');

    const next = h.restart();
    const task = next.orchestrator.getTask(id, 'T-2');
    expect(task.status).toBe('awaiting_response');
    expect(task.dispatch).toMatchObject({ unconfirmed: true, attempt: 1 });
    expect(task.dispatch?.error).toContain('restarted');

    next.orchestrator.controlSession(id, 'resume');
    let refused: unknown;
    try {
      next.orchestrator.claimDispatch(id, 'T-2');
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(OrchestratorError);
    expect((refused as OrchestratorError).code).toBe('not_dispatchable');

    // If Arena did receive it, the reply can still be captured and evaluated.
    h.fake.enqueue(toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-2', verdict: 'complete', summary: 'Metrics added.', evidence: ['GET /metrics now returns counters'] } }]), textResponse('Verified.'));
    next.orchestrator.recordArenaResponse(id, 'T-2', { dispatchId: task.dispatch!.dispatchId, text: 'GET /metrics now returns counters. Tests pass.', source: 'manual_capture' });
    await next.orchestrator.whenIdle(id);
    expect(next.orchestrator.getTask(id, 'T-2').status).toBe('completed');
  });

  it('keeps waiting for Arena across a restart and evaluates the reply afterwards', async () => {
    const id = await populatedProject();
    const o = h.companion.orchestrator;
    o.approveTask(id, 'T-2');
    const claim = o.claimDispatch(id, 'T-2');
    o.confirmDispatch(id, 'T-2', claim.dispatchId);

    const next = h.restart();
    expect(next.orchestrator.getTask(id, 'T-2')).toMatchObject({ status: 'awaiting_response' });
    expect(next.orchestrator.getTask(id, 'T-2').dispatch).toMatchObject({ dispatchId: claim.dispatchId, unconfirmed: false });
    next.orchestrator.controlSession(id, 'resume');
    h.fake.enqueue(toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-2', verdict: 'failed', summary: 'Arena reported an error.', evidence: ['TypeError: app.get is not a function'] } }]), textResponse('It failed.'));
    next.orchestrator.recordArenaResponse(id, 'T-2', { dispatchId: claim.dispatchId, text: 'It crashed with TypeError: app.get is not a function', source: 'auto' });
    await next.orchestrator.whenIdle(id);
    expect(next.orchestrator.getTask(id, 'T-2').status).toBe('failed');
  });

  it('repairs a reply that was being streamed when the process died', async () => {
    const o = h.companion.orchestrator;
    const id = o.createProject({ name: 'Crash', objective: 'Recover cleanly' }).project.id;
    h.fake.enqueue(textResponse('First half of the answer and then the second half of it.', { pieces: 2, chunkDelayMs: 400 }));
    void o.sendMessage(id, 'explain').done.catch(() => undefined);
    await waitFor(() => (readProjectFile(id).conversation.at(-1)?.status === 'streaming'), 'the streaming reply to be saved');
    expect(readProjectFile(id).activeTurn).not.toBeNull();

    // Simulate a crash: a new process reads whatever was on disk at this moment.
    const next = h.restart();
    const view = next.orchestrator.getProject(id);
    expect(view.conversation.at(-1)).toMatchObject({ role: 'coordinator', status: 'interrupted' });
    expect(view.project.session.status).toBe('paused');
    expect(next.orchestrator.turnState(id).active).toBe(false);
    const stored = next.store.get(id)!;
    expect(stored.activeTurn).toBeNull();
    expect(stored.transcript.at(-1)?.role).toBe('model');

    next.orchestrator.controlSession(id, 'resume');
    h.fake.enqueue(textResponse('Here is the full answer.'));
    await next.orchestrator.sendMessage(id, 'please repeat').done;
    expect(h.fake.lastGenerate().body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user']);
    await o.whenIdle(id);
  });

  it('holds an unevaluated Arena reply across a restart and evaluates it on resume', async () => {
    const id = await populatedProject();
    const o = h.companion.orchestrator;
    o.approveTask(id, 'T-2');
    const claim = o.claimDispatch(id, 'T-2');
    o.confirmDispatch(id, 'T-2', claim.dispatchId);
    o.controlSession(id, 'pause');
    o.recordArenaResponse(id, 'T-2', { dispatchId: claim.dispatchId, text: 'Added /metrics. npm test: 5 passed.', source: 'auto' });

    const next = h.restart();
    expect(next.orchestrator.getTask(id, 'T-2').status).toBe('evaluating');
    h.fake.enqueue(toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-2', verdict: 'complete', summary: 'ok', evidence: ['npm test: 5 passed'] } }]), textResponse('Verified after restart.'));
    next.orchestrator.controlSession(id, 'resume');
    await next.orchestrator.whenIdle(id);
    expect(next.orchestrator.getTask(id, 'T-2').status).toBe('completed');
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
