import { randomBytes } from 'node:crypto';
import { excerpt, truncateMiddle } from '../../shared/text.js';
import type { ArenaTask, CompanionSettings, Project, WireContent } from '../../shared/types.js';
import { GeminiError } from '../gemini/errors.js';
import type { GeminiService } from '../gemini/geminiService.js';
import type { Logger } from '../logger.js';
import { addEvent } from '../memory/projectModel.js';

const MAX_SUMMARY_CHARS = 12_000;
const MAX_SUMMARY_INPUT_CHARS = 300_000;

export function transcriptChars(contents: WireContent[]): number {
  let total = 0;
  for (const content of contents) {
    for (const part of content.parts) {
      if (part.text) total += part.text.length;
      if (part.functionCall) total += JSON.stringify(part.functionCall.args ?? {}).length + 40;
      if (part.functionResponse) total += JSON.stringify(part.functionResponse.response ?? {}).length + 40;
      if (part.thoughtSignature) total += part.thoughtSignature.length;
    }
  }
  return total;
}

function renderForSummary(contents: WireContent[]): string {
  const lines: string[] = [];
  for (const content of contents) {
    for (const part of content.parts) {
      if (part.thought) continue;
      if (part.text) lines.push(`${content.role === 'user' ? 'USER' : 'COORDINATOR'}: ${part.text}`);
      if (part.functionCall) lines.push(`COORDINATOR ACTION: ${part.functionCall.name}(${excerpt(JSON.stringify(part.functionCall.args ?? {}), 1500)})`);
      if (part.functionResponse) lines.push(`ACTION RESULT: ${excerpt(JSON.stringify(part.functionResponse.response ?? {}), 600)}`);
    }
  }
  return lines.join('\n\n');
}

const SUMMARY_INSTRUCTION = `You compress the older part of a conversation between a user and an engineering coordinator so the coordinator can keep working without it.

Write a factual summary that preserves: what the user asked for and prefers, requirements and constraints stated in conversation, conclusions reached, open questions, and anything promised to the user. Structured project facts (milestones, tasks, decisions, issues) are stored separately, so mention them only when the conversation adds nuance.

Use plain prose or short bullet points. Do not invent anything. Do not address the reader.`;

/**
 * Finds how many leading contents can be folded away so that the remainder
 * fits the target, cutting only at the start of a turn and never touching the
 * most recent turn.
 */
export function findCompactionCut(contents: WireContent[], targetChars: number): number {
  const boundaries: number[] = [];
  contents.forEach((content, index) => {
    if (index > 0 && content.turnStart) boundaries.push(index);
  });
  if (boundaries.length === 0) return 0;
  let cut = 0;
  for (const boundary of boundaries) {
    cut = boundary;
    if (transcriptChars(contents.slice(boundary)) <= targetChars) break;
  }
  return cut;
}

export interface CompactionResult {
  compacted: boolean;
  removedContents: number;
  summarised: boolean;
}

/**
 * Context management: when the model-facing transcript outgrows its budget,
 * the oldest turns are summarised by Gemini into `contextSummary` and dropped.
 * Durable project memory is unaffected — it is stored separately and injected
 * into every request.
 */
export async function compactTranscript(
  project: Project,
  gemini: GeminiService,
  settings: CompanionSettings,
  logger: Logger,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  if (transcriptChars(project.transcript) <= settings.contextBudgetChars) {
    return { compacted: false, removedContents: 0, summarised: false };
  }
  const cut = findCompactionCut(project.transcript, Math.floor(settings.contextBudgetChars / 2));
  if (cut <= 0) return { compacted: false, removedContents: 0, summarised: false };

  const removed = project.transcript.slice(0, cut);
  const rendered = truncateMiddle(renderForSummary(removed), MAX_SUMMARY_INPUT_CHARS).text;
  const prompt = [
    project.contextSummary.trim() ? `Existing summary of even earlier conversation:\n${project.contextSummary.trim()}` : '',
    `Conversation to fold into the summary:\n${rendered}`,
    'Write the updated summary now.',
  ]
    .filter(Boolean)
    .join('\n\n');

  let summarised = false;
  try {
    const result = await gemini.generate({
      systemInstruction: SUMMARY_INSTRUCTION,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(signal ? { signal } : {}),
    });
    project.contextSummary = result.text.trim().slice(0, MAX_SUMMARY_CHARS);
    summarised = true;
  } catch (error) {
    if (error instanceof GeminiError && error.kind === 'aborted') throw error;
    // Could not summarise: still drop the old turns so the conversation can continue, and say so in the summary.
    logger.warn('Context compaction could not summarise older turns:', error);
    const note = `[${removed.length} older conversation items were dropped without a summary because summarisation failed.]`;
    project.contextSummary = [project.contextSummary.trim(), note].filter(Boolean).join('\n').slice(-MAX_SUMMARY_CHARS);
  }
  project.transcript = project.transcript.slice(cut);
  addEvent(
    project,
    'gemini',
    summarised ? 'info' : 'warning',
    'Conversation context compacted',
    summarised
      ? `${removed.length} older items were summarised to stay within the context budget. Project memory is unchanged.`
      : `${removed.length} older items were dropped; summarising them failed. Project memory is unchanged.`,
  );
  return { compacted: true, removedContents: removed.length, summarised };
}

