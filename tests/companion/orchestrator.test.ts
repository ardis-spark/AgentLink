import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompanionEvent } from '../../src/shared/api.js';
import { renderArenaPrompt } from '../../src/shared/arenaPrompt.js';
import type { Companion } from '../../src/companion/app.js';
import { OrchestratorError } from '../../src/companion/orchestration/orchestrator.js';
import { errorBody, textResponse, toolResponse, VALID_KEY } from '../helpers/fakeGemini.js';
import { createHarness, waitFor, type Harness } from '../helpers/harness.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.cleanup();
});

const ARENA_REPLY = [
  'Done. I created the login form in src/components/LoginForm.tsx and wired it into src/App.tsx.',
  'Ran `npm test`: 14 passed, 0 failed.',
  'Ran `npm run build`: build completed without errors.',
].join('\n');

const PROPOSAL = {
  title: 'Implement the login form',
  instructions: 'Create a LoginForm React component with email and password fields and client-side validation.',
  context: 'The repository is a Vite + React + TypeScript app. Components live in src/components.',
  acceptance_criteria: ['`npm test` passes', '`npm run build` succeeds'],
  rationale: 'The login form is the first milestone and unblocks the session work.',
};

function newProject(c: Companion = h.companion): string {
  return c.orchestrator.createProject({ name: 'Demo app', objective: 'Ship a working login flow', constraints: ['Do not add new runtime dependencies'] }).project.id;
}

async function say(id: string, text: string, c: Companion = h.companion): Promise<void> {
  await c.orchestrator.sendMessage(id, text).done;
}

function project(id: string, c: Companion = h.companion) {
  return c.orchestrator.getProject(id);
}

function rejection(fn: () => unknown): OrchestratorError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OrchestratorError);
    return error as OrchestratorError;
  }
  throw new Error('Expected the operation to be refused.');
}

/** Drives a project to the point where a task has been proposed. */
async function proposeTask(id: string, overrides: Record<string, unknown> = {}): Promise<string> {
  h.fake.enqueue(toolResponse([{ name: 'propose_arena_task', args: { ...PROPOSAL, ...overrides } }]), textResponse('I have proposed the first task.'));
  await say(id, 'Please get the login form built.');
  const open = project(id).project.currentTaskId;
  if (!open) throw new Error('No task was proposed.');
  return open;
}

/** Approves and "delivers" a task the way the extension does. */
function deliver(id: string, taskId: string): string {
  const o = h.companion.orchestrator;
  o.approveTask(id, taskId);
  const claim = o.claimDispatch(id, taskId, { tabId: 7, tabUrl: 'https://arena.ai/agent/abc' });
  o.confirmDispatch(id, taskId, claim.dispatchId);
  return claim.dispatchId;
}

