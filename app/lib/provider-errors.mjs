export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

const messages = Object.freeze({
  CHATGPT_USAGE_LIMIT: 'Your ChatGPT plan or Nemo usage limit has been reached. Review usage in ChatGPT settings. Your conversation is saved.',
  CHATGPT_SIGN_IN_REQUIRED: 'Reconnect your ChatGPT account in Nemo on your computer. Your conversation is saved.',
  CHATGPT_NOT_ELIGIBLE: 'This ChatGPT account cannot use its plan with Nemo. Choose an eligible account in Nemo on your computer.',
  CHATGPT_UNAVAILABLE: 'Your ChatGPT connection is temporarily unavailable. Try again later. Your conversation is saved.',
});

// The public app receives fixed recovery instructions, never token endpoint or
// inference diagnostics, account identifiers, or a provider-supplied URL.
export function publicChatGPTError(error) {
  const code = typeof error === 'string' ? error : error?.code;
  if (!Object.hasOwn(messages, code)) return null;
  return { error: messages[code], errorCode: code, ...(code === 'CHATGPT_USAGE_LIMIT' ? { manageUsageUrl: CHATGPT_USAGE_URL } : {}) };
}

export function publicPlanUsage(status) {
  if (status?.inferenceProvider === 'ollama') return { inference: { provider: 'ollama', localOnly: true, model: 'gemma4:12b' } };
  if (status?.inferenceProvider !== 'chatgpt') return {};
  return { planUsage: { provider: 'chatgpt', enabled: status.planUsageEnabled === true, manageUsageUrl: CHATGPT_USAGE_URL } };
}
