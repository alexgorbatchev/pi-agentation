import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import process from "node:process";

const LOOP_SKILL_NAME = "agentation-fix-loop";
const LOOP_PROMPT = `/skill:${LOOP_SKILL_NAME}`;
const PROJECT_SELECTION_ENTRY_TYPE = "agentation-project-selection";
const PROJECT_ID_PATTERN = /^projectId="([^"\r\n]+)"$/;

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

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

export default function agentation(pi: ExtensionAPI): void {
  let currentProjectId: string | null = null;
  let isLoopEnabled = true;

  const isLoopSkillAvailable = (): boolean => {
    return pi.getCommands().some((command) => {
      if (command.source !== "skill") {
        return false;
      }

      return command.name === LOOP_SKILL_NAME || command.name === `skill:${LOOP_SKILL_NAME}`;
    });
  };

  const reportError = (ctx: ExtensionContext, message: string): void => {
    console.error(message);
    ctx.ui.notify(message, "error");
  };

  const shutdownForFatalError = (ctx: ExtensionContext, message: string): void => {
    currentProjectId = null;
    isLoopEnabled = false;
    process.exitCode = 1;
    reportError(ctx, message);
    ctx.shutdown();
  };

  const ensureLoopSkillAvailable = (ctx: ExtensionContext): boolean => {
    if (isLoopSkillAvailable()) {
      return true;
    }

    shutdownForFatalError(ctx, `Missing required skill ${LOOP_PROMPT}. Exiting.`);
    return false;
  };

  const queueLoopPrompt = (projectId: string, deliverAsFollowUp: boolean): void => {
    if (!isLoopEnabled) {
      return;
    }

    const loopPrompt = `${LOOP_PROMPT} ${projectId}`;
    if (deliverAsFollowUp) {
      pi.sendUserMessage(loopPrompt, { deliverAs: "followUp" });
      return;
    }

    pi.sendUserMessage(loopPrompt);
  };

  const persistProjectSelection = (projectId: string): void => {
    if (currentProjectId === projectId) {
      return;
    }

    currentProjectId = projectId;
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

    currentProjectId = latestProjectId;
    return latestProjectId;
  };

  const execCommand = async (command: string, args: string[]): Promise<CommandOutcome> => {
    try {
      const result: ExecResult = await pi.exec(command, args);
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

  const listKnownProjectIds = async (): Promise<{ errorMessage?: string; projectIds: string[] }> => {
    let projectsResult = await execCommand("agentation", ["projects", "--json"]);
    if (!didCommandSucceed(projectsResult)) {
      await execCommand("agentation", ["start", "--background"]);
      projectsResult = await execCommand("agentation", ["projects", "--json"]);
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
      'projectId="[^"]+"',
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

  const initializeLoopForSession = async (ctx: ExtensionContext): Promise<void> => {
    restoreProjectSelection(ctx);

    if (!isLoopEnabled) {
      return;
    }

    if (!ensureLoopSkillAvailable(ctx)) {
      return;
    }

    let projectId = currentProjectId;
    if (projectId === null) {
      projectId = await resolveProjectId(ctx);
      if (projectId === null) {
        return;
      }
      persistProjectSelection(projectId);
    }

    ctx.ui.notify(`Agentation loop started for ${projectId}`, "info");
    queueLoopPrompt(projectId, !ctx.isIdle());
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

  pi.on("agent_end", async (_event, ctx) => {
    if (!isLoopEnabled) {
      return;
    }

    if (!ensureLoopSkillAvailable(ctx)) {
      return;
    }

    if (currentProjectId === null) {
      reportError(ctx, "Agentation loop is enabled, but no project ID is selected for this session.");
      return;
    }

    queueLoopPrompt(currentProjectId, !ctx.isIdle());
  });

  pi.on("session_shutdown", async () => {
    currentProjectId = null;
    isLoopEnabled = false;
  });

  pi.registerCommand("agentation-loop-start", {
    description: "Start the automatic Agentation fix loop",
    handler: async (_args, ctx) => {
      if (isLoopEnabled) {
        ctx.ui.notify("Agentation loop is already running", "info");
        return;
      }

      if (!ensureLoopSkillAvailable(ctx)) {
        return;
      }

      let projectId = currentProjectId ?? restoreProjectSelection(ctx);
      if (projectId === null) {
        projectId = await resolveProjectId(ctx);
        if (projectId === null) {
          return;
        }
        persistProjectSelection(projectId);
      }

      isLoopEnabled = true;
      ctx.ui.notify(`Agentation loop resumed for ${projectId}`, "info");
      queueLoopPrompt(projectId, !ctx.isIdle());
    },
  });

  pi.registerCommand("agentation-loop-stop", {
    description: "Stop the automatic Agentation fix loop",
    handler: async (_args, ctx) => {
      isLoopEnabled = false;
      ctx.ui.notify("Agentation loop paused", "warning");
    },
  });
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
    if (match?.[1] !== undefined) {
      projectIds.push(match[1]);
    }
  }

  return normalizeProjectIds(projectIds);
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

function parseJsonStringArray(jsonText: string): string[] | null {
  try {
    const parsed = JSON.parse(jsonText);
    return isStringArray(parsed) ? normalizeProjectIds(parsed) : null;
  } catch {
    return null;
  }
}
