import { setup, assign, fromPromise } from 'xstate';
import type { OrchestratorContext, OrchestratorInput, PageStateAnalysis } from './types';
import type { DOMContext } from '../dom-capture';
import * as guards from './guards';
import {
  saveDomToCache,
  recordGoal,
  recordAction,
  recordDomSummary,
  recordLastUrl,
} from './actions';
import { getSessionMemory } from './session';
import {
  extractFilesActor,
  classifyIntentActor,
  resolveUrlActor,
  captureDomActor,
  analyzePageActor,
  type IntentResult,
} from './actors';

/**
 * Initial context factory
 */
function createInitialContext(): OrchestratorContext {
  return {
    userPrompt: '',
    conversationHistory: [],
    projectPath: '',
    fileContext: [],
    config: {
      apiKey: process.env['OPENROUTER_API_KEY'] || '',
      model: process.env['OPENROUTER_MODEL'] || 'anthropic/claude-sonnet-4.5',
    },
    resolvedFiles: [],
    intent: null,
    metaIntent: null,
    nextTool: null,
    appUrl: null,
    cancelRequested: false,
    currentGoal: null,
    lastAction: null,
    lastDomSummary: null,
    lastUrl: null,
    domContext: null,
    pageAnalysis: null,
    retryCount: 0,
    maxRetries: 3,
    error: null,
    errorMessage: null,
    streamType: null,
  };
}

/**
 * The main orchestrator state machine
 */
