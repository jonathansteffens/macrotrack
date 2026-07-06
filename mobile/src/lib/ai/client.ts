import Anthropic from '@anthropic-ai/sdk';

import { getApiKey } from './config';

/** Shared Anthropic client construction + error mapping for both engines. */

export async function makeClient(): Promise<Anthropic | null> {
  const apiKey = await getApiKey();
  if (!apiKey) return null;
  return new Anthropic({
    apiKey,
    // Intentional: personal app, user-supplied key stored on their own device
    dangerouslyAllowBrowser: true,
    maxRetries: 1,
    timeout: 90_000,
  });
}

export const NO_KEY_MESSAGE = 'Add your Anthropic API key in Settings to use AI logging.';

export function describeError(e: unknown): { message: string; needsKey?: boolean } {
  if (e instanceof Anthropic.AuthenticationError) {
    return { message: 'Your API key was rejected — check it in Settings.', needsKey: true };
  }
  if (e instanceof Anthropic.RateLimitError) {
    return { message: 'Rate limited — wait a moment and try again.' };
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return { message: 'Network error — check your connection and try again.' };
  }
  if (e instanceof Anthropic.APIError) {
    return { message: `API error (${e.status}): ${e.message}` };
  }
  if (e instanceof SyntaxError) {
    return { message: 'Could not parse the model response. Please try again.' };
  }
  return { message: 'Something went wrong. Please try again.' };
}
