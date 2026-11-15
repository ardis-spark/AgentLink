import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompanionEvent } from '../../src/shared/api.js';
import { hasCompletionMarker } from '../../src/shared/arenaPrompt.js';
import type { Companion } from '../../src/companion/app.js';
import { OrchestratorError } from '../../src/companion/orchestration/orchestrator.js';
import { errorBody, textResponse, toolResponse, VALID_KEY, type Scripted, type ScriptedOrFn } from '../helpers/fakeGemini.js';
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

const TASK = {
  title: 'Implement the login form',
  instructions: 'Create a LoginForm React component with email and password fields and client-side validation.',
  context: 'The repository is a Vite + React + TypeScript app. Components live in src/components.',
  acceptance_criteria: ['`npm test` passes', '`npm run build` succeeds'],
  rationale: 'The login form is the first milestone and unblocks the session work.',
};

const NEXT_TASK = {
  title: 'Add session handling',
  instructions: 'Persist the signed-in user in a session cookie and restore it on reload.',
  acceptance_criteria: ['`npm test` passes'],
  rationale: 'The second milestone.',
};

const OBJECTIVE = { name: 'Demo app', objective: 'Ship a working login flow', constraints: ['Do not add new runtime dependencies'] };

/** A turn in which Gemini sends a task to Arena. */
function dispatches(args: Record<string, unknown> = TASK, text = 'Sent to Arena.'): ScriptedOrFn[] {
  return [toolResponse([{ name: 'dispatch_arena_task', args }]), textResponse(text)];
}

/** A turn in which Gemini asks the user something, which is the only way a turn may end with nothing in motion. */
function asks(question = 'Which stack does the app use?', options: string[] = []): ScriptedOrFn[] {
  return [toolResponse([{ name: 'request_user_input', args: { question, why: 'It decides the first task.', options } }]), textResponse(question)];
}

function evaluates(taskId: string, verdict = 'complete', evidence: string[] = ['Ran `npm test`: 14 passed, 0 failed.']): Scripted {
  return toolResponse([{ name: 'evaluate_arena_result', args: { task_id: taskId, verdict, summary: 'Checked against the criteria.', evidence } }]);
}

function start(c: Companion = h.companion): string {
  return c.orchestrator.createProject({ ...OBJECTIVE, start: true }).project.id;
}

function project(id: string, c: Companion = h.companion) {
  return c.orchestrator.getProject(id);
}

function task(id: string, taskId = 'T-1', c: Companion = h.companion) {
  return c.orchestrator.getTask(id, taskId);
}

async function settle(id: string, c: Companion = h.companion): Promise<void> {
  await c.orchestrator.whenIdle(id);
}

