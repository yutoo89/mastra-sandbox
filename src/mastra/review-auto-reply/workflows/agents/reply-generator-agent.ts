import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';

const llm = openai('gpt-4o-mini');

const systemPrompt = `お客様の口コミに対する返信文を作成してください。
口コミの内容や感情を適切に理解し、お客様満足度が向上するような返信文を考慮します。
返信文には適切な改行を入れてください。

# 禁止事項

- 投稿者、経営者、従業員を含め人名を記載することは禁止
- 「〜店より」のような署名を記載することは禁止

# Output Format

- 返信文は端的で、読みやすい形式にしてください。
- 返信は指定の言語で作成してください。
`;


export const replyGeneratorAgent = new Agent({
    name: 'reply-generator-agent',
    model: llm,
    instructions: systemPrompt,
  });
