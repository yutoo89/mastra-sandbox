
import { Mastra } from '@mastra/core/mastra';
import { createLogger } from '@mastra/core/logger';
import { LibSQLStore } from '@mastra/libsql';
import { weatherWorkflow } from './workflows';
import { weatherAgent } from './agents';
import {
  generateStyleGuideWorkflow,
  generateReviewReplyWorkflow,
  replyGeneratorAgent,
  replyRefinerAgent
} from './review-auto-reply/workflows';

export const mastra = new Mastra({
  workflows: {
    weatherWorkflow,
    generateStyleGuideWorkflow,
    generateReviewReplyWorkflow
  },
  agents: { weatherAgent, replyGeneratorAgent, replyRefinerAgent },
  storage: new LibSQLStore({
    // stores telemetry, evals, ... into memory storage, if it needs to persist, change to file:../mastra.db
    url: ":memory:",
  }),
  logger: createLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