async function say(id: string, text: string, c: Companion = h.companion): Promise<void> {
  await c.orchestrator.sendMessage(id, text).done;
  await settle(id, c);
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

/** Delivers the queued task the way the browser extension does. */
function deliver(id: string, taskId = 'T-1', c: Companion = h.companion): string {
  const o = c.orchestrator;
  const claim = o.claimDispatch(id, taskId, { tabId: 7, tabUrl: 'https://arena.ai/agent/abc' });
  o.confirmDispatch(id, taskId, claim.dispatchId);
  return claim.dispatchId;
}

/** Brings Arena's reply back the way the browser extension does. */
function reply(id: string, taskId = 'T-1', text = ARENA_REPLY, c: Companion = h.companion): void {
  const dispatchId = task(id, taskId, c).dispatch?.dispatchId ?? null;
  c.orchestrator.recordArenaResponse(id, taskId, { dispatchId, text, source: 'auto', completion: 'marker' });
}

/** Starts a project and lets it run until the first task is queued for Arena. */
async function startedWithTask(): Promise<string> {
  h.fake.enqueue(...dispatches());
  const id = start();
  await settle(id);
  expect(task(id).status).toBe('queued');
  return id;
}

function requestTexts(index: number): string {
  const contents = h.fake.generateRequests[index]?.body.contents as { parts: { text?: string }[] }[];
  return contents.map((c) => c.parts.map((p) => p.text ?? '').join('')).join('\n');
}

describe('the autonomous loop', () => {
  it('starts from the objective alone and queues the first task for Arena without any approval', async () => {
    h.fake.enqueue(
      toolResponse([
        { name: 'set_plan', args: { milestones: [{ title: 'Login form' }, { title: 'Sessions' }] } },
        { name: 'dispatch_arena_task', args: TASK },
      ]),
      textResponse('Plan set; the first task is on its way to Arena.'),
    );
    const id = start();
    await settle(id);

    // The objective was the only input; no message from the user was needed.
    expect(h.fake.generateRequests).toHaveLength(2);
    expect(requestTexts(0)).toContain('Ship a working login flow');
    const view = project(id);
    expect(view.conversation.some((e) => e.role === 'user')).toBe(false);
    expect(view.project.session.status).toBe('running');
    expect(view.project.milestones.map((m) => m.title)).toEqual(['Login form', 'Sessions']);
    expect(view.project.tasks).toHaveLength(1);
    expect(view.project.tasks[0]).toMatchObject({ id: 'T-1', status: 'queued', title: TASK.title, acceptanceCriteria: TASK.acceptance_criteria });
    expect(view.project.currentTaskId).toBe('T-1');

    // The extension finds it as work to do straight away.
    const work = h.companion.orchestrator.relayWork();
    expect(work.items.map((i) => [i.projectId, i.task.id, i.task.status])).toEqual([[id, 'T-1', 'queued']]);
  });

  it('runs plan → send → reply → review → next task → … → complete with no user action in between', async () => {
    const o = h.companion.orchestrator;
    h.fake.enqueue(
      toolResponse([
        { name: 'set_plan', args: { milestones: [{ title: 'Login form' }, { title: 'Sessions' }] } },
        { name: 'dispatch_arena_task', args: TASK },
      ]),
      textResponse('First task sent.'),
    );
    const id = start();
    await settle(id);

    // Round 1: the reply comes back; Gemini reviews it and sends the next task in the same turn.
    deliver(id, 'T-1');
    h.fake.enqueue(
      evaluates('T-1'),
      toolResponse([
        { name: 'update_milestone', args: { milestone_id: 'M-1', status: 'done' } },
        { name: 'dispatch_arena_task', args: NEXT_TASK },
      ]),
      textResponse('T-1 verified. T-2 sent.'),
    );
    reply(id, 'T-1');
    await settle(id);
    expect(task(id, 'T-1').status).toBe('completed');
    expect(task(id, 'T-2').status).toBe('queued');
    expect(project(id).project.session.status).toBe('running');

    // Round 2: the last reply; Gemini declares the objective complete.
    deliver(id, 'T-2');
    h.fake.enqueue(
      evaluates('T-2'),
      toolResponse([
        { name: 'update_milestone', args: { milestone_id: 'M-2', status: 'done' } },
        { name: 'mark_objective_complete', args: { summary: 'Login form and sessions are built and tested.' } },
      ]),
      textResponse('Everything is done.'),
    );
    reply(id, 'T-2');
    await settle(id);

    const view = project(id);
    expect(view.project.status).toBe('complete');
    expect(view.project.session.status).toBe('completed');
    expect(view.project.tasks.map((t) => t.status)).toEqual(['completed', 'completed']);
    expect(view.conversation.filter((e) => e.role === 'user')).toHaveLength(0);
    expect(o.relayWork().items).toEqual([]);
    // Nothing more is asked of Gemini once the objective is complete.
    const requests = h.fake.generateRequests.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(h.fake.generateRequests).toHaveLength(requests);
  });

  it('prompts Gemini again by itself when a turn ends with nothing in motion', async () => {
    h.fake.enqueue(textResponse('Let me think about the plan.'), ...dispatches());
    const id = start();
    await settle(id);

    expect(task(id).status).toBe('queued');
    // Turn 1 ended idle, so AgentLink told Gemini to act; no user message was involved.
    expect(requestTexts(1)).toContain('[AgentLink]');
    expect(project(id).conversation.some((e) => e.role === 'user')).toBe(false);
  });

  it('hands control back with a reason when Gemini keeps ending turns without acting', async () => {
    const id = start();
    await settle(id);

    const session = project(id).project.session;
    expect(session.status).toBe('blocked');
    expect(session.blocker).toMatchObject({ kind: 'coordinator' });
    expect(session.blocker?.detail).toContain('OK.');
    // It tried three times, then stopped spending requests.
    expect(h.fake.generateRequests).toHaveLength(3);
    expect(project(id).conversation.at(-1)).toMatchObject({ role: 'system' });

    // "Continue" prompts it again.
    h.fake.enqueue(...dispatches());
    h.companion.orchestrator.controlSession(id, 'resume');
    await settle(id);
    expect(project(id).project.session).toMatchObject({ status: 'running', blocker: null });
    expect(task(id).status).toBe('queued');
  });

  it('stops for the user only when Gemini asks a real question, and continues on the answer', async () => {
    h.fake.enqueue(...asks('Should sign-in use email or a username?', ['Email', 'Username']));
    const id = start();
    await settle(id);

    let session = project(id).project.session;
    expect(session.status).toBe('blocked');
    expect(session.blocker).toMatchObject({ kind: 'question', title: 'Should sign-in use email or a username?', options: ['Email', 'Username'] });
    expect(h.fake.generateRequests).toHaveLength(2);

    h.fake.enqueue(...dispatches());
    await say(id, 'Email');
    session = project(id).project.session;
    expect(session).toMatchObject({ status: 'running', blocker: null });
    expect(task(id).status).toBe('queued');
    expect(requestTexts(2)).toContain('Email');
  });

  it('continuing without answering tells Gemini to decide for itself', async () => {
    h.fake.enqueue(...asks());
    const id = start();
    await settle(id);

    h.fake.enqueue(...dispatches());
    h.companion.orchestrator.controlSession(id, 'resume');
    await settle(id);
    expect(requestTexts(2)).toContain('without answering your question');
    expect(task(id).status).toBe('queued');
  });

  it('does not let Gemini stop for the user while Arena is working', async () => {
    h.fake.enqueue(
      toolResponse([{ name: 'dispatch_arena_task', args: TASK }]),
      toolResponse([{ name: 'request_user_input', args: { question: 'Shall I continue?', why: 'Checking in.' } }]),
      textResponse('Waiting for Arena.'),
    );
    const id = start();
    await settle(id);
    expect(project(id).project.session.status).toBe('running');
    const refused = project(id).conversation.flatMap((e) => e.actions).find((a) => a.name === 'request_user_input');
    expect(refused?.ok).toBe(false);
  });

  it('accepts a message at any time and passes it to Gemini without stopping the work', async () => {
    const id = await startedWithTask();
    deliver(id);
    h.fake.enqueue(textResponse('Noted; I will keep that in mind for the next task.'));
    await say(id, 'Use Tailwind for styling from now on.');

    expect(project(id).project.session.status).toBe('running');
    expect(task(id).status).toBe('awaiting_response');
    expect(requestTexts(2)).toContain('Use Tailwind for styling from now on.');
    // The open task keeps the loop in motion, so no reminder turn follows.
    expect(h.fake.generateRequests).toHaveLength(3);
  });

  it('queues a message that arrives while Gemini is still working, and answers both in order', async () => {
    const id = await startedWithTask();
    h.fake.enqueue(textResponse('slow answer', { pieces: 3, chunkDelayMs: 40 }), textResponse('second answer'));
    const first = h.companion.orchestrator.sendMessage(id, 'one');
    await waitFor(() => h.companion.orchestrator.turnState(id).active, 'the turn to start');
    const second = h.companion.orchestrator.sendMessage(id, 'two');
    await Promise.all([first.done, second.done]);
    expect(
      project(id)
        .conversation.slice(-4)
        .map((e) => e.text),
    ).toEqual(['one', 'slow answer', 'two', 'second answer']);
    expect(h.fake.generateRequests).toHaveLength(4);
  });
});

describe('conversation and memory sent to Gemini', () => {
  it('streams the reply, stores the turn, and sends prior turns back on the next request', async () => {
    const id = await startedWithTask();
    const events: CompanionEvent[] = [];
    h.companion.bus.subscribe((e) => events.push(e));

    h.fake.enqueue(textResponse('Understood. The login form comes first.', { pieces: 4 }));
    await say(id, 'What are you doing right now?');

    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e.type === 'delta' ? e.text : ''));
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('Understood. The login form comes first.');

    const view = project(id);
    expect(view.conversation.slice(-2).map((e) => [e.role, e.status, e.text])).toEqual([
      ['user', 'complete', 'What are you doing right now?'],
      ['coordinator', 'complete', 'Understood. The login form comes first.'],
    ]);
    expect(view.conversation.at(-1)?.usage).toEqual({ promptTokens: 100, outputTokens: 25, totalTokens: 125 });

    const sent = h.fake.lastGenerate().body.contents as { role: string; parts: Record<string, unknown>[] }[];
    // Kick-off, the model's tool call, the tool result, the model's text, then the user's message.
    expect(sent.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
    expect(sent[1]?.parts.some((p) => 'functionCall' in p)).toBe(true);
    // The model's own parts, including the thought signature, are replayed unchanged.
    expect(sent[3]?.parts.some((p) => p.thoughtSignature === 'sig-text')).toBe(true);
    expect(sent[4]?.parts[0]?.text).toBe('What are you doing right now?');
  });

  it('gives Gemini the coordinator role, the autonomy rules and the current project memory on every request', async () => {
    const id = await startedWithTask();
    void id;
    const body = h.fake.lastGenerate().body;
    const system = body.systemInstruction.parts[0].text as string;
    expect(system).toContain('You are the AgentLink Coordinator');
    expect(system).toContain('# PROJECT MEMORY');
    expect(system).toContain('Project: Demo app');
    expect(system).toContain('Objective: Ship a working login flow');
    expect(system).toContain('Do not add new runtime dependencies');
    expect(system).not.toMatch(/wait(s|ing)? for (the user's|your|user) approval/i);
    const names = body.tools[0].functionDeclarations.map((f: { name: string }) => f.name);
    expect(names).toEqual(expect.arrayContaining(['set_plan', 'dispatch_arena_task', 'evaluate_arena_result', 'record_decision', 'record_issue', 'request_user_input', 'mark_objective_complete']));
    expect(names).not.toContain('propose_arena_task');
  });

  it('refuses to start without an API key instead of pretending to work', async () => {
    const bare = await createHarness({ saveKey: null });
    try {
      const o = bare.companion.orchestrator;
      const id = o.createProject({ ...OBJECTIVE, start: true }).project.id;
      // The project exists, but nothing claims to be running.
      expect(o.getProject(id).project.session.status).toBe('idle');
      expect(rejection(() => o.sendMessage(id, 'hello')).code).toBe('gemini_not_configured');
      expect(rejection(() => o.controlSession(id, 'start')).code).toBe('gemini_not_configured');
      expect(bare.fake.generateRequests).toHaveLength(0);
    } finally {
      await bare.cleanup();
    }
  });

  it('never stores the API key if the user pastes it into the conversation', async () => {
    const id = await startedWithTask();
    h.fake.enqueue(textResponse('Thanks.'));
    await say(id, `my key is ${VALID_KEY} please use it`);
    const stored = JSON.stringify(project(id));
    expect(stored).not.toContain(VALID_KEY);
    expect(JSON.stringify(h.fake.lastGenerate().body)).not.toContain(VALID_KEY);
  });

  it('lets the user change the objective at any time and tells Gemini about it', async () => {
    const id = await startedWithTask();
    h.companion.orchestrator.updateProject(id, { objective: 'Ship login and password reset' });
    h.fake.enqueue(textResponse('Understood.'));
    await say(id, 'Carry on.');
    expect(requestTexts(2)).toContain('Ship login and password reset');
    const system = h.fake.lastGenerate().body.systemInstruction.parts[0].text as string;
    expect(system).toContain('Objective: Ship login and password reset');
  });

  it('stops tool loops after the configured number of rounds', async () => {
    h.companion.settings.update({ maxToolRounds: 2 });
    h.fake.fallback = () => toolResponse([{ name: 'record_decision', args: { summary: `Decision ${Math.random()}` } }]);
    h.fake.enqueue(...dispatches());
    const id = start();
    await settle(id);
    const before = h.fake.generateRequests.length;
    const turn = h.companion.orchestrator.sendMessage(id, 'Record decisions.');
    h.fake.fallback = () => toolResponse([{ name: 'record_decision', args: { summary: `Decision ${Math.random()}` } }]);
    await turn.done;
    // Two tool rounds, then one last round in which calling tools is switched off.
    expect(h.fake.generateRequests.length - before).toBe(3);
    expect(h.fake.lastGenerate().body.toolConfig.functionCallingConfig.mode).toBe('NONE');
  });
});

describe('sending tasks to Arena', () => {
  it('sends exactly the stored task, with the project constraints and a completion line Arena must end with', async () => {
    const id = await startedWithTask();
    const claim = h.companion.orchestrator.claimDispatch(id, 'T-1', { tabId: 7, tabUrl: 'https://arena.ai/agent/abc' });

    expect(claim.prompt).toContain('# Task T-1: Implement the login form');
    expect(claim.prompt).toContain(TASK.instructions);
    expect(claim.prompt).toContain(TASK.context);
    for (const criterion of TASK.acceptance_criteria) expect(claim.prompt).toContain(criterion);
    expect(claim.prompt).toContain('Do not add new runtime dependencies');
    const ref = claim.task.dispatch?.ref ?? '';
    expect(ref).toMatch(/^AL-T-1-[a-z0-9]{8}$/);
    expect(claim.prompt).toContain(ref);
    expect(claim.prompt).toContain('AGENTLINK-DONE');
    // The prompt describes the closing line without containing it, so only Arena's reply can match.
    expect(hasCompletionMarker(claim.prompt, ref)).toBe(false);
    expect(hasCompletionMarker(`All done.\nAGENTLINK-DONE ${ref}`, ref)).toBe(true);
    expect(task(id).dispatch?.prompt).toBe(claim.prompt);
  });

  it('hands a task out for delivery exactly once', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    const claim = o.claimDispatch(id, 'T-1');
    expect(task(id).status).toBe('dispatching');
    expect(rejection(() => o.claimDispatch(id, 'T-1')).code).toBe('not_dispatchable');

    o.confirmDispatch(id, 'T-1', claim.dispatchId);
    expect(task(id).status).toBe('awaiting_response');
    expect(rejection(() => o.claimDispatch(id, 'T-1')).code).toBe('not_dispatchable');
    expect(project(id).project.session.tasksDispatched).toBe(1);
    // Confirming again changes nothing.
    o.confirmDispatch(id, 'T-1', claim.dispatchId);
    expect(project(id).project.session.tasksDispatched).toBe(1);
    expect(rejection(() => o.confirmDispatch(id, 'T-1', 'someone-else')).code).toBe('stale_dispatch');
  });

  it('puts a task back in the queue when delivery definitely failed, and sends it again by itself', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    const first = o.claimDispatch(id, 'T-1');
    const firstRef = first.task.dispatch?.ref;
    o.failDispatch(id, 'T-1', { dispatchId: first.dispatchId, error: 'The Arena message box was not found.', submitted: false });

    expect(task(id)).toMatchObject({ status: 'queued' });
    expect(task(id).dispatch?.error).toBe('The Arena message box was not found.');
    expect(o.relayWork().items.map((i) => i.task.status)).toEqual(['queued']);
    // Gemini is not involved: this is a delivery matter.
    expect(h.fake.generateRequests).toHaveLength(2);

    const second = o.claimDispatch(id, 'T-1');
    expect(second.dispatchId).not.toBe(first.dispatchId);
    expect(second.task.dispatch?.attempt).toBe(2);
    // A new attempt carries a new reference, so the two can never be confused in the page.
    expect(second.task.dispatch?.ref).not.toBe(firstRef);
    expect(rejection(() => o.confirmDispatch(id, 'T-1', first.dispatchId)).code).toBe('stale_dispatch');
  });

  it('never re-sends while delivery is uncertain; it is re-sent only once the page shows it never arrived', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    const claim = o.claimDispatch(id, 'T-1');
    o.failDispatch(id, 'T-1', { dispatchId: claim.dispatchId, error: 'Arena did not acknowledge the task.', submitted: 'unknown' });

    expect(task(id).status).toBe('awaiting_response');
    expect(task(id).dispatch?.unconfirmed).toBe(true);
    expect(rejection(() => o.claimDispatch(id, 'T-1')).code).toBe('not_dispatchable');

    // Either the extension finds it in the page …
    o.confirmDispatch(id, 'T-1', claim.dispatchId);
    expect(task(id).dispatch?.unconfirmed).toBe(false);
    expect(rejection(() => o.resetDispatch(id, 'T-1', { dispatchId: claim.dispatchId, reason: 'x' })).code).toBe('invalid_state');
  });

  it('re-queues an unconfirmed delivery that the page shows never arrived', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    const claim = o.claimDispatch(id, 'T-1');
    o.failDispatch(id, 'T-1', { dispatchId: claim.dispatchId, error: 'Arena did not acknowledge the task.', submitted: 'unknown' });
    expect(project(id).project.session.tasksDispatched).toBe(1);

    expect(rejection(() => o.resetDispatch(id, 'T-1', { dispatchId: 'other', reason: 'x' })).code).toBe('stale_dispatch');
    o.resetDispatch(id, 'T-1', { dispatchId: claim.dispatchId, reason: 'The task is not in the Arena conversation.' });
    expect(task(id).status).toBe('queued');
    expect(project(id).project.session.tasksDispatched).toBe(0);
    expect(o.claimDispatch(id, 'T-1').task.dispatch?.attempt).toBe(2);
  });

  it('stops retrying a delivery Arena keeps refusing and says why', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = o.claimDispatch(id, 'T-1');
      o.failDispatch(id, 'T-1', { dispatchId: claim.dispatchId, error: 'Arena refused the text.', submitted: false });
    }
    expect(rejection(() => o.claimDispatch(id, 'T-1')).code).toBe('dispatch_attempts_exhausted');
    const session = project(id).project.session;
    expect(session.status).toBe('blocked');
    expect(session.blocker).toMatchObject({ kind: 'arena', taskId: 'T-1' });
    expect(session.blocker?.detail).toContain('Arena refused the text.');
    // Blocked means nothing is typed into Arena.
    expect(o.relayWork().items).toEqual([]);

    // Continuing gives it a fresh set of attempts.
    o.controlSession(id, 'resume');
    expect(o.claimDispatch(id, 'T-1').task.dispatch?.attempt).toBe(1);
  });

  it('allows only one open task at a time and tells Gemini why', async () => {
    h.fake.enqueue(
      toolResponse([{ name: 'dispatch_arena_task', args: TASK }]),
      toolResponse([{ name: 'dispatch_arena_task', args: NEXT_TASK }]),
      textResponse('One at a time, then.'),
    );
    const id = start();
    await settle(id);
    expect(project(id).project.tasks.map((t) => t.id)).toEqual(['T-1']);
    const actions = project(id).conversation.flatMap((e) => e.actions).filter((a) => a.name === 'dispatch_arena_task');
    expect(actions.map((a) => a.ok)).toEqual([true, false]);
    expect(actions[1]?.summary).toContain('still open');
  });

  it('refuses tasks with no checkable acceptance criteria', async () => {
    h.fake.enqueue(toolResponse([{ name: 'dispatch_arena_task', args: { ...TASK, acceptance_criteria: [] } }]), ...dispatches());
    const id = start();
    await settle(id);
    const actions = project(id).conversation.flatMap((e) => e.actions).filter((a) => a.name === 'dispatch_arena_task');
    expect(actions.map((a) => a.ok)).toEqual([false, true]);
    expect(project(id).project.tasks).toHaveLength(1);
  });

  it('refuses a task identical to one that was already sent', async () => {
    const id = await startedWithTask();
    deliver(id);
    h.fake.enqueue(evaluates('T-1', 'failed', []), toolResponse([{ name: 'dispatch_arena_task', args: TASK }]), ...dispatches({ ...TASK, instructions: `${TASK.instructions} The previous attempt left the tests failing; fix them.` }));
    reply(id, 'T-1', 'I could not get the tests to pass.');
    await settle(id);

    const actions = project(id).conversation.flatMap((e) => e.actions).filter((a) => a.name === 'dispatch_arena_task');
    expect(actions.map((a) => a.ok)).toEqual([true, false, true]);
    expect(actions[1]?.summary).toContain('identical');
    expect(project(id).project.tasks.map((t) => [t.id, t.status])).toEqual([
      ['T-1', 'failed'],
      ['T-2', 'queued'],
    ]);
  });

  it('pauses for the user at the task safety limit, and carries on after "Continue"', async () => {
    h.companion.settings.update({ maxTasksPerSession: 1 });
    const id = await startedWithTask();
    deliver(id);
    h.fake.enqueue(evaluates('T-1'), toolResponse([{ name: 'dispatch_arena_task', args: NEXT_TASK }]), textResponse('The safety limit is reached.'));
    reply(id);
    await settle(id);

    const session = project(id).project.session;
    expect(session.status).toBe('blocked');
    expect(session.blocker?.kind).toBe('task_budget');
    expect(project(id).project.tasks).toHaveLength(1);

    h.fake.enqueue(...dispatches(NEXT_TASK));
    h.companion.orchestrator.controlSession(id, 'resume');
    await settle(id);
    expect(project(id).project.session).toMatchObject({ status: 'running', tasksDispatched: 0 });
    expect(task(id, 'T-2').status).toBe('queued');
  });
});

