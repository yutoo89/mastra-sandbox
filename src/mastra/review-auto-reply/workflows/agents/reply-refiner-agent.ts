import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';

const llm = openai('gpt-4o-mini');

const refineSystemPrompt = `
口コミの返信文をスタイルガイドに従って改善してください。
返信対象の口コミ、口コミが寄せられたブランドおよび店舗名を提供するので、必要に応じて使用してください。
改善後の返信文のみ出力し、余計なテキストや記号は含めないこと。
`;

export const replyRefinerAgent = new Agent({
  name: 'reply-refiner-agent',
  model: llm,
  instructions: refineSystemPrompt,
});
