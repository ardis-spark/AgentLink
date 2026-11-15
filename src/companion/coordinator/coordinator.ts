import type { CompanionSettings, ConversationEntry, Project, TokenUsage, TurnState, WireContent, WirePart } from '../../shared/types.js';
import { GeminiError } from '../gemini/errors.js';
import type { GeminiService, ToolMode } from '../gemini/geminiService.js';
import type { Logger } from '../logger.js';
import { addEntry, addEvent, findTask, nowIso } from '../memory/projectModel.js';
import { compactTranscript } from './context.js';
import { buildSystemInstruction } from './systemPrompt.js';
import { COORDINATOR_TOOLS, EVALUATION_TOOL, executeTool, type ToolContext } from './tools.js';

/** `continue` turns are started by AgentLink itself: the kickoff, reminders, and reports such as "Arena did not reply". */
export type TurnKind = 'user' | 'evaluation' | 'continue';

export interface TurnInput {
  kind: TurnKind;
  /** Model-facing text of the turn (for a user turn, exactly what the user wrote). */
  text: string;
  /** Task under evaluation or discussion, when the turn concerns one. */
  taskId: string | null;
}

export interface TurnHooks {
  /** Persist the project (called at every durable step, not per streamed chunk). */
  save: () => void;
  onEntry: (entry: ConversationEntry) => void;
  onDelta: (entryId: string, text: string) => void;
  onPhase: (phase: TurnState['phase'], retry?: TurnState['retry']) => void;
  /** Project memory changed (a tool ran). */
  onProjectChanged: () => void;
}

export interface TurnOutcome {
  entry: ConversationEntry;
  status: 'complete' | 'interrupted' | 'error';
  error: GeminiError | null;
}

/** Forced evaluation attempts before the model is allowed to answer freely. */
const MAX_FORCED_EVALUATIONS = 3;

function addUsage(total: TokenUsage | null, add: TokenUsage | null): TokenUsage | null {
  if (!add) return total;
  if (!total) return { ...add };
  return {
    promptTokens: total.promptTokens + add.promptTokens,
    outputTokens: total.outputTokens + add.outputTokens,
    totalTokens: total.totalTokens + add.totalTokens,
  };
}

/**
 * Runs coordinator turns: one user/app message in, then a bounded loop of
 * "Gemini responds → tools are applied → results go back" until Gemini
 * answers in plain text.
 *
 * The transcript invariant kept here is that every persisted state is a valid
 * API history: it ends either with a user-role content awaiting the model, or
 * with a model text content. An interrupted turn is closed with whatever text
 * had been streamed.
 */
export class Coordinator {
  constructor(
    private readonly gemini: GeminiService,
    private readonly getSettings: () => CompanionSettings,
    private readonly scrub: (text: string) => string,
    private readonly logger: Logger,
  ) {}