describe('receiving Arena replies', () => {
  it('records a reply once, for a task that is waiting for one, and starts the review by itself', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    expect(rejection(() => o.recordArenaResponse(id, 'T-1', { dispatchId: null, text: ARENA_REPLY, source: 'auto' })).code).toBe('invalid_state');

    const dispatchId = deliver(id);
    expect(rejection(() => o.recordArenaResponse(id, 'T-1', { dispatchId: 'wrong', text: ARENA_REPLY, source: 'auto' })).code).toBe('stale_dispatch');

    h.fake.enqueue(evaluates('T-1'), ...dispatches(NEXT_TASK));
    const recorded = o.recordArenaResponse(id, 'T-1', { dispatchId, text: ARENA_REPLY, source: 'auto', completion: 'marker' });
    expect(recorded.arenaResponse).toMatchObject({ text: ARENA_REPLY, chars: ARENA_REPLY.length, source: 'auto', completion: 'marker', truncated: false });
    expect(rejection(() => o.recordArenaResponse(id, 'T-1', { dispatchId, text: 'again', source: 'auto' })).code).toBe('response_already_recorded');

    await settle(id);
    expect(task(id).status).toBe('completed');
    expect(task(id).arenaResponse?.text).toBe(ARENA_REPLY);
  });

  it('accepts a reply for a delivery that was never confirmed, because the reply proves it arrived', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    const claim = o.claimDispatch(id, 'T-1');
    o.failDispatch(id, 'T-1', { dispatchId: claim.dispatchId, error: 'No acknowledgement.', submitted: 'unknown' });
    h.fake.enqueue(evaluates('T-1'), ...dispatches(NEXT_TASK));
    o.recordArenaResponse(id, 'T-1', { dispatchId: claim.dispatchId, text: ARENA_REPLY, source: 'auto', completion: 'quiet' });
    expect(task(id).dispatch?.unconfirmed).toBe(false);
    await settle(id);
    expect(task(id).status).toBe('completed');
  });

  it('tells Gemini when a reply may be incomplete', async () => {
    const id = await startedWithTask();
    const dispatchId = deliver(id);
    h.fake.enqueue(evaluates('T-1', 'unclear', []), ...dispatches(NEXT_TASK));
    h.companion.orchestrator.recordArenaResponse(id, 'T-1', { dispatchId, text: 'I started on the form and', source: 'auto', completion: 'stalled' });
    await settle(id);
    expect(requestTexts(2)).toMatch(/may be incomplete|possibly incomplete|did not finish/i);
    expect(task(id).status).toBe('inconclusive');
  });

  it('closes a task Arena never answered as "no reply" — never as done — and lets Gemini decide', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    const dispatchId = deliver(id);
    expect(rejection(() => o.recordNoResponse(id, 'T-1', { dispatchId: 'wrong', reason: 'x' })).code).toBe('stale_dispatch');

    h.fake.enqueue(...dispatches({ ...TASK, title: 'Implement the login form (second try)' }));
    o.recordNoResponse(id, 'T-1', { dispatchId, reason: 'Arena showed the task but wrote nothing for 5 minutes.' });
    await settle(id);

    expect(task(id)).toMatchObject({ status: 'no_response', evaluation: null });
    expect(task(id).closedReason).toContain('wrote nothing');
    expect(requestTexts(2)).toContain('Arena did not reply to task T-1');
    expect(task(id, 'T-2').status).toBe('queued');
    expect(project(id).project.session.status).toBe('running');
  });

  it('stops and asks for help when Arena answers nothing several times in a row', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    for (let n = 1; n <= 3; n += 1) {
      const taskId = `T-${n}`;
      const dispatchId = deliver(id, taskId);
      if (n < 3) h.fake.enqueue(...dispatches({ ...TASK, title: `Attempt ${n + 1}` }));
      o.recordNoResponse(id, taskId, { dispatchId, reason: 'Arena wrote nothing.' });
      await settle(id);
    }
    const session = project(id).project.session;
    expect(session.status).toBe('blocked');
    expect(session.blocker).toMatchObject({ kind: 'arena', title: 'Arena is not answering' });
    expect(project(id).project.tasks.map((t) => t.status)).toEqual(['no_response', 'no_response', 'no_response']);
  });

  it('reports what the relay is doing, and records only real changes as events', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    o.reportRelay(id, 'T-1', { phase: 'waiting_for_arena', message: 'No Arena tab is open.', attention: true, chars: 0 });
    expect(task(id).relay).toMatchObject({ phase: 'waiting_for_arena', attention: true, message: 'No Arena tab is open.' });
    const events = () => project(id).project.timeline.filter((e) => e.title.includes('Arena needs attention')).length;
    expect(events()).toBe(1);
    o.reportRelay(id, 'T-1', { phase: 'waiting_for_arena', message: 'No Arena tab is open.', attention: true, chars: 0 });
    expect(events()).toBe(1);

    const dispatchId = deliver(id);
    o.reportRelay(id, 'T-1', { dispatchId, phase: 'generating', message: 'Arena is writing.', attention: false, chars: 420 });
    expect(task(id).relay).toMatchObject({ phase: 'generating', chars: 420, attention: false });
    // A report about an older delivery attempt is ignored.
    o.reportRelay(id, 'T-1', { dispatchId: 'old', phase: 'stalled', message: 'stale', attention: true, chars: 1 });
    expect(task(id).relay?.phase).toBe('generating');
    expect(rejection(() => o.reportRelay(id, 'T-1', { phase: 'nonsense' as never, message: '', attention: false, chars: 0 })).code).toBe('invalid_request');
  });

  it('notices when the browser extension goes silent, and when it is back', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    const events: CompanionEvent[] = [];
    h.companion.bus.subscribe((e) => events.push(e));

    o.relayWork();
    expect(o.relayLink().online).toBe(true);
    expect(o.checkRelay(Date.now() + 10_000).online).toBe(true);
    expect(o.checkRelay(Date.now() + 60_000).online).toBe(false);
    expect(project(id).project.timeline.some((e) => e.title === 'Browser extension is out of contact')).toBe(true);
    expect(events.some((e) => e.type === 'relay' && !e.relay.online)).toBe(true);

    o.relayWork();
    expect(o.relayLink().online).toBe(true);
    expect(project(id).project.timeline.some((e) => e.title === 'Browser extension is back in contact')).toBe(true);
  });
});