describe('multi-turn conversation and persistent history', () => {
  it('streams the reply, stores the turn, and sends prior turns back on the next request', async () => {
    const id = newProject();
    const events: CompanionEvent[] = [];
    h.companion.bus.subscribe((e) => events.push(e));

    h.fake.enqueue(textResponse('Understood. What stack does the app use?', { pieces: 4 }));
    await say(id, 'I want a login flow.');

    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e.type === 'delta' ? e.text : ''));
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('Understood. What stack does the app use?');

    let view = project(id);
    expect(view.conversation.map((e) => [e.role, e.status, e.text])).toEqual([
      ['user', 'complete', 'I want a login flow.'],
      ['coordinator', 'complete', 'Understood. What stack does the app use?'],
    ]);
    expect(view.conversation[1]?.usage).toEqual({ promptTokens: 100, outputTokens: 25, totalTokens: 125 });
    expect(view.project.session.status).toBe('running');

    h.fake.enqueue(textResponse('React it is.'));
    await say(id, 'React with TypeScript.');
    const second = h.fake.lastGenerate().body;
    expect(second.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
    expect(second.contents[0].parts[0].text).toBe('I want a login flow.');
    expect(second.contents[1].parts.map((p: any) => p.text).join('')).toBe('Understood. What stack does the app use?');
    // The model's own parts, including the thought signature, are replayed unchanged.
    expect(second.contents[1].parts.some((p: any) => p.thoughtSignature === 'sig-text')).toBe(true);
    expect(second.contents[2].parts[0].text).toBe('React with TypeScript.');

    view = project(id);
    expect(view.conversation).toHaveLength(4);
  });

  it('gives Gemini the coordinator role and the current project memory on every request', async () => {
    const id = newProject();
    h.fake.enqueue(textResponse('ok'));
    await say(id, 'hi');
    const system = h.fake.lastGenerate().body.systemInstruction.parts[0].text as string;
    expect(system).toContain('You are the AgentLink Coordinator');
    expect(system).toContain('# PROJECT MEMORY');
    expect(system).toContain('Project: Demo app');
    expect(system).toContain('Objective: Ship a working login flow');
    expect(system).toContain('Do not add new runtime dependencies');
    const names = h.fake.lastGenerate().body.tools[0].functionDeclarations.map((f: any) => f.name);
    expect(names).toEqual(expect.arrayContaining(['set_plan', 'propose_arena_task', 'evaluate_arena_result', 'record_decision', 'record_issue', 'mark_objective_complete']));
  });

  it('refuses a second message while the coordinator is still working', async () => {
    const id = newProject();
    h.fake.enqueue(textResponse('slow answer', { pieces: 3, chunkDelayMs: 40 }));
    const first = h.companion.orchestrator.sendMessage(id, 'one');
    expect(rejection(() => h.companion.orchestrator.sendMessage(id, 'two')).code).toBe('coordinator_busy');
    await first.done;
    expect(h.fake.generateRequests).toHaveLength(1);
  });

  it('records a failed request as an error entry and keeps the history valid for the next turn', async () => {
    const id = newProject();
    h.fake.enqueue({ kind: 'error', status: 400, body: errorBody(400, 'INVALID_ARGUMENT', 'Something was wrong.') });
    await say(id, 'first try');
    const failed = project(id).conversation.at(-1);
    expect(failed).toMatchObject({ role: 'coordinator', status: 'error' });
    expect(failed?.error).toContain('Something was wrong.');

    h.fake.enqueue(textResponse('Second time lucky.'));
    await say(id, 'second try');
    const contents = h.fake.lastGenerate().body.contents;
    expect(contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
    expect(project(id).conversation.at(-1)?.text).toBe('Second time lucky.');
  });

  it('refuses to start without an API key instead of pretending to work', async () => {
    const bare = await createHarness({ saveKey: null });
    try {
      const id = bare.companion.orchestrator.createProject({ name: 'P', objective: 'O' }).project.id;
      expect(rejection(() => bare.companion.orchestrator.sendMessage(id, 'hello')).code).toBe('gemini_not_configured');
      expect(bare.fake.requests).toHaveLength(0);
    } finally {
      await bare.cleanup();
    }
  });

  it('never stores the API key if the user pastes it into the conversation', async () => {
    const id = newProject();
    h.fake.enqueue(textResponse('Do not share keys.'));
    await say(id, `my key is ${VALID_KEY} ok?`);
    expect(JSON.stringify(h.companion.store.get(id))).not.toContain(VALID_KEY);
    expect(JSON.stringify(h.fake.lastGenerate().body)).not.toContain(VALID_KEY);
  });
});

