import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const AGENTATION_SKILL_NAME = "agentation";
const AGENTATION_SKILL_PROMPT = `/skill:${AGENTATION_SKILL_NAME}`;
const AGENTATION_EXECUTABLE_ENV_NAME = "PI_AGENTATION_AGENTATION_BIN";
const PROJECT_SELECTION_ENTRY_TYPE = "agentation-project-selection";
const BATCH_CONTEXT_MESSAGE_TYPE = "agentation-batch-context";
const PROJECT_ID_PATTERN = /^projectId=(?:"([^"\r\n]+)"|'([^'\r\n]+)')$/;
const AGENTATION_SKILL_INVOCATION_PATTERN = new RegExp(`^${AGENTATION_SKILL_PROMPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+(.+))?$`);
const AGENTATION_ACTION_PATTERN = /\bagentation\s+(ack|resolve|reply|dismiss)\s+([^\s]+)/g;
const WATCH_TIMEOUT_SECONDS = "300";
const LOOP_IDLE_WAIT_MS = 500;
const WATCH_RETRY_DELAY_MS = 5_000;

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
type AgentationAction = "ack" | "resolve" | "reply" | "dismiss";
type BatchSource = "pending" | "watch";

type CommandOutcome = {
  code: number | undefined;
  errorMessage?: string;
  killed: boolean;
  stderr: string;
  stdout: string;
};

interface IProjectSelectionData {
  projectId: string;
}

interface IAgentationAnnotation extends Record<string, unknown> {
  id: string;
}

interface IAgentationBatchResponse {
  annotations: IAgentationAnnotation[];
  count: number;
  timeout?: boolean;
}

interface IAgentationWatchTimeoutResponse {
  message?: string;
  timeout: true;
}

type AgentationPollResponse = IAgentationBatchResponse | IAgentationWatchTimeoutResponse;

interface IAnnotationProgress {
  id: string;
  isHandled: boolean;
  lastAction?: AgentationAction;
  wasAcknowledged: boolean;
}

interface IActiveBatch {
  annotations: IAgentationAnnotation[];
  progressById: Map<string, IAnnotationProgress>;
  projectId: string;
  rawJson: string;
  source: BatchSource;
}

type AgentationUiPhase = "error" | "initializing" | "processing" | "watching";

interface IAgentationUiState {
  annotationCount?: number;
  detail: string;
  phase: AgentationUiPhase;
  projectId: string | null;
  source?: BatchSource;
}

interface IConnectionFailureState {
  projectId: string;
}

interface ILoopRuntimeState {
  activeBatch: IActiveBatch | null;
  agentationExecutablePath: string | null;
  connectionFailureState: IConnectionFailureState | null;
  currentContext: ExtensionContext | null;
  currentProjectId: string | null;
  hasNotifiedIncompleteBatch: boolean;
  isLoopEnabled: boolean;
  pendingLoopInvocationProjectId: string | null;
  uiState: IAgentationUiState | null;
  watchAbortController: AbortController | null;
  watchGeneration: number;
  watchTask: Promise<void> | null;
}

