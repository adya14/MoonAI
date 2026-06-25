// llmConfig.js
// Central LangChain model setup for MoonAI.
// All LLM reasoning goes through DeepSeek via OpenRouter (OpenAI-compatible API),
// wrapped in LangChain's ChatOpenAI. When LANGSMITH_TRACING=true, every .invoke()
// here is automatically traced to LangSmith — no extra code needed at call sites.
require('dotenv').config();

const { ChatOpenAI } = require('@langchain/openai');
const {
  SystemMessage,
  HumanMessage,
  AIMessage,
} = require('@langchain/core/messages');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEEPSEEK_MODEL = 'deepseek/deepseek-chat';

/**
 * Build a LangChain ChatOpenAI instance pointed at OpenRouter/DeepSeek.
 * @param {object} [opts]
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.timeout=15000]
 * @returns {ChatOpenAI}
 */
function createChatModel({ temperature = 0.7, timeout = 15000 } = {}) {
  if (!process.env.DEEPSEEK_API) {
    // Surface the same warning the old code did, but defer hard-failure to call time.
    console.warn('Warning: DEEPSEEK_API key not found. LLM calls will fail.');
  }
  return new ChatOpenAI({
    model: DEEPSEEK_MODEL,
    temperature,
    apiKey: process.env.DEEPSEEK_API,
    timeout,
    maxRetries: 2,
    configuration: {
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://moonai.app',
        'X-Title': 'AI Interview Bot',
      },
    },
  });
}

/**
 * Convert the app's `{ role, content }` history (OpenAI-style) into LangChain
 * message objects. Roles: system | user/human | assistant/ai.
 * @param {Array<{role: string, content: string}>} history
 * @returns {Array}
 */
function toLangChainMessages(history = []) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && typeof m.content === 'string')
    .map((m) => {
      switch (m.role) {
        case 'system':
          return new SystemMessage(m.content);
        case 'assistant':
        case 'ai':
          return new AIMessage(m.content);
        case 'user':
        case 'human':
        default:
          return new HumanMessage(m.content);
      }
    });
}

module.exports = {
  createChatModel,
  toLangChainMessages,
  DEEPSEEK_MODEL,
  OPENROUTER_BASE_URL,
};