describe('evaluation of Arena results', () => {
  it('forces a structured verdict, grounds it in the real reply, and updates progress', async () => {
    h.fake.enqueue(
      toolResponse([
        { name: 'set_plan', args: { milestones: [{ title: 'Login form' }, { title: 'Sessions' }] } },
        { name: 'dispatch_arena_task', args: TASK },
      ]),
      textResponse('Sent.'),
    );
    const id = start();
    await settle(id);
    deliver(id);

    h.fake.enqueue(
      toolResponse([
        {
          name: 'evaluate_arena_result',
          args: { task_id: 'T-1', verdict: 'complete', summary: 'Tests and build pass.', evidence: ['Ran `npm test`: 14 passed, 0 failed.', 'build completed without errors'], missing: [] },
        },
      ]),
      toolResponse([
        { name: 'update_milestone', args: { milestone_id: 'M-1', status: 'done' } },
        { name: 'dispatch_arena_task', args: NEXT_TASK },
      ]),
      textResponse('The login form is verified.'),
    );
    reply(id);
    await settle(id);

    const evaluationRequest = h.fake.generateRequests[2]?.body;
    // The first evaluation round may call nothing but the evaluation tool.
    expect(evaluationRequest.toolConfig.functionCallingConfig).toMatchObject({ mode: 'ANY', allowedFunctionNames: ['evaluate_arena_result'] });
    const prompt = requestTexts(2);
    expect(prompt).toContain(ARENA_REPLY);
    expect(prompt).toContain('ARENA_RESPONSE_BEGIN');

    const done = task(id);
    expect(done.status).toBe('completed');
    expect(done.evaluation).toMatchObject({ verdict: 'complete', summary: 'Tests and build pass.' });
    expect(done.evaluation?.evidence).toHaveLength(2);
    const view = project(id).project;
    expect(view.milestones[0]?.status).toBe('done');
    expect(view.currentTaskId).toBe('T-2');
  });

  it('refuses a "complete" verdict whose evidence is not in the reply', async () => {
    const id = await startedWithTask();
    deliver(id);
    h.fake.enqueue(
      evaluates('T-1', 'complete', ['All 250 tests passed and the deployment succeeded.']),
      evaluates('T-1', 'partial', ['Ran `npm test`: 14 passed, 0 failed.']),
      ...dispatches(NEXT_TASK),
    );
    reply(id);
    await settle(id);

    const actions = project(id).conversation.flatMap((e) => e.actions).filter((a) => a.name === 'evaluate_arena_result');
    expect(actions.map((a) => a.ok)).toEqual([false, true]);
    expect(actions[0]?.summary).toContain('do not appear');
    expect(task(id).status).toBe('partial');
  });

  it('never marks a task complete without evidence, even if Gemini insists', async () => {
    const id = await startedWithTask();
    deliver(id);
    h.fake.fallback = () => evaluates('T-1', 'complete', []);
    reply(id, 'T-1', 'ok');
    await waitFor(() => project(id).project.session.status === 'blocked', 'the session to hand back control', 5_000);

    expect(task(id).status).toBe('evaluating');
    expect(task(id).evaluation).toBeNull();
    const session = project(id).project.session;
    expect(session.blocker).toMatchObject({ kind: 'coordinator', taskId: 'T-1' });
    // Arena's reply is kept; nothing was lost.
    expect(task(id).arenaResponse?.text).toBe('ok');
  });

  it('cannot evaluate a task that Arena has not answered', async () => {
    h.fake.enqueue(toolResponse([{ name: 'dispatch_arena_task', args: TASK }]), evaluates('T-1'), textResponse('I will wait for Arena.'));
    const id = start();
    await settle(id);
    const action = project(id).conversation.flatMap((e) => e.actions).find((a) => a.name === 'evaluate_arena_result');
    expect(action?.ok).toBe(false);
    expect(action?.summary).toContain('no reply from Arena yet');
    expect(task(id).status).toBe('queued');
  });

  it('retries a review by itself when the Gemini call fails, and keeps the reply meanwhile', async () => {
    const id = await startedWithTask();
    deliver(id);
    const unavailable: ScriptedOrFn = { kind: 'error', status: 503, body: errorBody(503, 'UNAVAILABLE', 'The model is overloaded.') };
    // Three failed requests exhaust one turn (two retries inside the client); the next turn succeeds.
    h.fake.enqueue(unavailable, unavailable, unavailable, evaluates('T-1'), ...dispatches(NEXT_TASK));
    reply(id);
    await waitFor(() => task(id).status === 'completed', 'the review to succeed after a retry', 5_000);
    await settle(id);

    expect(project(id).project.timeline.some((e) => e.title.startsWith('Gemini request failed; retrying'))).toBe(true);
    expect(project(id).project.session.status).toBe('running');
    expect(task(id, 'T-2').status).toBe('queued');
  });

  it('hands back control with the reason when Gemini keeps failing, and resumes exactly there', async () => {
    const id = await startedWithTask();
    deliver(id);
    h.fake.fallback = { kind: 'error', status: 503, body: errorBody(503, 'UNAVAILABLE', 'The model is overloaded.') };
    reply(id);
    await waitFor(() => project(id).project.session.status === 'blocked', 'the session to block', 5_000);

    const session = project(id).project.session;
    expect(session.blocker).toMatchObject({ kind: 'gemini', title: 'Gemini keeps failing', taskId: 'T-1' });
    expect(session.blocker?.detail).toContain('The model is overloaded.');
    expect(task(id).status).toBe('evaluating');

    h.fake.fallback = () => textResponse('OK.');
    h.fake.enqueue(evaluates('T-1'), ...dispatches(NEXT_TASK));
    h.companion.orchestrator.controlSession(id, 'resume');
    await settle(id);
    expect(task(id).status).toBe('completed');
    expect(task(id, 'T-2').status).toBe('queued');
  });

  it('stops at once, without retrying, when the API key is rejected', async () => {
    const id = await startedWithTask();
    deliver(id);
    h.fake.validKeys.clear();
    reply(id);
    await waitFor(() => project(id).project.session.status === 'blocked', 'the session to block', 5_000);
    expect(project(id).project.session.blocker).toMatchObject({ kind: 'gemini', title: 'Gemini cannot be used' });
    expect(h.fake.generateRequests).toHaveLength(3);
  });

  it('only declares the objective complete when verified work and milestones support it', async () => {
    h.fake.enqueue(
      toolResponse([
        { name: 'set_plan', args: { milestones: [{ title: 'Login form' }] } },
        { name: 'mark_objective_complete', args: { summary: 'All done.' } },
        { name: 'dispatch_arena_task', args: TASK },
      ]),
      textResponse('Sent.'),
    );
    const id = start();
    await settle(id);
    let actions = project(id).conversation.flatMap((e) => e.actions).filter((a) => a.name === 'mark_objective_complete');
    expect(actions[0]?.ok).toBe(false);
    expect(project(id).project.status).toBe('active');

    deliver(id);
    h.fake.enqueue(
      evaluates('T-1'),
      toolResponse([{ name: 'mark_objective_complete', args: { summary: 'All done.' } }]),
      toolResponse([
        { name: 'update_milestone', args: { milestone_id: 'M-1', status: 'done' } },
        { name: 'mark_objective_complete', args: { summary: 'The login flow works and is tested.' } },
      ]),
      textResponse('Complete.'),
    );
    reply(id);
    await settle(id);

    actions = project(id).conversation.flatMap((e) => e.actions).filter((a) => a.name === 'mark_objective_complete');
    expect(actions.map((a) => a.ok)).toEqual([false, false, true]);
    expect(actions[1]?.summary).toContain('not done');
    const view = project(id).project;
    expect(view.status).toBe('complete');
    expect(view.completion?.summary).toBe('The login flow works and is tested.');
    expect(view.session.status).toBe('completed');
  });

  it('starts a new session on a completed project when the user asks for more', async () => {
    h.fake.enqueue(toolResponse([{ name: 'dispatch_arena_task', args: TASK }]), textResponse('Sent.'));
    const id = start();
    await settle(id);
    deliver(id);
    h.fake.enqueue(evaluates('T-1'), toolResponse([{ name: 'mark_objective_complete', args: { summary: 'Done.' } }]), textResponse('Complete.'));
    reply(id);
    await settle(id);
    expect(project(id).project.session.status).toBe('completed');

    h.fake.enqueue(...dispatches(NEXT_TASK));
    await say(id, 'Now add sessions as well.');
    const view = project(id).project;
    expect(view.status).toBe('active');
    expect(view.session.status).toBe('running');
    expect(task(id, 'T-2').status).toBe('queued');
  });
});