export default function agentation(pi: ExtensionAPI): void {
  const runtimeState: ILoopRuntimeState = {
    activeBatch: null,
    agentationExecutablePath: null,
    connectionFailureState: null,
    currentContext: null,
    currentProjectId: null,
    hasNotifiedIncompleteBatch: false,
    isLoopEnabled: true,
    pendingLoopInvocationProjectId: null,
    uiState: null,
    watchAbortController: null,
    watchGeneration: 0,
    watchTask: null,
  };

  const isLoopSkillAvailable = (): boolean => {
    return pi.getCommands().some((command) => {
      if (command.source !== "skill") {
        return false;
      }

      return command.name === AGENTATION_SKILL_NAME || command.name === `skill:${AGENTATION_SKILL_NAME}`;
    });
  };

  const setCurrentContext = (ctx: ExtensionContext): void => {
    runtimeState.currentContext = ctx;
  };

  const clearUiState = (ctx: ExtensionContext | null): void => {
    runtimeState.uiState = null;
    if (ctx === null || !ctx.hasUI) {
      return;
    }

    ctx.ui.setStatus("agentation", undefined);
    ctx.ui.setWidget("agentation", undefined);
  };

  const setUiState = (ctx: ExtensionContext | null, uiState: IAgentationUiState): void => {
    runtimeState.uiState = uiState;
    if (ctx === null || !ctx.hasUI) {
      return;
    }

    const statusText = formatWidgetTitle(uiState);

    ctx.ui.setWidget("agentation", (_tui, theme) => {
      const borderColorName = getUiPhaseColorName(uiState.phase);
      const borderColor = (text: string): string => theme.fg(borderColorName, text);
      const container = new Container();
      const titleText = borderColor(theme.bold(statusText));

      container.addChild(new DynamicBorder(borderColor));
      container.addChild(new Text(titleText, 1, 0));
      container.addChild(new DynamicBorder(borderColor));
      return container;
    });
  };

  const reportError = (ctx: ExtensionContext | null, message: string): void => {
    console.error(message);
    setUiState(ctx, {
      detail: message,
      phase: "error",
      projectId: runtimeState.currentProjectId,
      source: runtimeState.activeBatch?.source,
    });
    ctx?.ui.notify(message, "error");
  };

  const clearConnectionFailureState = (): void => {
    runtimeState.connectionFailureState = null;
  };

  const reportConnectionRecovered = (projectId: string): void => {
    const connectionFailureState = runtimeState.connectionFailureState;
    if (connectionFailureState === null || connectionFailureState.projectId !== projectId) {
      return;
    }

    runtimeState.connectionFailureState = null;
    const message = `Agentation reconnected for ${projectId}. Resuming live watch.`;
    console.info(message);
    runtimeState.currentContext?.ui.notify(message, "info");
  };

  const reportWatchLoopFailure = (projectId: string, source: BatchSource, commandOutcome: CommandOutcome): void => {
    const detail = formatCommandOutcome(commandOutcome);
    const message = `Agentation ${source} failed for ${projectId}: ${detail}`;
    if (!isConnectionFailureDetail(detail)) {
      reportError(runtimeState.currentContext, message);
      return;
    }

    const connectionFailureState = runtimeState.connectionFailureState;
    if (connectionFailureState !== null && connectionFailureState.projectId === projectId) {
      return;
    }

    runtimeState.connectionFailureState = { projectId };
    reportError(runtimeState.currentContext, message);
  };

  const stopWatchLoop = (): void => {
    runtimeState.watchGeneration += 1;
    runtimeState.watchAbortController?.abort();
    runtimeState.watchAbortController = null;
    runtimeState.watchTask = null;
  };

  const resetRuntimeStateForSession = (ctx: ExtensionContext): void => {
    clearUiState(runtimeState.currentContext);
    stopWatchLoop();
    clearConnectionFailureState();
    setCurrentContext(ctx);
    runtimeState.activeBatch = null;
    runtimeState.agentationExecutablePath = resolveAgentationExecutablePath(ctx.cwd);
    runtimeState.currentProjectId = restoreProjectSelection(ctx);
    runtimeState.hasNotifiedIncompleteBatch = false;
    runtimeState.isLoopEnabled = true;
    runtimeState.pendingLoopInvocationProjectId = null;
  };

  const shutdownForFatalError = (ctx: ExtensionContext, message: string): void => {
    stopWatchLoop();
    runtimeState.activeBatch = null;
    runtimeState.currentProjectId = null;
    runtimeState.isLoopEnabled = false;
    runtimeState.pendingLoopInvocationProjectId = null;
    process.exitCode = 1;
    reportError(ctx, message);
    ctx.shutdown();
  };

  const ensureLoopSkillAvailable = (ctx: ExtensionContext): boolean => {
    if (isLoopSkillAvailable()) {
      return true;
    }

    shutdownForFatalError(ctx, `Missing required skill ${AGENTATION_SKILL_PROMPT}. Exiting.`);
    return false;
  };

  const persistProjectSelection = (projectId: string): void => {
    if (runtimeState.currentProjectId === projectId) {
      return;
    }

    runtimeState.currentProjectId = projectId;
    pi.appendEntry(PROJECT_SELECTION_ENTRY_TYPE, { projectId });
  };

  const restoreProjectSelection = (ctx: ExtensionContext): string | null => {
    let latestProjectId: string | null = null;
    let latestTimestamp = "";

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== PROJECT_SELECTION_ENTRY_TYPE) {
        continue;
      }

      if (!isProjectSelectionData(entry.data)) {
        continue;
      }

      const normalizedProjectId = normalizeProjectId(entry.data.projectId);
      if (normalizedProjectId === null) {
        continue;
      }

      if (entry.timestamp >= latestTimestamp) {
        latestTimestamp = entry.timestamp;
        latestProjectId = normalizedProjectId;
      }
    }

    return latestProjectId;
  };

  const execCommand = async (command: string, args: string[], signal?: AbortSignal): Promise<CommandOutcome> => {
    try {
      const result: ExecResult = await pi.exec(command, args, { signal });
      return {
        code: result.code,
        killed: result.killed,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    } catch (error) {
      return {
        code: undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
        killed: false,
        stderr: "",
        stdout: "",
      };
    }
  };

  const execAgentationCommand = async (args: string[], signal?: AbortSignal): Promise<CommandOutcome> => {
    const agentationExecutablePath = runtimeState.agentationExecutablePath ?? "agentation";
    return execCommand(agentationExecutablePath, args, signal);
  };

  const listKnownProjectIds = async (): Promise<{ errorMessage?: string; projectIds: string[] }> => {
    let projectsResult = await execAgentationCommand(["projects", "--json"]);
    if (!didCommandSucceed(projectsResult)) {
      await execAgentationCommand(["start", "--background"]);
      projectsResult = await execAgentationCommand(["projects", "--json"]);
    }

    if (!didCommandSucceed(projectsResult)) {
      const failureMessage = formatCommandOutcome(projectsResult);
      return {
        errorMessage: `Failed to load Agentation projects via \`agentation projects --json\`: ${failureMessage}`,
        projectIds: [],
      };
    }

    const projectIds = parseJsonStringArray(projectsResult.stdout);
    if (projectIds === null) {
      return {
        errorMessage: "`agentation projects --json` returned invalid JSON.",
        projectIds: [],
      };
    }

    return { projectIds };
  };

  const discoverRepoProjectIds = async (): Promise<{ errorMessage?: string; projectIds: string[] }> => {
    const rgResult = await execCommand("rg", [
      "-o",
      "--no-filename",
      "--glob",
      "*.{tsx,jsx}",
      "projectId=(?:\"[^\"]+\"|'[^']+')",
      ".",
    ]);

    if (didCommandSucceed(rgResult)) {
      return { projectIds: extractProjectIdsFromRgOutput(rgResult.stdout) };
    }

    if (rgResult.code === 1 && !rgResult.killed && rgResult.errorMessage === undefined) {
      return { projectIds: [] };
    }

    return {
      errorMessage: `Failed to discover project IDs via \`rg\`: ${formatCommandOutcome(rgResult)}`,
      projectIds: [],
    };
  };

  const resolveProjectId = async (ctx: ExtensionContext): Promise<string | null> => {
    const knownProjectsResult = await listKnownProjectIds();
    if (knownProjectsResult.errorMessage !== undefined) {
      shutdownForFatalError(ctx, knownProjectsResult.errorMessage);
      return null;
    }

    const repoProjectsResult = await discoverRepoProjectIds();
    if (repoProjectsResult.errorMessage !== undefined) {
      shutdownForFatalError(ctx, repoProjectsResult.errorMessage);
      return null;
    }

    if (repoProjectsResult.projectIds.length === 0) {
      const missingProjectIdMessage = [
        "No literal Agentation `projectId` values were found in this repository.",
        "Agentation requires an approved literal `projectId` pattern.",
      ].join(" ");
      shutdownForFatalError(ctx, missingProjectIdMessage);
      return null;
    }

    const candidateProjectIds = intersectProjectIds(repoProjectsResult.projectIds, knownProjectsResult.projectIds);
    if (candidateProjectIds.length === 0) {
      const repoProjectIds = repoProjectsResult.projectIds.join(", ");
      const unknownProjectMessage = [
        `Found repository project IDs (${repoProjectIds}), but none are known to Agentation yet.`,
        "Open the UI so it connects to the server at least once, then retry.",
      ].join(" ");
      shutdownForFatalError(ctx, unknownProjectMessage);
      return null;
    }

    if (candidateProjectIds.length === 1) {
      return candidateProjectIds[0] ?? null;
    }

    if (!ctx.hasUI) {
      const candidateProjectLabel = candidateProjectIds.join(", ");
      const selectionMessage = [
        `Multiple Agentation projects matched this repository (${candidateProjectLabel}),`,
        "but no interactive UI is available to choose one.",
      ].join(" ");
      shutdownForFatalError(ctx, selectionMessage);
      return null;
    }

    const selectedProjectId = await ctx.ui.select("Select Agentation project", candidateProjectIds);
    if (selectedProjectId === undefined) {
      shutdownForFatalError(ctx, "Agentation project selection was cancelled.");
      return null;
    }

    return selectedProjectId;
  };

  const clearActiveBatch = (): void => {
    runtimeState.activeBatch = null;
    runtimeState.hasNotifiedIncompleteBatch = false;
  };

  const createActiveBatch = (
    projectId: string,
    source: BatchSource,
    batchResponse: IAgentationBatchResponse
  ): IActiveBatch => {
    const progressById = new Map<string, IAnnotationProgress>();
    for (const annotation of batchResponse.annotations) {
      progressById.set(annotation.id, {
        id: annotation.id,
        isHandled: false,
        wasAcknowledged: false,
      });
    }

    return {
      annotations: batchResponse.annotations,
      progressById,
      projectId,
      rawJson: JSON.stringify(batchResponse, null, 2),
      source,
    };
  };

  const createBatchContextMessage = (activeBatch: IActiveBatch): string => {
    return [
      "Agentation extension batch context:",
      `- projectId: ${activeBatch.projectId}`,
      `- source: ${activeBatch.source}`,
      `- annotationCount: ${activeBatch.annotations.length}`,
      "- The extension already fetched this batch.",
      "- Do NOT call `agentation pending`, `agentation watch`, `agentation start`, `agentation status`, or `agentation projects`.",
      "- Use `agentation ack`, `agentation resolve`, `agentation reply`, and `agentation dismiss` only for annotation IDs from this batch.",
      "- Run those Agentation action commands as separate bash commands so the extension can track batch completion correctly.",
      "",
      "Current batch JSON:",
      "```json",
      activeBatch.rawJson,
      "```",
    ].join("\n");
  };

  const createNoBatchContextMessage = (projectId: string): string => {
    return [
      "Agentation extension batch context:",
      `- projectId: ${projectId}`,
      "- There is no active batch available right now.",
      "- Do NOT call `agentation pending` or `agentation watch` yourself; the extension owns polling.",
      "- If you need to recover from an interrupted batch, restart pi-agentation.",
    ].join("\n");
  };

  const dispatchActiveBatch = (projectId: string): void => {
    const loopPrompt = `${AGENTATION_SKILL_PROMPT} ${projectId}`;
    const currentContext = runtimeState.currentContext;
    const activeBatch = runtimeState.activeBatch;
    const source = activeBatch?.source;

    runtimeState.pendingLoopInvocationProjectId = projectId;
    runtimeState.hasNotifiedIncompleteBatch = false;
    setUiState(currentContext, {
      annotationCount: activeBatch?.annotations.length,
      detail:
        currentContext !== null && !currentContext.isIdle()
          ? `Triggered ${AGENTATION_SKILL_PROMPT}. Batch queued; pi is busy.`
          : `Triggered ${AGENTATION_SKILL_PROMPT}. Pi is processing the batch.`,
      phase: "processing",
      projectId,
      source,
    });

    if (currentContext !== null && !currentContext.isIdle()) {
      pi.sendUserMessage(loopPrompt, { deliverAs: "followUp" });
      return;
    }

    pi.sendUserMessage(loopPrompt);
  };

  const dispatchBatch = (projectId: string, source: BatchSource, batchResponse: IAgentationBatchResponse): void => {
    runtimeState.activeBatch = createActiveBatch(projectId, source, batchResponse);
    setUiState(runtimeState.currentContext, {
      annotationCount: batchResponse.annotations.length,
      detail: `${batchResponse.annotations.length} annotation${batchResponse.annotations.length === 1 ? "" : "s"} received. Triggering ${AGENTATION_SKILL_PROMPT}.`,
      phase: "processing",
      projectId,
      source,
    });
    runtimeState.currentContext?.ui.notify(
      `Agentation batch ready for ${projectId} (${batchResponse.annotations.length} annotation${batchResponse.annotations.length === 1 ? "" : "s"
      })`,
      "info"
    );
    dispatchActiveBatch(projectId);
  };

  const shouldContinueWatchLoop = (generation: number, projectId: string): boolean => {
    return (
      runtimeState.isLoopEnabled &&
      runtimeState.currentProjectId === projectId &&
      runtimeState.watchGeneration === generation
    );
  };

  const runWatchLoop = async (generation: number, projectId: string, signal: AbortSignal): Promise<void> => {
    let nextBatchSource: BatchSource = "pending";

    while (shouldContinueWatchLoop(generation, projectId)) {
      if (signal.aborted) {
        return;
      }

      const currentContext = runtimeState.currentContext;
      if (runtimeState.activeBatch !== null || (currentContext !== null && !currentContext.isIdle())) {
        await waitForDelay(LOOP_IDLE_WAIT_MS, signal);
        continue;
      }

      const commandArgs =
        nextBatchSource === "pending"
          ? ["pending", projectId, "--json"]
          : ["watch", projectId, "--timeout", WATCH_TIMEOUT_SECONDS, "--json"];
      const commandOutcome = await execAgentationCommand(commandArgs, signal);
      if (!shouldContinueWatchLoop(generation, projectId) || signal.aborted) {
        return;
      }

      if (!didCommandSucceed(commandOutcome)) {
        if (commandOutcome.killed && signal.aborted) {
          return;
        }

        reportWatchLoopFailure(projectId, nextBatchSource, commandOutcome);
        await waitForDelay(WATCH_RETRY_DELAY_MS, signal);
        nextBatchSource = "pending";
        continue;
      }

      reportConnectionRecovered(projectId);
      const pollResponse = parseAgentationPollResponse(commandOutcome.stdout);
      if (pollResponse === null) {
        reportError(
          runtimeState.currentContext,
          `Agentation ${nextBatchSource} returned an unexpected JSON response for ${projectId}.`
        );
        await waitForDelay(WATCH_RETRY_DELAY_MS, signal);
        nextBatchSource = "pending";
        continue;
      }

      if (isAgentationWatchTimeoutResponse(pollResponse)) {
        const detail = pollResponse.message ?? `No new annotations in the last ${WATCH_TIMEOUT_SECONDS}s. Restarting live watch.`;
        setUiState(runtimeState.currentContext, {
          detail,
          phase: "watching",
          projectId,
          source: nextBatchSource,
        });
        nextBatchSource = "watch";
        continue;
      }

      if (pollResponse.annotations.length === 0) {
        const detail =
          nextBatchSource === "pending"
            ? "No pending annotations. Live watch active."
            : pollResponse.timeout === true
              ? `No new annotations in the last ${WATCH_TIMEOUT_SECONDS}s. Restarting live watch.`
              : "Live watch active.";
        setUiState(runtimeState.currentContext, {
          detail,
          phase: "watching",
          projectId,
          source: nextBatchSource,
        });
        nextBatchSource = "watch";
        continue;
      }

      dispatchBatch(projectId, nextBatchSource, pollResponse);
      nextBatchSource = "watch";
    }
  };

  const startWatchLoop = (ctx: ExtensionContext, projectId: string): void => {
    setCurrentContext(ctx);

    if (!runtimeState.isLoopEnabled) {
      return;
    }

    if (!ensureLoopSkillAvailable(ctx)) {
      return;
    }

    if (runtimeState.watchTask !== null && runtimeState.currentProjectId === projectId) {
      setUiState(ctx, {
        detail: "Live watch active.",
        phase: "watching",
        projectId,
        source: "watch",
      });
      return;
    }

    stopWatchLoop();
    runtimeState.currentProjectId = projectId;
    setUiState(ctx, {
      detail: "Checking queue…",
      phase: "initializing",
      projectId,
      source: "pending",
    });

    const watchAbortController = new AbortController();
    const generation = runtimeState.watchGeneration;
    runtimeState.watchAbortController = watchAbortController;
    runtimeState.watchTask = runWatchLoop(generation, projectId, watchAbortController.signal).finally(() => {
      if (runtimeState.watchGeneration !== generation) {
        return;
      }

      runtimeState.watchAbortController = null;
      runtimeState.watchTask = null;
    });
  };

  const initializeLoopForSession = async (ctx: ExtensionContext): Promise<void> => {
    resetRuntimeStateForSession(ctx);
    setUiState(ctx, {
      detail: "Resolving project…",
      phase: "initializing",
      projectId: runtimeState.currentProjectId,
      source: "pending",
    });

    if (!ensureLoopSkillAvailable(ctx)) {
      return;
    }

    let projectId = runtimeState.currentProjectId;
    if (projectId === null) {
      projectId = await resolveProjectId(ctx);
      if (projectId === null) {
        return;
      }
      persistProjectSelection(projectId);
    }

    startWatchLoop(ctx, projectId);
    ctx.ui.notify(`Agentation extension watch started for ${projectId}`, "info");
  };

  const updateBatchProgressFromCommand = (command: string): void => {
    const activeBatch = runtimeState.activeBatch;
    if (activeBatch === null) {
      return;
    }

    const actions = extractAgentationActionsFromCommand(command);
    if (actions.length === 0) {
      return;
    }

    for (const action of actions) {
      const annotationProgress = activeBatch.progressById.get(action.annotationId);
      if (annotationProgress === undefined) {
        continue;
      }

      if (action.action === "ack") {
        annotationProgress.wasAcknowledged = true;
        continue;
      }

      annotationProgress.isHandled = true;
      annotationProgress.lastAction = action.action;
    }

    const isBatchHandled = Array.from(activeBatch.progressById.values()).every((annotationProgress) => {
      return annotationProgress.isHandled;
    });
    if (!isBatchHandled) {
      return;
    }

    clearActiveBatch();
    setUiState(runtimeState.currentContext, {
      detail: "Batch completed. Live watch active.",
      phase: "watching",
      projectId: activeBatch.projectId,
      source: "watch",
    });
    runtimeState.currentContext?.ui.notify(`Agentation batch completed for ${activeBatch.projectId}`, "success");
  };

  pi.on("session_start", async (_event, ctx) => {
    await initializeLoopForSession(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await initializeLoopForSession(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    await initializeLoopForSession(ctx);
  });

  pi.on("input", async (event, ctx) => {
    setCurrentContext(ctx);
    runtimeState.pendingLoopInvocationProjectId = parseLoopInvocationProjectId(event.text);
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    setCurrentContext(ctx);

    const pendingProjectId = runtimeState.pendingLoopInvocationProjectId;
    if (pendingProjectId === null) {
      return undefined;
    }

    runtimeState.pendingLoopInvocationProjectId = null;

    const activeBatch = runtimeState.activeBatch;
    const content =
      activeBatch !== null && activeBatch.projectId === pendingProjectId
        ? createBatchContextMessage(activeBatch)
        : createNoBatchContextMessage(pendingProjectId);

    return {
      message: {
        content,
        customType: BATCH_CONTEXT_MESSAGE_TYPE,
        display: false,
      },
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    setCurrentContext(ctx);

    if (event.toolName !== "bash" || event.isError || !isBashToolInput(event.input)) {
      return undefined;
    }

    updateBatchProgressFromCommand(event.input.command);
    return undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    setCurrentContext(ctx);

    if (runtimeState.activeBatch === null || runtimeState.hasNotifiedIncompleteBatch) {
      return;
    }

    runtimeState.hasNotifiedIncompleteBatch = true;
    setUiState(ctx, {
      annotationCount: runtimeState.activeBatch.annotations.length,
      detail: "Batch still incomplete. Restart pi-agentation to retry.",
      phase: "processing",
      projectId: runtimeState.activeBatch.projectId,
      source: runtimeState.activeBatch.source,
    });
    ctx.ui.notify("Current Agentation batch is still incomplete. Restart pi-agentation to retry.", "warning");
  });

  pi.on("session_shutdown", async () => {
    clearUiState(runtimeState.currentContext);
    stopWatchLoop();
    clearConnectionFailureState();
    runtimeState.activeBatch = null;
    runtimeState.agentationExecutablePath = null;
    runtimeState.currentContext = null;
    runtimeState.currentProjectId = null;
    runtimeState.pendingLoopInvocationProjectId = null;
  });

}

function formatWidgetTitle(uiState: IAgentationUiState): string {
  const projectLabel = uiState.projectId ?? "resolving";
  const phaseLabel = formatUiPhase(uiState.phase);
  return `Agentation Fork / ${projectLabel} / ${phaseLabel}`;
}

function getUiPhaseColorName(phase: AgentationUiPhase): "accent" | "error" | "success" | "warning" {
  switch (phase) {
    case "error":
      return "error";
    case "initializing":
      return "warning";
    case "processing":
      return "accent";
    case "watching":
      return "success";
  }
}

function formatUiPhase(phase: AgentationUiPhase): string {
  switch (phase) {
    case "error":
      return "Error";
    case "initializing":
      return "Initializing";
    case "processing":
      return "Running";
    case "watching":
      return "Watching";
  }
}

function didCommandSucceed(commandOutcome: CommandOutcome): boolean {
  return commandOutcome.code === 0 && !commandOutcome.killed && commandOutcome.errorMessage === undefined;
}

function formatCommandOutcome(commandOutcome: CommandOutcome): string {
  if (commandOutcome.errorMessage !== undefined) {
    return commandOutcome.errorMessage;
  }

  const stderr = commandOutcome.stderr.trim();
  if (stderr !== "") {
    return stderr;
  }

  const stdout = commandOutcome.stdout.trim();
  if (stdout !== "") {
    return stdout;
  }

  if (commandOutcome.killed) {
    return "command was killed";
  }

  if (commandOutcome.code !== undefined) {
    return `exit code ${commandOutcome.code}`;
  }

  return "unknown failure";
}

function isConnectionFailureDetail(detail: string): boolean {
  const normalizedDetail = detail.toLowerCase();
  return [
    "broken pipe",
    "connection refused",
    "connection reset",
    "dial tcp",
    "i/o timeout",
    "no such host",
    "watch stream closed unexpectedly",
  ].some((fragment) => {
    return normalizedDetail.includes(fragment);
  });
}

function normalizeProjectId(projectId: string): string | null {
  const trimmedProjectId = projectId.trim();
  if (trimmedProjectId === "") {
    return null;
  }

  return trimmedProjectId;
}

function normalizeProjectIds(projectIds: readonly string[]): string[] {
  const normalizedProjectIds = new Set<string>();
  for (const projectId of projectIds) {
    const normalizedProjectId = normalizeProjectId(projectId);
    if (normalizedProjectId !== null) {
      normalizedProjectIds.add(normalizedProjectId);
    }
  }

  return Array.from(normalizedProjectIds).sort((leftProjectId, rightProjectId) => {
    return leftProjectId.localeCompare(rightProjectId);
  });
}

function intersectProjectIds(repoProjectIds: readonly string[], knownProjectIds: readonly string[]): string[] {
  const knownProjectIdSet = new Set(normalizeProjectIds(knownProjectIds));
  return normalizeProjectIds(repoProjectIds).filter((projectId) => {
    return knownProjectIdSet.has(projectId);
  });
}

function extractProjectIdsFromRgOutput(output: string): string[] {
  const projectIds: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine === "") {
      continue;
    }

    const match = PROJECT_ID_PATTERN.exec(trimmedLine);
    const extractedProjectId = match?.[1] ?? match?.[2];
    if (extractedProjectId !== undefined) {
      projectIds.push(extractedProjectId);
    }
  }

  return normalizeProjectIds(projectIds);
}

function resolveAgentationExecutablePath(cwd: string): string {
  const explicitExecutablePath = process.env[AGENTATION_EXECUTABLE_ENV_NAME];
  if (isExecutablePath(explicitExecutablePath)) {
    return explicitExecutablePath;
  }

  const localExecutablePath = findNearestNodeModulesExecutable("agentation", cwd);
  if (localExecutablePath !== null) {
    return localExecutablePath;
  }

  return "agentation";
}

function findNearestNodeModulesExecutable(executableName: string, startDirectory: string): string | null {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    const candidateExecutablePath = path.join(currentDirectory, "node_modules", ".bin", executableName);
    if (isExecutablePath(candidateExecutablePath)) {
      return candidateExecutablePath;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }

    currentDirectory = parentDirectory;
  }
}

