import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { ToneConsistencyMetric } from '@mastra/evals/nlp';
import { PromptAlignmentMetric } from '@mastra/evals/llm';

const llm = openai('gpt-4o-mini');

const refineSystemPrompt = `
口コミの返信文をスタイルガイドに従って改善してください。
返信対象の口コミ、口コミが寄せられたブランドおよび店舗名を提供するので、必要に応じて使用してください。
改善後の返信文のみ出力し、余計なテキストや記号は含めないこと。
`;

const instructionList = [
  '投稿者、経営者、従業員など人名を記載しないこと',
  '「〜店より」のような署名を記載しないこと',
  '返信文は端的で読みやすい形式にすること',
  '適切な改行を入れること',
  '指定の言語で返信を作成すること'
];

export const replyRefinerAgent = new Agent({
  name: 'reply-refiner-agent',
  model: llm,
  instructions: refineSystemPrompt,
  evals: {
    toneConsistency: new ToneConsistencyMetric(),
    promptAlignment: new PromptAlignmentMetric(llm, {
      instructions: instructionList
    }),
  },
});