describe('task generation and user approval', () => {
  it('turns a Gemini proposal into a structured task that waits for approval', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const view = project(id);
    const task = view.project.tasks[0];
    expect(task).toMatchObject({
      id: 'T-1',
      status: 'proposed',
      title: PROPOSAL.title,
      instructions: PROPOSAL.instructions,
      context: PROPOSAL.context,
      acceptanceCriteria: PROPOSAL.acceptance_criteria,
      rationale: PROPOSAL.rationale,
      dispatch: null,
      arenaResponse: null,
    });
    expect(taskId).toBe('T-1');
    expect(view.conversation.at(-1)?.actions).toEqual([{ name: 'propose_arena_task', ok: true, summary: 'Proposed T-1: Implement the login form' }]);
    expect(view.conversation.at(-1)?.text).toBe('I have proposed the first task.');

    // The tool result went back to Gemini with the id of the call it answers.
    const followUp = h.fake.lastGenerate().body.contents;
    const call = followUp.at(-2).parts.find((p: any) => p.functionCall);
    const response = followUp.at(-1).parts[0].functionResponse;
    expect(response.id).toBe(call.functionCall.id);
    expect(response.name).toBe('propose_arena_task');
    expect(response.response).toMatchObject({ ok: true, task_id: 'T-1', status: 'proposed' });
    expect(call.thoughtSignature).toBeTruthy();
  });

  it('does not hand anything to Arena before the user approves', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const refused = rejection(() => h.companion.orchestrator.claimDispatch(id, taskId));
    expect(refused.code).toBe('not_dispatchable');
    expect(refused.message).toContain('has not been approved');
    expect(project(id).project.tasks[0]?.status).toBe('proposed');
    expect(project(id).project.session.tasksDispatched).toBe(0);
  });

  it('sends exactly the approved text, including project constraints', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    h.companion.orchestrator.approveTask(id, taskId);
    const claim = h.companion.orchestrator.claimDispatch(id, taskId, { tabId: 3, tabUrl: 'https://arena.ai/x' });
    const task = project(id).project.tasks[0]!;
    expect(claim.prompt).toBe(renderArenaPrompt({ task, projectName: 'Demo app', constraints: ['Do not add new runtime dependencies'] }));
    expect(claim.prompt).toContain('# Task T-1: Implement the login form');
    expect(claim.prompt).toContain('- `npm test` passes');
    expect(claim.prompt).toContain('- Do not add new runtime dependencies');
    expect(claim.prompt).not.toContain(PROPOSAL.rationale);
    expect(task.status).toBe('dispatching');
    expect(task.dispatch).toMatchObject({ attempt: 1, tabId: 3, tabUrl: 'https://arena.ai/x', unconfirmed: false });
  });

  it('lets the user edit a proposed task, and the edit is what gets sent', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const edited = h.companion.orchestrator.editTask(id, taskId, {
      title: 'Implement the login form (email only)',
      instructions: 'Create a LoginForm with an email field only.',
      acceptanceCriteria: ['`npm test` passes'],
    });
    expect(edited).toMatchObject({ editedByUser: true, status: 'proposed', title: 'Implement the login form (email only)' });
    h.companion.orchestrator.approveTask(id, taskId);
    const { prompt } = h.companion.orchestrator.claimDispatch(id, taskId);
    expect(prompt).toContain('Create a LoginForm with an email field only.');
    expect(prompt).not.toContain('password fields');
    expect(rejection(() => h.companion.orchestrator.editTask(id, taskId, { title: 'too late' })).code).toBe('invalid_state');
  });

  it('lets the user reject a task; a reason is passed to Gemini for a revised proposal', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    h.fake.enqueue(toolResponse([{ name: 'propose_arena_task', args: { ...PROPOSAL, title: 'Implement passwordless login', instructions: 'Build a magic-link login form.' } }]), textResponse('Revised.'));
    const rejected = h.companion.orchestrator.rejectTask(id, taskId, 'We do not want passwords at all.');
    expect(rejected.status).toBe('rejected');
    await h.companion.orchestrator.whenIdle(id);

    const feedback = h.fake.generateRequests.at(-2)!.body.contents.at(-1).parts[0].text as string;
    expect(feedback).toContain('[AgentLink] The user rejected task T-1');
    expect(feedback).toContain('We do not want passwords at all.');
    const view = project(id);
    expect(view.project.tasks.map((t) => [t.id, t.status])).toEqual([
      ['T-1', 'rejected'],
      ['T-2', 'proposed'],
    ]);
    expect(rejection(() => h.companion.orchestrator.claimDispatch(id, 'T-1')).code).toBe('not_dispatchable');
  });

  it('rejecting without a reason does not call Gemini, but the next turn is told about it', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const before = h.fake.generateRequests.length;
    h.companion.orchestrator.rejectTask(id, taskId);
    await h.companion.orchestrator.whenIdle(id);
    expect(h.fake.generateRequests).toHaveLength(before);

    h.fake.enqueue(textResponse('What would you like instead?'));
    await say(id, 'ok');
    const text = h.fake.lastGenerate().body.contents.at(-1).parts[0].text as string;
    expect(text).toContain('[AgentLink] The user rejected task T-1');
    expect(text.endsWith('ok')).toBe(true);
  });

  it('allows only one open task at a time and tells Gemini why', async () => {
    const id = newProject();
    await proposeTask(id);
    h.fake.enqueue(toolResponse([{ name: 'propose_arena_task', args: { ...PROPOSAL, title: 'Another', instructions: 'Something else entirely.' } }]), textResponse('I will wait.'));
    await say(id, 'propose another one too');
    const view = project(id);
    expect(view.project.tasks).toHaveLength(1);
    expect(view.conversation.at(-1)?.actions[0]).toMatchObject({ name: 'propose_arena_task', ok: false });
    const response = h.fake.lastGenerate().body.contents.at(-1).parts[0].functionResponse.response;
    expect(response.ok).toBe(false);
    expect(response.error).toContain('T-1');
    expect(response.error).toContain('Only one task may be open');
  });

  it('refuses proposals with no checkable acceptance criteria', async () => {
    const id = newProject();
    h.fake.enqueue(toolResponse([{ name: 'propose_arena_task', args: { ...PROPOSAL, acceptance_criteria: [] } }]), textResponse('Let me fix that.'));
    await say(id, 'go');
    expect(project(id).project.tasks).toHaveLength(0);
    expect(project(id).conversation.at(-1)?.actions[0]?.ok).toBe(false);
  });
});