describe('pause, resume and stop', () => {
  it('holds everything while paused and carries on by itself after resume', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    o.controlSession(id, 'pause');

    expect(project(id).project.session.status).toBe('paused');
    // A queued task is not typed into Arena while paused.
    expect(o.relayWork().items).toEqual([]);
    expect(rejection(() => o.claimDispatch(id, 'T-1')).code).toBe('session_not_running');
    expect(rejection(() => o.sendMessage(id, 'hello')).code).toBe('session_not_running');
    expect(rejection(() => o.controlSession(id, 'pause')).code).toBe('invalid_transition');

    o.controlSession(id, 'resume');
    expect(o.relayWork().items.map((i) => i.task.id)).toEqual(['T-1']);
    deliver(id);
    expect(task(id).status).toBe('awaiting_response');
  });

  it('pausing interrupts a reply that is being streamed', async () => {
    const id = await startedWithTask();
    h.fake.enqueue(textResponse('A long answer that will be interrupted before it finishes.', { pieces: 8, chunkDelayMs: 40 }));
    const turn = h.companion.orchestrator.sendMessage(id, 'Explain the plan.');
    await waitFor(() => (project(id).conversation.at(-1)?.text.length ?? 0) > 0, 'the reply to start streaming');
    h.companion.orchestrator.controlSession(id, 'pause');
    await turn.done;
    await settle(id);

    const last = project(id).conversation.at(-1);
    expect(last).toMatchObject({ role: 'coordinator', status: 'interrupted' });
    expect(project(id).project.session.status).toBe('paused');
  });

  it('keeps following a task Arena already has while paused, holds the reply, and reviews it on resume', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    deliver(id);
    o.controlSession(id, 'pause');

    // The extension still gets the task so the reply is not missed.
    expect(o.relayWork().items.map((i) => i.task.id)).toEqual(['T-1']);
    const requests = h.fake.generateRequests.length;
    reply(id);
    await settle(id);
    expect(task(id).status).toBe('evaluating');
    expect(h.fake.generateRequests).toHaveLength(requests);

    h.fake.enqueue(evaluates('T-1'), ...dispatches(NEXT_TASK));
    o.controlSession(id, 'resume');
    await settle(id);
    expect(task(id).status).toBe('completed');
    expect(task(id, 'T-2').status).toBe('queued');
  });

  it('re-runs a review that was interrupted by a pause', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    deliver(id);
    h.fake.enqueue({ kind: 'hang' });
    reply(id);
    await waitFor(() => o.turnState(id).active, 'the review to start');
    o.controlSession(id, 'pause');
    await settle(id);
    expect(task(id)).toMatchObject({ status: 'evaluating', evaluationError: null });

    h.fake.enqueue(evaluates('T-1'), ...dispatches(NEXT_TASK));
    o.controlSession(id, 'resume');
    await settle(id);
    expect(task(id).status).toBe('completed');
  });

  it('stop ends the session, cancels the open task and ignores a late Arena reply', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    const dispatchId = deliver(id);
    o.controlSession(id, 'stop');

    expect(project(id).project.session.status).toBe('stopped');
    expect(task(id)).toMatchObject({ status: 'cancelled', closedReason: 'The session was stopped.' });
    expect(o.relayWork().items).toEqual([]);
    expect(rejection(() => o.recordArenaResponse(id, 'T-1', { dispatchId, text: ARENA_REPLY, source: 'auto' })).code).toBe('invalid_state');
    const requests = h.fake.generateRequests.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.fake.generateRequests).toHaveLength(requests);

    // A message starts a new session, and Gemini is told what happened.
    h.fake.enqueue(...dispatches(NEXT_TASK));
    await say(id, 'Start again with sessions.');
    expect(project(id).project.session.status).toBe('running');
    expect(requestTexts(2)).toContain('stopped the session');
  });

  it('stopping a single reply pauses the session, since a running session would simply go on', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    h.fake.enqueue(textResponse('A long answer that the user stops.', { pieces: 6, chunkDelayMs: 40 }));
    const turn = o.sendMessage(id, 'Explain.');
    await waitFor(() => (project(id).conversation.at(-1)?.text.length ?? 0) > 0, 'the reply to start streaming');
    expect(o.cancelTurn(id)).toEqual({ cancelled: true });
    await turn.done;
    expect(project(id).conversation.at(-1)?.status).toBe('interrupted');
    expect(project(id).project.session.status).toBe('paused');
    expect(o.cancelTurn(id)).toEqual({ cancelled: false });
  });

  it('lets the user cancel the open task; Gemini is told and picks another next step', async () => {
    const id = await startedWithTask();
    const o = h.companion.orchestrator;
    deliver(id);
    h.fake.enqueue(...dispatches(NEXT_TASK));
    o.cancelTask(id, 'T-1');
    await settle(id);

    expect(task(id)).toMatchObject({ status: 'cancelled', closedReason: 'Cancelled by the user.' });
    expect(requestTexts(2)).toContain('cancelled task T-1');
    expect(task(id, 'T-2').status).toBe('queued');
    expect(rejection(() => o.cancelTask(id, 'T-1')).code).toBe('invalid_state');
  });
});
