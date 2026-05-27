import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { buildReviewTask, isFileMutationToolResult, parseChangedFiles, shouldRunReview } from './helpers.ts';
import { runReviewer } from './runner.ts';

export default function autoReviewExtension(pi: ExtensionAPI) {
  let enabled = true;
  let reviewInProgress = false;
  let sawMutationTool = false;
  let beforeStatus = '';

  pi.registerFlag('no-auto-review', {
    description: 'Disable automatic post-change code review',
    type: 'boolean',
    default: false,
  });

  pi.registerCommand('auto-review', {
    description: 'Control automatic post-change code review: on, off, or status',
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === 'on') {
        enabled = true;
        ctx.ui.notify('Auto review enabled', 'info');
        return;
      }
      if (command === 'off') {
        enabled = false;
        ctx.ui.notify('Auto review disabled', 'info');
        return;
      }
      if (command === '' || command === 'status') {
        ctx.ui.notify(`Auto review is ${enabled ? 'enabled' : 'disabled'}`, 'info');
        return;
      }
      ctx.ui.notify('Usage: /auto-review on | off | status', 'warning');
    },
  });

  pi.on('session_start', async () => {
    enabled = pi.getFlag('no-auto-review') !== true;
  });

  pi.on('agent_start', async (_event, ctx) => {
    sawMutationTool = false;
    const status = await pi.exec('git', ['status', '--porcelain'], { signal: ctx.signal });
    beforeStatus = status.code === 0 ? status.stdout : '';
  });

  pi.on('tool_result', async (event) => {
    if (isFileMutationToolResult(event.toolName, event.isError)) {
      sawMutationTool = true;
    }
  });

  pi.on('agent_end', async (_event, ctx) => {
    const status = await pi.exec('git', ['status', '--porcelain'], { signal: ctx.signal });
    const afterStatus = status.code === 0 ? status.stdout : '';

    if (!shouldRunReview({ enabled, reviewInProgress, sawMutationTool, beforeStatus, afterStatus })) {
      return;
    }

    reviewInProgress = true;
    try {
      const changedFiles = parseChangedFiles(afterStatus);
      const task = buildReviewTask({ changedFiles, status: afterStatus });
      if (ctx.hasUI) ctx.ui.notify('Auto review started', 'info');

      const result = await runReviewer({
        cwd: ctx.cwd,
        task,
        signal: ctx.signal,
        exec: async (command, args, options) => {
          const execResult = await pi.exec(command, args, options);
          return {
            stdout: execResult.stdout,
            stderr: execResult.stderr,
            code: execResult.code,
          };
        },
      });

      pi.sendMessage({
        customType: 'auto-review',
        content: result.text,
        display: true,
        details: {
          code: result.code,
          stderr: result.stderr,
          changedFiles,
        },
      });
    } catch (error: unknown) {
      pi.sendMessage({
        customType: 'auto-review',
        content: `Auto review failed: ${String(error)}`,
        display: true,
        details: { error: String(error) },
      });
    } finally {
      reviewInProgress = false;
    }
  });
}