describe('Arena communication and duplicate prevention', () => {
  it('hands a task out for delivery exactly once', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const o = h.companion.orchestrator;
    o.approveTask(id, taskId);
    const claim = o.claimDispatch(id, taskId);

    const second = rejection(() => o.claimDispatch(id, taskId));
    expect(second.code).toBe('not_dispatchable');
    expect(second.message).toContain('already been handed to Arena');

    o.confirmDispatch(id, taskId, claim.dispatchId);
    expect(rejection(() => o.claimDispatch(id, taskId)).code).toBe('not_dispatchable');
    // Confirming again is harmless and does not count the task twice.
    o.confirmDispatch(id, taskId, claim.dispatchId);
    const view = project(id);
    expect(view.project.tasks[0]?.status).toBe('awaiting_response');
    expect(view.project.session.tasksDispatched).toBe(1);
    expect(view.project.timeline.filter((e) => e.title === 'Task T-1 sent to Arena')).toHaveLength(1);
  });

  it('approving twice is idempotent and does not create a second delivery', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const o = h.companion.orchestrator;
    o.approveTask(id, taskId);
    o.approveTask(id, taskId);
    expect(project(id).project.timeline.filter((e) => e.title === 'Task T-1 approved by you')).toHaveLength(1);
  });

  it('returns the task to "approved" when delivery definitely failed, and allows a retry', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const o = h.companion.orchestrator;
    o.approveTask(id, taskId);
    const first = o.claimDispatch(id, taskId);
    const failed = o.failDispatch(id, taskId, { dispatchId: first.dispatchId, error: 'No Arena tab is open.', submitted: false });
    expect(failed.status).toBe('approved');
    expect(failed.dispatch?.error).toBe('No Arena tab is open.');
    expect(project(id).project.session.tasksDispatched).toBe(0);

    const retry = o.claimDispatch(id, taskId);
    expect(retry.dispatchId).not.toBe(first.dispatchId);
    expect(project(id).project.tasks[0]?.dispatch?.attempt).toBe(2);
    // The stale first attempt can no longer confirm anything.
    expect(rejection(() => o.confirmDispatch(id, taskId, first.dispatchId)).code).toBe('stale_dispatch');
  });

  it('never re-sends when delivery is uncertain; only the user can declare it not sent', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const o = h.companion.orchestrator;
    o.approveTask(id, taskId);
    const claim = o.claimDispatch(id, taskId);
    const uncertain = o.failDispatch(id, taskId, { dispatchId: claim.dispatchId, error: 'Could not confirm submission.', submitted: 'unknown' });
    expect(uncertain.status).toBe('awaiting_response');
    expect(uncertain.dispatch?.unconfirmed).toBe(true);
    expect(rejection(() => o.claimDispatch(id, taskId)).code).toBe('not_dispatchable');

    expect(o.resetDispatch(id, taskId).status).toBe('approved');
    expect(o.claimDispatch(id, taskId).dispatchId).not.toBe(claim.dispatchId);
  });

  it('refuses a proposal identical to a task that was already sent', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const dispatchId = deliver(id, taskId);
    h.fake.enqueue(
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: taskId, verdict: 'failed', summary: 'Nothing was done.', evidence: [] } }]),
      // Gemini tries to send the very same task again.
      toolResponse([{ name: 'propose_arena_task', args: { ...PROPOSAL } }]),
      textResponse('I need to rethink the task.'),
    );
    h.companion.orchestrator.recordArenaResponse(id, taskId, { dispatchId, text: 'I could not find the repository.', source: 'auto' });
    await h.companion.orchestrator.whenIdle(id);

    const view = project(id);
    expect(view.project.tasks.map((t) => t.status)).toEqual(['failed']);
    const actions = view.conversation.at(-1)!.actions;
    expect(actions[1]).toMatchObject({ name: 'propose_arena_task', ok: false });
    expect(actions[1]?.summary).toContain('identical to T-1');
  });

  it('records an Arena reply only once and only for a task that is waiting for one', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const o = h.companion.orchestrator;
    expect(rejection(() => o.recordArenaResponse(id, taskId, { text: ARENA_REPLY, source: 'pasted' })).code).toBe('invalid_state');

    const dispatchId = deliver(id, taskId);
    expect(rejection(() => o.recordArenaResponse(id, taskId, { dispatchId: 'other', text: ARENA_REPLY, source: 'auto' })).code).toBe('stale_dispatch');
    expect(rejection(() => o.recordArenaResponse(id, taskId, { dispatchId, text: '   ', source: 'auto' })).httpStatus).toBe(400);

    h.fake.enqueue(toolResponse([{ name: 'evaluate_arena_result', args: { task_id: taskId, verdict: 'unclear', summary: 'n/a', evidence: [] } }]), textResponse('Noted.'));
    o.recordArenaResponse(id, taskId, { dispatchId, text: ARENA_REPLY, source: 'auto' });
    expect(rejection(() => o.recordArenaResponse(id, taskId, { dispatchId, text: ARENA_REPLY, source: 'auto' })).code).toBe('response_already_recorded');
    await o.whenIdle(id);
    expect(h.fake.generateRequests.filter((r) => JSON.stringify(r.body).includes('ARENA_RESPONSE_BEGIN'))).not.toHaveLength(0);
    expect(project(id).project.timeline.filter((e) => e.title === 'Arena replied to T-1')).toHaveLength(1);
  });

  it('pauses the session when the task budget is used up, and continues after a resume', async () => {
    h.companion.settings.update({ maxTasksPerSession: 1 });
    const id = newProject();
    const first = await proposeTask(id);
    const dispatchId = deliver(id, first);
    h.fake.enqueue(
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: first, verdict: 'partial', summary: 'Tests pass, build not shown.', evidence: ['14 passed, 0 failed'] } }]),
      toolResponse([{ name: 'propose_arena_task', args: { ...PROPOSAL, title: 'Run the build', instructions: 'Run npm run build and report the output.' } }]),
      textResponse('Budget reached.'),
    );
    h.companion.orchestrator.recordArenaResponse(id, first, { dispatchId, text: ARENA_REPLY, source: 'auto' });
    await h.companion.orchestrator.whenIdle(id);
    // Gemini is told the limit was reached instead of being allowed to queue more work.
    expect(project(id).conversation.at(-1)?.actions[1]).toMatchObject({ name: 'propose_arena_task', ok: false });
    expect(project(id).project.tasks).toHaveLength(1);

    h.companion.settings.update({ maxTasksPerSession: 2 });
    const second = await proposeTask(id, { title: 'Run the build', instructions: 'Run npm run build and report the output.' });
    h.companion.settings.update({ maxTasksPerSession: 1 });
    h.companion.orchestrator.approveTask(id, second);
    expect(rejection(() => h.companion.orchestrator.claimDispatch(id, second)).code).toBe('task_budget_reached');
    expect(project(id).project.session).toMatchObject({ status: 'paused', pauseReason: 'task_budget' });
    expect(project(id).project.tasks[1]?.status).toBe('approved');

    h.companion.orchestrator.controlSession(id, 'resume');
    expect(project(id).project.session).toMatchObject({ status: 'running', tasksDispatched: 0 });
    expect(h.companion.orchestrator.claimDispatch(id, second).prompt).toContain('Run the build');
  });
});

