// interviewGraph.js
// The interview phase machine, modeled as a LangGraph StateGraph.
//
// Each Twilio webhook (/continue-interview) drives exactly ONE user->AI turn, so the
// graph is designed to run a single transition per invocation:
//
//   START --(route by current phase)--> [phase node] --> END
//
// A MemorySaver checkpointer keyed by callSid (thread_id) persists graph state per call
// and gives LangSmith a clean per-call trace tree. server.js remains the canonical store
// for `history` (used later for scoring/transcript), so it passes the current history in
// on every turn and reads the produced aiResponse/nextPhase back out — no divergence.
//
// Phase transitions are a 1:1 port of the original switch statement in server.js.

const { StateGraph, Annotation, MemorySaver, START, END } = require('@langchain/langgraph');
const { getAiResponse, getQnAResponse } = require('./interview');

// ---------------------------------------------------------------------------
// Graph state. All channels use last-value-wins (the default reducer), because
// server.js passes the full current state in on each turn.
// ---------------------------------------------------------------------------
const InterviewState = Annotation.Root({
  history: Annotation({ default: () => [] }),
  phase: Annotation({ default: () => 'introduction' }),
  jobRole: Annotation({ default: () => '' }),
  jobDescription: Annotation({ default: () => '' }),
  // Outputs produced by a node this turn:
  aiResponse: Annotation({ default: () => '' }),
  shouldHangup: Annotation({ default: () => false }),
});

// Small helper: race an async fn against a fallback string after `ms`.
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// ---------------------------------------------------------------------------
// Nodes — one per phase. Each returns { aiResponse, phase (the NEXT phase),
// shouldHangup }. Nodes do NOT append to history; server.js logs the assistant
// turn into its canonical history after invoking the graph.
// ---------------------------------------------------------------------------

async function introductionNode(state) {
  const aiResponse = await getAiResponse(
    "Ask the first technical question, considering the user's introduction if relevant.",
    state.jobRole,
    state.jobDescription,
    false,
    state.history
  );
  return { aiResponse, phase: 'question1', shouldHangup: false };
}

async function question1Node(state) {
  const aiResponse = await getAiResponse(
    'Ask the second technical question, considering the previous question and answer.',
    state.jobRole,
    state.jobDescription,
    false,
    state.history
  );
  return { aiResponse, phase: 'question2', shouldHangup: false };
}

async function question2Node() {
  const aiResponse =
    "Thank you for answering my questions. Now, do you have any questions for me about the role or the company? Feel free to ask, or you can say 'no questions'.";
  return { aiResponse, phase: 'qna_listen', shouldHangup: false };
}

async function qnaListenNode(state) {
  const lastUserMessage = state.history[state.history.length - 1];
  const hasQuestion =
    lastUserMessage &&
    lastUserMessage.role === 'user' &&
    lastUserMessage.content.trim() !== '' &&
    !/^(no|nope|no questions?|nothing|i'm good|i am good)$/i.test(lastUserMessage.content.trim());

  if (hasQuestion) {
    const qnaAnswer = await withTimeout(
      getQnAResponse(lastUserMessage.content, state.history.slice(0, -1)),
      8000,
      "That's a good question. While I don't have the specific details right now, I'll make sure to pass it along to the team."
    );
    return {
      aiResponse: `${qnaAnswer} Was there anything else you wanted to ask?`,
      phase: 'qna_followup',
      shouldHangup: false,
    };
  }
  return {
    aiResponse:
      'Okay, thank you for confirming. This concludes our initial interview. We appreciate your time today and will be in touch regarding the next steps. Goodbye!',
    phase: 'ending',
    shouldHangup: true,
  };
}

async function qnaFollowupNode(state) {
  const lastFollowupMessage = state.history[state.history.length - 1];
  const hasFollowupQuestion =
    lastFollowupMessage &&
    lastFollowupMessage.role === 'user' &&
    lastFollowupMessage.content.trim() !== '' &&
    !/^(no|nope|no more|that's all|i'm good|i am good|that helps|thank you)$/i.test(
      lastFollowupMessage.content.trim()
    );

  if (hasFollowupQuestion) {
    const followupAnswer = await withTimeout(
      getQnAResponse(lastFollowupMessage.content, state.history.slice(0, -1)),
      8000,
      "Thanks for the additional question. I've noted that one down as well."
    );
    return {
      aiResponse: `${followupAnswer} Anything else?`,
      phase: 'qna_followup',
      shouldHangup: false,
    };
  }
  return {
    aiResponse:
      "Great. Thank you again for your time and interest! We'll be in touch soon. Have a great day. Goodbye!",
    phase: 'ending',
    shouldHangup: true,
  };
}

// Route from START to the node for the current phase. Terminal/unknown -> END (no-op turn).
function routeByPhase(state) {
  switch (state.phase) {
    case 'introduction':
      return 'introduction';
    case 'question1':
      return 'question1';
    case 'question2':
      return 'question2';
    case 'qna_listen':
      return 'qna_listen';
    case 'qna_followup':
      return 'qna_followup';
    default:
      return END;
  }
}

const workflow = new StateGraph(InterviewState)
  .addNode('introduction', introductionNode)
  .addNode('question1', question1Node)
  .addNode('question2', question2Node)
  .addNode('qna_listen', qnaListenNode)
  .addNode('qna_followup', qnaFollowupNode)
  .addConditionalEdges(START, routeByPhase, {
    introduction: 'introduction',
    question1: 'question1',
    question2: 'question2',
    qna_listen: 'qna_listen',
    qna_followup: 'qna_followup',
    [END]: END,
  })
  .addEdge('introduction', END)
  .addEdge('question1', END)
  .addEdge('question2', END)
  .addEdge('qna_listen', END)
  .addEdge('qna_followup', END);

const interviewApp = workflow.compile({ checkpointer: new MemorySaver() });

/**
 * Run exactly one interview turn through the graph.
 * @param {string} callSid - used as the LangGraph thread_id (per-call state/trace).
 * @param {{history: Array, phase: string, jobRole: string, jobDescription: string}} current
 * @returns {Promise<{aiResponse: string, nextPhase: string, shouldHangup: boolean}>}
 */
async function runInterviewTurn(callSid, current) {
  const result = await interviewApp.invoke(
    {
      history: current.history || [],
      phase: current.phase,
      jobRole: current.jobRole || '',
      jobDescription: current.jobDescription || '',
    },
    { configurable: { thread_id: callSid } }
  );
  return {
    aiResponse: result.aiResponse || '',
    nextPhase: result.phase,
    shouldHangup: !!result.shouldHangup,
  };
}

module.exports = { runInterviewTurn, interviewApp };
