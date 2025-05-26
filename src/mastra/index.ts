
import { Mastra } from '@mastra/core/mastra';
import { createLogger } from '@mastra/core/logger';
import { LibSQLStore } from '@mastra/libsql';
import { weatherWorkflow } from './workflows';
import { weatherAgent } from './agents';
import {
  generateStyleGuideWorkflow,
  generateReviewReplyWorkflow,
  generateOgataStyleGuideWorkflow,
  generateOgataStyleGuideSchemalessWorkflow,
  generateOgataStyleGuideOptimizedWorkflow,
  replyGeneratorAgent,
  replyRefinerAgent
} from './review-auto-reply/workflows';


export const mastra = new Mastra({
  workflows: {
    weatherWorkflow,
    generateStyleGuideWorkflow,
    generateReviewReplyWorkflow,
    generateOgataStyleGuideWorkflow,
    generateOgataStyleGuideSchemalessWorkflow,
    generateOgataStyleGuideOptimizedWorkflow
  },
  agents: { weatherAgent, replyGeneratorAgent, replyRefinerAgent },
  storage: new LibSQLStore({
    // stores telemetry, evals, ... into memory storage, if it needs to persist, change to file:../mastra.db
    url: "file:./mastra.db",
  }),
  logger: createLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