describe('evaluation of Arena results', () => {
  it('forces a structured verdict, grounds it in the real reply, and updates progress', async () => {
    const id = newProject();
    h.fake.enqueue(
      toolResponse([{ name: 'set_plan', args: { milestones: [{ title: 'Login form', description: 'Form exists and is tested' }, { title: 'Session handling' }] } }]),
      toolResponse([{ name: 'propose_arena_task', args: { ...PROPOSAL, milestone_id: 'M-1' } }]),
      textResponse('Plan set and first task proposed.'),
    );
    await say(id, 'Build the login flow.');
    expect(project(id).project.milestones.map((m) => [m.id, m.status])).toEqual([
      ['M-1', 'in_progress'],
      ['M-2', 'pending'],
    ]);
    const dispatchId = deliver(id, 'T-1');

    h.fake.enqueue(
      toolResponse([
        {
          name: 'evaluate_arena_result',
          args: {
            task_id: 'T-1',
            verdict: 'complete',
            summary: 'The form was created and both checks are reported as passing.',
            evidence: ['Ran `npm test`: 14 passed, 0 failed.', 'build completed without errors'],
          },
        },
      ]),
      toolResponse([
        { name: 'update_milestone', args: { milestone_id: 'M-1', status: 'done', notes: 'Verified by T-1' } },
        { name: 'record_decision', args: { summary: 'Forms live in src/components', rationale: 'Arena placed LoginForm there.' } },
      ]),
      textResponse('T-1 is verified. Next is session handling.'),
    );
    h.companion.orchestrator.recordArenaResponse(id, 'T-1', { dispatchId, text: ARENA_REPLY, source: 'auto' });
    expect(project(id).project.tasks[0]?.status).toBe('evaluating');
    await h.companion.orchestrator.whenIdle(id);

    // First evaluation request: Gemini must call the evaluation tool and sees the verbatim reply as quoted data.
    const evalRequest = h.fake.generateRequests.find((r) => JSON.stringify(r.body.contents.at(-1)).includes('ARENA_RESPONSE_BEGIN'))!;
    expect(evalRequest.body.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY', allowedFunctionNames: ['evaluate_arena_result'] });
    const handed = evalRequest.body.contents.at(-1).parts[0].text as string;
    expect(handed).toContain('[AgentLink] Arena has replied to task T-1');
    expect(handed).toContain(ARENA_REPLY);
    expect(handed).toMatch(/<<<ARENA_RESPONSE_BEGIN [0-9a-f]{12}>>>/);
    // Later rounds in the same turn are free-form again.
    expect(h.fake.lastGenerate().body.toolConfig.functionCallingConfig.mode).toBe('AUTO');

    const view = project(id);
    const task = view.project.tasks[0]!;
    expect(task.status).toBe('completed');
    expect(task.evaluation).toMatchObject({ verdict: 'complete', model: 'gemini-4-hydrogen', evidence: ['Ran `npm test`: 14 passed, 0 failed.', 'build completed without errors'] });
    expect(task.arenaResponse).toMatchObject({ text: ARENA_REPLY, source: 'auto', chars: ARENA_REPLY.length, truncated: false });
    expect(view.project.currentTaskId).toBeNull();
    expect(view.project.milestones[0]).toMatchObject({ status: 'done', notes: 'Verified by T-1' });
    expect(view.project.currentMilestoneId).toBe('M-2');
    expect(view.project.decisions[0]).toMatchObject({ id: 'D-1', summary: 'Forms live in src/components' });
    expect(view.conversation.at(-1)?.text).toBe('T-1 is verified. Next is session handling.');
    expect(view.conversation.map((e) => e.kind)).toContain('arena_result');
  });

  it('refuses a "complete" verdict whose evidence is not in the reply', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const dispatchId = deliver(id, taskId);
    h.fake.enqueue(
      // Fabricated evidence: these words are not in Arena's reply.
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: taskId, verdict: 'complete', summary: 'All done.', evidence: ['All 200 tests passed and the app was deployed to production'] } }]),
      // Corrected after the refusal.
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: taskId, verdict: 'partial', summary: 'Tests pass; deployment is not shown.', evidence: ['14 passed, 0 failed'], missing: ['Deployment'] } }]),
      textResponse('Partially done.'),
    );
    h.companion.orchestrator.recordArenaResponse(id, taskId, { dispatchId, text: ARENA_REPLY, source: 'auto' });
    await h.companion.orchestrator.whenIdle(id);

    const requests = h.fake.generateRequests.slice(-3);
    const refusal = requests[1]!.body.contents.at(-1).parts[0].functionResponse.response;
    expect(refusal.ok).toBe(false);
    expect(refusal.error).toContain('do not appear in Arena\'s reply');
    // Still unevaluated, so the next round is forced to evaluate again.
    expect(requests[1]!.body.toolConfig.functionCallingConfig.mode).toBe('ANY');

    const task = project(id).project.tasks[0]!;
    expect(task.status).toBe('partial');
    expect(task.evaluation).toMatchObject({ verdict: 'partial', missing: ['Deployment'] });
    expect(project(id).conversation.at(-1)?.actions.map((a) => a.ok)).toEqual([false, true]);
  });

  it('never marks a task complete without evidence, even if Gemini insists', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const dispatchId = deliver(id, taskId);
    const insist = () => toolResponse([{ name: 'evaluate_arena_result', args: { task_id: taskId, verdict: 'complete', summary: 'Done.', evidence: [] } }]);
    h.fake.enqueue(insist(), insist(), insist(), textResponse('It is complete, trust me.'));
    h.companion.orchestrator.recordArenaResponse(id, taskId, { dispatchId, text: 'I will start working on this soon.', source: 'auto' });
    await h.companion.orchestrator.whenIdle(id);

    const task = project(id).project.tasks[0]!;
    expect(task.status).toBe('evaluating');
    expect(task.evaluation).toBeNull();
    expect(task.evaluationError).toContain('without recording a verdict');
    expect(project(id).project.timeline.some((e) => e.title === 'Evaluation of T-1 did not finish')).toBe(true);

    // The user can ask for the evaluation to be run again.
    h.fake.enqueue(toolResponse([{ name: 'evaluate_arena_result', args: { task_id: taskId, verdict: 'unclear', summary: 'Only an intention was stated.', evidence: ['I will start working on this soon.'] } }]), textResponse('Unclear.'));
    h.companion.orchestrator.retryEvaluation(id, taskId);
    await h.companion.orchestrator.whenIdle(id);
    expect(project(id).project.tasks[0]).toMatchObject({ status: 'inconclusive', evaluationError: null });
  });

  it('cannot evaluate a task that Arena has not answered', async () => {
    const id = newProject();
    await proposeTask(id);
    h.fake.enqueue(toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-1', verdict: 'complete', summary: 'Done', evidence: ['made up quote'] } }]), textResponse('Hm.'));
    await say(id, 'just mark it done');
    expect(project(id).project.tasks[0]?.status).toBe('proposed');
    const action = project(id).conversation.at(-1)!.actions[0]!;
    expect(action.ok).toBe(false);
    expect(action.summary).toContain('no reply from Arena');
  });

  it('keeps the evaluation pending when the Gemini call fails, and reports why', async () => {
    h.companion.settings.update({ maxRetries: 0 });
    const id = newProject();
    const taskId = await proposeTask(id);
    const dispatchId = deliver(id, taskId);
    h.fake.enqueue({ kind: 'error', status: 503, body: errorBody(503, 'UNAVAILABLE', 'Overloaded.') });
    h.companion.orchestrator.recordArenaResponse(id, taskId, { dispatchId, text: ARENA_REPLY, source: 'auto' });
    await h.companion.orchestrator.whenIdle(id);
    const task = project(id).project.tasks[0]!;
    expect(task.status).toBe('evaluating');
    expect(task.arenaResponse?.text).toBe(ARENA_REPLY);
    expect(task.evaluationError).toContain('Overloaded.');
  });

  it('only declares the objective complete when verified work and milestones support it', async () => {
    const id = newProject();
    h.fake.enqueue(toolResponse([{ name: 'mark_objective_complete', args: { summary: 'Everything works.' } }]), textResponse('Not yet.'));
    await say(id, 'are we done?');
    expect(project(id).project.status).toBe('active');
    expect(project(id).conversation.at(-1)?.actions[0]).toMatchObject({ ok: false });
    expect(project(id).conversation.at(-1)?.actions[0]?.summary).toContain('No task has been verified');

    const taskId = await proposeTask(id);
    const dispatchId = deliver(id, taskId);
    h.fake.enqueue(
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: taskId, verdict: 'complete', summary: 'Verified.', evidence: ['14 passed, 0 failed', 'build completed without errors'] } }]),
      toolResponse([{ name: 'mark_objective_complete', args: { summary: 'Login flow shipped; verified by T-1.' } }]),
      textResponse('The objective is complete.'),
    );
    h.companion.orchestrator.recordArenaResponse(id, taskId, { dispatchId, text: ARENA_REPLY, source: 'auto' });
    await h.companion.orchestrator.whenIdle(id);
    const view = project(id);
    expect(view.project.status).toBe('complete');
    expect(view.project.completion?.summary).toBe('Login flow shipped; verified by T-1.');
    expect(view.project.session.status).toBe('completed');

    // A completed project does not keep generating work until the user reopens it.
    expect(rejection(() => h.companion.orchestrator.sendMessage(id, 'one more thing')).code).toBe('session_not_running');
    h.companion.orchestrator.controlSession(id, 'start');
    expect(project(id).project).toMatchObject({ status: 'active', completion: null });
    expect(project(id).project.session.status).toBe('running');
  });
});