  async runTurn(project: Project, input: TurnInput, hooks: TurnHooks, signal: AbortSignal): Promise<TurnOutcome> {
    const settings = this.getSettings();
    const entry = addEntry(project, 'coordinator', 'message', '', { status: 'streaming', taskId: input.taskId, model: settings.model });
    project.activeTurn = { entryId: entry.id, startedAt: nowIso() };
    hooks.save();
    hooks.onEntry(entry);

    let usage: TokenUsage | null = null;
    let failure: GeminiError | null = null;
    let userContentAdded = false;

    try {
      hooks.onPhase('compacting');
      const compaction = await compactTranscript(project, this.gemini, settings, this.logger, signal);
      if (compaction.compacted) {
        hooks.save();
        hooks.onProjectChanged();
      }

      project.transcript.push({ role: 'user', parts: [{ text: input.text }], turnStart: true });
      userContentAdded = true;
      hooks.save();

      const toolContext: ToolContext = { settings, model: settings.model, scrub: this.scrub };
      let forcedEvaluations = 0;

      // `maxToolRounds` rounds may call tools; one extra round without tools lets Gemini wrap up in text.
      for (let round = 1; round <= settings.maxToolRounds + 1; round++) {
        const lastRound = round === settings.maxToolRounds + 1;
        const evaluating = input.kind === 'evaluation' && input.taskId ? findTask(project, input.taskId) : null;
        const mustEvaluate = Boolean(evaluating && evaluating.status === 'evaluating' && !lastRound && forcedEvaluations < MAX_FORCED_EVALUATIONS);

        let toolMode: ToolMode = { mode: 'AUTO' };
        if (lastRound) toolMode = { mode: 'NONE' };
        else if (mustEvaluate) {
          toolMode = { mode: 'ANY', allowedFunctionNames: [EVALUATION_TOOL] };
          forcedEvaluations += 1;
        }

        hooks.onPhase('waiting');
        let separatorPending = entry.text.length > 0;
        const result = await this.gemini.generate({
          systemInstruction: buildSystemInstruction(project),
          contents: project.transcript,
          tools: COORDINATOR_TOOLS,
          toolMode,
          signal,
          allowEmpty: round > 1,
          onDelta: (text) => {
            const chunk = separatorPending ? `\n\n${text}` : text;
            separatorPending = false;
            entry.text += chunk;
            hooks.onPhase('streaming');
            hooks.onDelta(entry.id, chunk);
          },
          onRetry: (notice) => {
            hooks.onPhase('retrying', {
              attempt: notice.attempt,
              maxAttempts: notice.maxAttempts,
              delayMs: notice.delayMs,
              reason: notice.error.message,
            });
          },
        });
        usage = addUsage(usage, result.usage);

        const modelParts: WirePart[] = result.parts.length > 0 ? result.parts : [{ text: '' }];
        const modelContent: WireContent = { role: 'model', parts: modelParts, model: result.model };

        if (result.functionCalls.length === 0) {
          if (result.finishReason === 'MAX_TOKENS') {
            entry.text += '\n\n_(The reply was cut off at the output limit.)_';
          }
          // A turn must end on non-empty model text so the next request is a valid history.
          if (!modelParts.some((p) => p.text && !p.thought)) modelParts.push({ text: entry.text ? '(done)' : '(no reply)' });
          project.transcript.push(modelContent);
          break;
        }

        // Apply the tools, then record the call and its results together so the history is never left dangling.
        hooks.onPhase('tools');
        const responses: WirePart[] = [];
        for (const call of result.functionCalls) {
          const outcome = executeTool(project, call.name, call.args, toolContext);
          entry.actions.push(outcome.action);
          responses.push({
            functionResponse: { ...(call.id !== undefined ? { id: call.id } : {}), name: call.name, response: outcome.response },
          });
        }
        project.transcript.push(modelContent, { role: 'user', parts: responses });
        hooks.save();
        hooks.onProjectChanged();
        hooks.onEntry(entry);
      }
    } catch (error) {
      failure = error instanceof GeminiError ? error : new GeminiError('unknown', error instanceof Error ? error.message : String(error), { cause: error });
      if (failure.kind !== 'aborted') this.logger.warn(`Coordinator turn failed (${failure.kind}):`, failure.message);
    }

    // The user's side of the turn must reach the model-facing history even if the turn failed early.
    if (!userContentAdded) {
      project.transcript.push({ role: 'user', parts: [{ text: input.text }], turnStart: true });
    }
    // Close the history: if it still ends on a user-role content, the model's side of the turn is missing.
    const last = project.transcript[project.transcript.length - 1];
    if (last && last.role === 'user') {
      let closing = entry.text.trim() ? entry.text : '(done)';
      if (!entry.text.trim() && failure) {
        closing =
          failure.kind === 'aborted'
            ? '(The reply was interrupted before any text was produced.)'
            : '(No reply was produced because the request failed.)';
      }
      project.transcript.push({ role: 'model', parts: [{ text: closing }] });
    }

    entry.usage = usage;
    if (!failure) {
      entry.status = 'complete';
    } else if (failure.kind === 'aborted') {
      entry.status = 'interrupted';
      entry.error = 'Interrupted.';
    } else {
      entry.status = 'error';
      entry.error = failure.message;
      addEvent(project, 'error', 'error', 'Gemini request failed', failure.message, input.taskId);
    }
    project.activeTurn = null;
    hooks.save();
    hooks.onEntry(entry);
    hooks.onPhase('idle');
    return { entry, status: entry.status as TurnOutcome['status'], error: failure };
  }
}