export const orchestratorMachine = setup({
  types: {
    context: {} as OrchestratorContext,
    input: {} as OrchestratorInput,
    events: {} as 
      | { type: 'RECEIVE_MESSAGE'; input: OrchestratorInput }
      | { type: 'RESET' },
  },
  
  guards: {
    shouldRetry: guards.shouldRetry,
    isTestGeneration: guards.isTestGeneration,
    isChat: guards.isChat,
    isHelp: guards.isHelp,
    pageMatches: guards.pageMatches,
    canProceed: guards.canProceed,
    hasUrl: guards.hasUrl,
    hasDom: guards.hasDom,
    hasError: guards.hasError,
  },
  
  actors: {
    extractFiles: fromPromise(async ({ input }: { input: OrchestratorContext }) => 
      extractFilesActor(input)
    ),
    classifyIntent: fromPromise(async ({ input }: { input: OrchestratorContext }) => 
      classifyIntentActor(input)
    ),
    resolveUrl: fromPromise(async ({ input }: { input: OrchestratorContext }) => 
      resolveUrlActor(input)
    ),
    captureDom: fromPromise(async ({ input }: { input: OrchestratorContext }) => 
      captureDomActor(input)
    ),
    analyzePage: fromPromise(async ({ input }: { input: OrchestratorContext }) => 
      analyzePageActor(input)
    ),
  },
}).createMachine({
  id: 'orchestrator',
  initial: 'idle',
  context: createInitialContext,
  
  states: {
    idle: {
      on: {
        RECEIVE_MESSAGE: {
          target: 'classifyingIntent',
          actions: assign(({ event }) => {
            const input = event.input;
            const memory = getSessionMemory(input.projectPath);
            return {
              userPrompt: input.userPrompt,
              projectPath: input.projectPath,
              conversationHistory: input.conversationHistory || [],
              fileContext: input.fileContext || [],
              resolvedFiles: [],
              intent: null,
              metaIntent: null,
              nextTool: null,
              appUrl: null,
              cancelRequested: false,
              currentGoal: memory.currentGoal,
              lastAction: memory.lastAction,
              lastDomSummary: memory.lastDomSummary,
              lastUrl: memory.lastUrl,
              domContext: null,
              pageAnalysis: null,
              retryCount: 0,
              error: null,
              errorMessage: null,
              streamType: null,
            };
          }),
        },
      },
    },
    
    extractingFiles: {
      invoke: {
        src: 'extractFiles',
        input: ({ context }) => context,
        onDone: {
          target: 'decideNextAction',
          actions: assign(({ context, event }) => {
            recordAction(context.projectPath, 'codeSearch');
            return { resolvedFiles: event.output as string[] };
          }),
        },
        onError: {
          target: 'decideNextAction',
        },
      },
    },

    decideNextAction: {
      always: [
        {
          guard: ({ context }) => context.cancelRequested,
          target: 'streaming',
          actions: assign({ streamType: 'chat' as const }),
        },
        {
          guard: ({ context }) => context.metaIntent === 'stop' || context.metaIntent === 'cancel',
          target: 'streaming',
          actions: assign({ streamType: 'chat' as const }),
        },
        {
          guard: ({ context }) => context.metaIntent === 'clarify',
          target: 'streaming',
          actions: assign({ streamType: 'chat' as const }),
        },
        {
          guard: ({ context }) => context.nextTool === 'domCapture',
          target: 'resolvingUrl',
        },
        {
          guard: ({ context }) => context.nextTool === 'testGen',
          target: 'streaming',
          actions: assign({ streamType: 'test' as const }),
        },
        {
          guard: ({ context }) => context.nextTool === 'explain' || context.nextTool === 'codeSearch',
          target: 'streaming',
          actions: assign({ streamType: 'chat' as const }),
        },
        {
          guard: ({ context }) => context.intent === 'test-generation',
          target: 'resolvingUrl',
        },
        {
          target: 'streaming',
          actions: assign({ streamType: 'chat' as const }),
        },
      ],
    },
    
    classifyingIntent: {
      invoke: {
        src: 'classifyIntent',
        input: ({ context }) => context,
        onDone: [
          {
            target: 'extractingFiles',
            actions: assign(({ context, event }) => {
              const result = event.output as IntentResult;
              const mergedFileContext = result.files.length > 0
                ? Array.from(new Set([...context.fileContext, ...result.files]))
                : context.fileContext;
              const effectivePrompt = result.effectivePrompt?.trim() || context.userPrompt;
              recordGoal(context.projectPath, effectivePrompt);
              return {
                userPrompt: effectivePrompt,
                metaIntent: result.control,
                intent: result.intent,
                nextTool: result.nextTool,
                cancelRequested: result.control === 'stop' || result.control === 'cancel',
                fileContext: mergedFileContext,
              };
            }),
          },
        ],
        onError: {
          target: 'streaming',
          actions: assign({ streamType: 'error' as const }),
        },
      },
    },
    
    resolvingUrl: {
      invoke: {
        src: 'resolveUrl',
        input: ({ context }) => context,
        onDone: [
          {
            guard: ({ event }) => event.output !== null,
            target: 'capturingDom',
            actions: assign(({ context, event }) => {
              const url = event.output as string;
              recordLastUrl(context.projectPath, url);
              recordAction(context.projectPath, 'resolveUrl');
              return { appUrl: url };
            }),
          },
          {
            // No URL found - go to streaming to ask for URL
            target: 'streaming',
            actions: assign({ streamType: 'error' as const }),
          },
        ],
        onError: {
          target: 'streaming',
          actions: assign({ streamType: 'error' as const }),
        },
      },
    },
    
    capturingDom: {
      entry: ({ context }) => {
        console.log(`📍 State: intent=${context.intent}, url=${context.appUrl}, retry=${context.retryCount}`);
      },
      invoke: {
        src: 'captureDom',
        input: ({ context }) => context,
        onDone: {
          target: 'analyzingPage',
          actions: assign(({ context, event }) => {
            const dom = event.output as DOMContext;
            // Cache the DOM
            if (context.appUrl) {
              saveDomToCache(context.projectPath, context.appUrl, dom);
              recordLastUrl(context.projectPath, context.appUrl);
            }
            recordAction(context.projectPath, 'domCapture');
            recordDomSummary(context.projectPath, dom);
            return {
              domContext: dom,
              error: null,
              errorMessage: null,
            };
          }),
        },
        onError: [
          {
            guard: ({ context, event }) => {
              const message = (event.error as Error | undefined)?.message || '';
              return context.cancelRequested || message.toLowerCase().includes('cancel');
            },
            target: 'streaming',
            actions: assign({ streamType: 'chat' as const }),
          },
          {
            target: 'retrying',
            actions: assign(({ event }) => ({
              error: event.error as Error,
              errorMessage: (event.error as Error).message,
            })),
          },
        ],
      },
    },
    
    retrying: {
      always: [
        {
          guard: 'shouldRetry',
          target: 'capturingDom',
          actions: assign(({ context }) => ({
            retryCount: context.retryCount + 1,
            error: null,
          })),
        },
        {
          target: 'streaming',
          actions: assign({ streamType: 'error' as const }),
        },
      ],
    },
    
    analyzingPage: {
      invoke: {
        src: 'analyzePage',
        input: ({ context }) => context,
        onDone: [
          {
            guard: ({ event }) => {
              const analysis = event.output as PageStateAnalysis;
              return analysis.matchesIntent || analysis.canProceed;
            },
            target: 'streaming',
            actions: assign(({ context, event }) => {
              recordAction(context.projectPath, 'analyzePage');
              return {
                pageAnalysis: event.output as PageStateAnalysis,
                streamType: 'test' as const,
              };
            }),
          },
          {
            // Page mismatch - explain to user
            target: 'streaming',
            actions: assign(({ context, event }) => {
              recordAction(context.projectPath, 'analyzePage');
              return {
                pageAnalysis: event.output as PageStateAnalysis,
                streamType: 'error' as const,
              };
            }),
          },
        ],
        onError: {
          // If analysis fails, proceed anyway
          target: 'streaming',
          actions: assign({ streamType: 'test' as const }),
        },
      },
    },
    
    streaming: {
      // This is a "marker" state - actual streaming happens in the runner
      entry: ({ context }) => {
        console.log(`📍 Streaming state: type=${context.streamType}`);
      },
      on: {
        RESET: {
          target: 'idle',
          actions: assign(createInitialContext),
        },
      },
    },
  },
});

export type OrchestratorMachine = typeof orchestratorMachine;