describe('pause, resume and stop', () => {
  it('blocks Gemini and Arena while paused, and resumes cleanly', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const o = h.companion.orchestrator;
    o.controlSession(id, 'pause');
    expect(project(id).project.session).toMatchObject({ status: 'paused', pauseReason: 'user' });

    const before = h.fake.generateRequests.length;
    expect(rejection(() => o.sendMessage(id, 'hello?')).code).toBe('session_not_running');
    expect(rejection(() => o.approveTask(id, taskId)).code).toBe('session_not_running');
    expect(h.fake.generateRequests).toHaveLength(before);
    // Editing stays possible while paused.
    expect(o.editTask(id, taskId, { title: 'Edited while paused' }).title).toBe('Edited while paused');

    o.controlSession(id, 'resume');
    o.approveTask(id, taskId);
    expect(o.claimDispatch(id, taskId).prompt).toContain('Edited while paused');
    expect(rejection(() => o.controlSession(id, 'resume')).code).toBe('invalid_transition');
  });

  it('pausing interrupts a reply that is being streamed', async () => {
    const id = newProject();
    h.fake.enqueue(textResponse('This answer is long enough to be interrupted half way through.', { pieces: 10, chunkDelayMs: 30 }));
    const sent = h.companion.orchestrator.sendMessage(id, 'tell me a lot');
    await waitFor(() => {
      const last = project(id).conversation.at(-1);
      return last?.role === 'coordinator' && last.text.length > 5;
    }, 'the reply to start streaming');
    h.companion.orchestrator.controlSession(id, 'pause');
    await sent.done;

    const entry = project(id).conversation.at(-1)!;
    expect(entry.status).toBe('interrupted');
    expect(entry.text.length).toBeGreaterThan(0);
    expect(entry.text.length).toBeLessThan('This answer is long enough to be interrupted half way through.'.length);
    expect(h.companion.orchestrator.turnState(id).active).toBe(false);

    // After resuming, the conversation continues from a valid history that includes the partial reply.
    h.companion.orchestrator.controlSession(id, 'resume');
    h.fake.enqueue(textResponse('Continuing.'));
    await say(id, 'go on');
    const contents = h.fake.lastGenerate().body.contents;
    expect(contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
    expect(contents[1].parts[0].text).toBe(entry.text);
  });

  it('holds an Arena reply that arrives while paused and evaluates it on resume', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const dispatchId = deliver(id, taskId);
    const o = h.companion.orchestrator;
    o.controlSession(id, 'pause');

    const before = h.fake.generateRequests.length;
    o.recordArenaResponse(id, taskId, { dispatchId, text: ARENA_REPLY, source: 'auto' });
    await o.whenIdle(id);
    expect(h.fake.generateRequests).toHaveLength(before);
    expect(project(id).project.tasks[0]).toMatchObject({ status: 'evaluating', evaluation: null });
    expect(project(id).project.tasks[0]?.arenaResponse?.text).toBe(ARENA_REPLY);

    h.fake.enqueue(toolResponse([{ name: 'evaluate_arena_result', args: { task_id: taskId, verdict: 'complete', summary: 'ok', evidence: ['14 passed, 0 failed'] } }]), textResponse('Evaluated after resume.'));
    o.controlSession(id, 'resume');
    await o.whenIdle(id);
    expect(project(id).project.tasks[0]?.status).toBe('completed');
  });

  it('re-runs an evaluation that was interrupted by a pause', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const dispatchId = deliver(id, taskId);
    const o = h.companion.orchestrator;
    h.fake.enqueue({ kind: 'hang' });
    o.recordArenaResponse(id, taskId, { dispatchId, text: ARENA_REPLY, source: 'auto' });
    await waitFor(() => o.turnState(id).active, 'the evaluation turn to start');
    o.controlSession(id, 'pause');
    await o.whenIdle(id);
    expect(project(id).project.tasks[0]).toMatchObject({ status: 'evaluating', evaluationError: null });

    h.fake.enqueue(toolResponse([{ name: 'evaluate_arena_result', args: { task_id: taskId, verdict: 'complete', summary: 'ok', evidence: ['14 passed, 0 failed'] } }]), textResponse('Done.'));
    o.controlSession(id, 'resume');
    await o.whenIdle(id);
    expect(project(id).project.tasks[0]?.status).toBe('completed');
  });

  it('stop ends the session, cancels the open task and ignores a late Arena reply', async () => {
    const id = newProject();
    const taskId = await proposeTask(id);
    const dispatchId = deliver(id, taskId);
    const o = h.companion.orchestrator;
    o.controlSession(id, 'stop');

    const view = project(id);
    expect(view.project.session.status).toBe('stopped');
    expect(view.project.tasks[0]?.status).toBe('cancelled');
    expect(view.project.currentTaskId).toBeNull();
    const before = h.fake.generateRequests.length;
    expect(rejection(() => o.recordArenaResponse(id, taskId, { dispatchId, text: ARENA_REPLY, source: 'auto' })).code).toBe('invalid_state');
    expect(rejection(() => o.sendMessage(id, 'hi')).code).toBe('session_not_running');
    expect(rejection(() => o.claimDispatch(id, taskId)).code).toBe('session_not_running');
    expect(h.fake.generateRequests).toHaveLength(before);

    // A new session can be started, and Gemini learns what happened.
    o.controlSession(id, 'start');
    h.fake.enqueue(textResponse('Understood.'));
    await say(id, 'let us continue');
    const text = h.fake.lastGenerate().body.contents.at(-1).parts[0].text as string;
    expect(text).toContain('The user stopped the session; task T-1');
  });

  it('stopping interrupts a running reply', async () => {
    const id = newProject();
    h.fake.enqueue({ kind: 'hang' });
    const sent = h.companion.orchestrator.sendMessage(id, 'think hard');
    await waitFor(() => h.companion.orchestrator.turnState(id).active, 'the turn to start');
    h.companion.orchestrator.controlSession(id, 'stop');
    await sent.done;
    expect(project(id).conversation.at(-1)?.status).toBe('interrupted');
    expect(project(id).project.session.status).toBe('stopped');
  });

  it('a single reply can be stopped without pausing the session', async () => {
    const id = newProject();
    h.fake.enqueue({ kind: 'hang' });
    const sent = h.companion.orchestrator.sendMessage(id, 'think hard');
    await waitFor(() => h.companion.orchestrator.turnState(id).active, 'the turn to start');
    expect(h.companion.orchestrator.cancelTurn(id)).toEqual({ cancelled: true });
    await sent.done;
    expect(project(id).conversation.at(-1)?.status).toBe('interrupted');
    expect(project(id).project.session.status).toBe('running');
    expect(h.companion.orchestrator.cancelTurn(id)).toEqual({ cancelled: false });
  });

  it('lets the user change the objective at any time and tells Gemini about it', async () => {
    const id = newProject();
    h.fake.enqueue(textResponse('ok'));
    await say(id, 'hello');
    h.companion.orchestrator.controlSession(id, 'pause');
    h.companion.orchestrator.updateProject(id, { objective: 'Ship login with SSO only' });
    expect(project(id).project.objective).toBe('Ship login with SSO only');
    h.companion.orchestrator.controlSession(id, 'resume');

    h.fake.enqueue(textResponse('Noted the new objective.'));
    await say(id, 'continue');
    const request = h.fake.lastGenerate().body;
    expect(request.systemInstruction.parts[0].text).toContain('Objective: Ship login with SSO only');
    expect(request.contents.at(-1).parts[0].text).toContain('[AgentLink] The user changed the project objective. It is now: Ship login with SSO only');
  });

  it('stops tool loops after the configured number of rounds', async () => {
    h.companion.settings.update({ maxToolRounds: 2 });
    const id = newProject();
    let n = 0;
    h.fake.fallback = (request) => {
      // A model that would call tools forever if allowed to.
      if (request.body.toolConfig?.functionCallingConfig?.mode === 'NONE') return textResponse('Stopping here.');
      n += 1;
      return toolResponse([{ name: 'record_decision', args: { summary: `Decision number ${n}` } }]);
    };
    await say(id, 'decide things');
    expect(h.fake.generateRequests).toHaveLength(3); // 2 tool rounds + 1 closing round without tools
    expect(project(id).project.decisions).toHaveLength(2);
    expect(project(id).conversation.at(-1)).toMatchObject({ status: 'complete', text: 'Stopping here.' });
  });
});
