import type { UiRequest, UiResult } from '../../shared/messages.js';

/** Asks the background script to do something with Arena tabs and unwraps its answer. */
export async function askBackground<T>(request: UiRequest): Promise<T> {
  let result: UiResult<T> | undefined;
  try {
    result = (await browser.runtime.sendMessage(request)) as UiResult<T> | undefined;
  } catch {
    throw new Error('The AgentLink background script is not responding. Reload the extension.');
  }
  if (!result) throw new Error('The AgentLink background script gave no answer. Reload the extension.');
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