const SOURCE_LABEL = {
  auto: 'read automatically from the Arena tab',
  manual_capture: 'captured from the Arena tab by the user',
  pasted: 'pasted in by the user',
} as const;

const COMPLETION_LABEL = {
  marker: 'Arena closed its report with the completion line it was asked for, so the reply is complete.',
  quiet:
    'Arena stopped working and the reply stopped changing, but it did NOT end with the completion line it was asked for. Arena may have stopped early or may be waiting for an answer; check the end of the reply.',
  stalled:
    'The Arena page still showed a working indicator, but the reply had not changed for a long time, so AgentLink collected what was there. The reply MAY BE INCOMPLETE.',
  manual: 'The user supplied this reply; AgentLink did not observe Arena finishing.',
} as const;

/**
 * Builds the model-facing message that hands Arena's reply to the coordinator.
 * The reply is wrapped in markers carrying a random nonce, so text inside the
 * reply cannot fake the end of the quoted block.
 */
export function buildEvaluationPrompt(task: ArenaTask, settings: CompanionSettings): string {
  const response = task.arenaResponse;
  if (!response) throw new Error(`Task ${task.id} has no Arena response.`);
  const nonce = randomBytes(6).toString('hex');
  const shown = truncateMiddle(response.text, settings.arenaResponseContextChars);
  const notes = [
    `Source: ${SOURCE_LABEL[response.source]}.`,
    `Length: ${response.chars.toLocaleString('en-US')} characters.`,
    COMPLETION_LABEL[response.completion] ?? '',
    response.truncated ? 'AgentLink stored only the first part of a longer reply.' : '',
    shown.truncated ? 'The middle of the reply is omitted below to save context; the omission is marked.' : '',
  ].filter(Boolean);
  return [
    `[AgentLink] Arena has replied to task ${task.id} "${task.title}".`,
    notes.join(' '),
    `<<<ARENA_RESPONSE_BEGIN ${nonce}>>>\n${shown.text}\n<<<ARENA_RESPONSE_END ${nonce}>>>`,
    `Evaluate this reply against the acceptance criteria of ${task.id} by calling evaluate_arena_result. Then update the project memory where needed and, in this same turn, either send the next task with dispatch_arena_task, call mark_objective_complete if the whole objective is now demonstrated, or call request_user_input if there is a genuine blocker. Do not ask the user for approval. Close with a short note of what you found and what happens next.`,
  ].join('\n\n');
}

/** The first turn of a session: the objective is all the coordinator gets. */
export function buildKickoffPrompt(project: Project): string {
  const resumed = project.tasks.length > 0 || project.milestones.length > 0;
  return [
    resumed
      ? '[AgentLink] The session has been started again. PROJECT MEMORY shows where the work stands.'
      : `[AgentLink] The user has set this objective and started the session:\n\n${project.objective}`,
    resumed
      ? 'Continue autonomously from the recorded state: send the next task with dispatch_arena_task, or call mark_objective_complete if the objective is already demonstrated.'
      : 'Work autonomously from here. Set the plan with set_plan, then send the first task to Arena with dispatch_arena_task in this same turn. Do not ask the user to approve the plan or the task. Call request_user_input only if the objective cannot be started without information that only the user has.',
  ].join('\n\n');
}

/** Sent when a coordinator turn ended with nothing left in motion. */
export function buildContinuePrompt(project: Project, reason: 'idle' | 'failure' | 'resume'): string {
  const lead =
    reason === 'failure'
      ? '[AgentLink] Your previous turn did not finish because the request to Gemini failed. It is being repeated.'
      : reason === 'resume'
        ? '[AgentLink] The session is running again.'
        : '[AgentLink] Your last turn ended with no task on its way to Arena, the objective is not marked complete, and you did not call request_user_input. The project is standing still.';
  const unfinished = project.milestones.filter((m) => m.status !== 'done');
  const state = unfinished.length ? `Unfinished milestones: ${unfinished.map((m) => `${m.id} "${m.title}"`).join(', ')}.` : project.milestones.length ? 'Every milestone is marked done.' : 'No plan has been set yet.';
  return [
    lead,
    state,
    'Continue now: send the next task with dispatch_arena_task (set the plan first if there is none), or call mark_objective_complete if evaluated replies demonstrate the whole objective. If, and only if, you cannot continue without information or authorisation from the user, call request_user_input with one specific question.',
  ].join('\n\n');
}

/** Arena received a task and never produced a reply. */
export function buildNoResponsePrompt(task: ArenaTask, reason: string): string {
  return [
    `[AgentLink] Arena did not reply to task ${task.id} "${task.title}".`,
    reason,
    'The task is closed as "no reply"; nothing is known about whether any of its work happened. Decide what to do: you may send the same task again, send a smaller or differently worded one, or first send a task that asks Arena to report the current state. If Arena has now failed to answer repeatedly, call request_user_input and say so.',
  ].join('\n\n');
}