function isExecutablePath(filePath: string | undefined): filePath is string {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return false;
  }

  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseLoopInvocationProjectId(text: string): string | null {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = AGENTATION_SKILL_INVOCATION_PATTERN.exec(firstLine);
  const projectId = match?.[1];
  if (projectId === undefined) {
    return null;
  }

  return normalizeProjectId(projectId);
}

function extractAgentationActionsFromCommand(
  command: string
): Array<{ action: AgentationAction; annotationId: string }> {
  const actions: Array<{ action: AgentationAction; annotationId: string }> = [];

  for (const match of command.matchAll(AGENTATION_ACTION_PATTERN)) {
    const action = match[1];
    const annotationId = match[2];
    if (action === undefined || annotationId === undefined || !isAgentationAction(action)) {
      continue;
    }

    actions.push({ action, annotationId });
  }

  return actions;
}

function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);

    const onAbort = (): void => {
      clearTimeout(timeoutHandle);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseAgentationPollResponse(jsonText: string): AgentationPollResponse | null {
  try {
    const parsed = JSON.parse(jsonText);
    return isAgentationPollResponse(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isProjectSelectionData(value: unknown): value is IProjectSelectionData {
  if (!isRecord(value)) {
    return false;
  }

  const projectId = value["projectId"];
  return typeof projectId === "string" && projectId.trim() !== "";
}

function isAgentationAnnotation(value: unknown): value is IAgentationAnnotation {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value["id"] === "string" && value["id"].trim() !== "";
}

function isAgentationPollResponse(value: unknown): value is AgentationPollResponse {
  return isAgentationBatchResponse(value) || isAgentationWatchTimeoutResponse(value);
}

function isAgentationBatchResponse(value: unknown): value is IAgentationBatchResponse {
  if (!isRecord(value)) {
    return false;
  }

  const count = value["count"];
  const annotations = value["annotations"];
  const timeout = value["timeout"];

  if (typeof count !== "number" || !Array.isArray(annotations) || !annotations.every(isAgentationAnnotation)) {
    return false;
  }

  if (timeout !== undefined && typeof timeout !== "boolean") {
    return false;
  }

  return true;
}

function isAgentationWatchTimeoutResponse(value: unknown): value is IAgentationWatchTimeoutResponse {
  if (!isRecord(value)) {
    return false;
  }

  const timeout = value["timeout"];
  const message = value["message"];

  if (timeout !== true) {
    return false;
  }

  if (message !== undefined && typeof message !== "string") {
    return false;
  }

  return true;
}

function isBashToolInput(value: unknown): value is { command: string } {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value["command"] === "string";
}

function isAgentationAction(value: string): value is AgentationAction {
  return value === "ack" || value === "resolve" || value === "reply" || value === "dismiss";
}

function parseJsonStringArray(jsonText: string): string[] | null {
  try {
    const parsed = JSON.parse(jsonText);
    return isStringArray(parsed) ? normalizeProjectIds(parsed) : null;
  } catch {
    return null;
  }
}
