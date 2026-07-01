// llmConfig.js — Central LangChain model setup for MoonAI (AWS Bedrock).
require('dotenv').config();

const { ChatBedrockConverse } = require('@langchain/aws');
const {
  SystemMessage, HumanMessage, AIMessage,
} = require('@langchain/core/messages');

// Cheapest option: Amazon Nova Micro. For better reasoning, swap to Claude Haiku:
//   'us.anthropic.claude-3-5-haiku-20241022-v1:0'   (needs cross-region inference profile enabled)
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || 'amazon.nova-micro-v1:0';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

function createChatModel({ temperature = 0.7, timeout = 15000 } = {}) {
  return new ChatBedrockConverse({
    model: BEDROCK_MODEL,
    region: AWS_REGION,
    temperature,
    maxRetries: 2,
    // On EC2: do NOT set keys here. The instance's IAM role supplies credentials automatically.
    // Locally: it reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from your env.
  });
}

function toLangChainMessages(history = []) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && typeof m.content === 'string')
    .map((m) => {
      switch (m.role) {
        case 'system': return new SystemMessage(m.content);
        case 'assistant':
        case 'ai': return new AIMessage(m.content);
        default: return new HumanMessage(m.content);
      }
    });
}

module.exports = { createChatModel, toLangChainMessages, BEDROCK_MODEL, AWS_REGION };