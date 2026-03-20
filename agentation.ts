import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import process from "node:process";

const LOOP_SKILL_NAME = "agentation-fix-loop";
const LOOP_PROMPT = `/skill:${LOOP_SKILL_NAME}`;

export default function agentation(pi: ExtensionAPI): void {
  let isLoopEnabled = true;

  const isLoopSkillAvailable = (): boolean => {
    return pi.getCommands().some((command) => {
      if (command.source !== "skill") {
        return false;
      }

      return command.name === LOOP_SKILL_NAME || command.name === `skill:${LOOP_SKILL_NAME}`;
    });
  };

  const exitForMissingSkill = (ctx: ExtensionContext): void => {
    isLoopEnabled = false;
    process.exitCode = 1;
    ctx.ui.notify(`Missing required skill ${LOOP_PROMPT}. Exiting.`, "error");
    ctx.shutdown();
  };

  const ensureLoopSkillAvailable = (ctx: ExtensionContext): boolean => {
    if (isLoopSkillAvailable()) {
      return true;
    }

    exitForMissingSkill(ctx);
    return false;
  };

  const queueLoopPrompt = (deliverAsFollowUp: boolean): void => {
    if (!isLoopEnabled) {
      return;
    }

    if (deliverAsFollowUp) {
      pi.sendUserMessage(LOOP_PROMPT, { deliverAs: "followUp" });
      return;
    }

    pi.sendUserMessage(LOOP_PROMPT);
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!ensureLoopSkillAvailable(ctx)) {
      return;
    }

    ctx.ui.notify("Agentation loop started", "info");
    queueLoopPrompt(!ctx.isIdle());
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!isLoopEnabled) {
      return;
    }

    if (!ensureLoopSkillAvailable(ctx)) {
      return;
    }

    queueLoopPrompt(!ctx.isIdle());
  });

  pi.on("session_shutdown", async () => {
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

      isLoopEnabled = true;
      ctx.ui.notify("Agentation loop resumed", "info");
      queueLoopPrompt(!ctx.isIdle());
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
