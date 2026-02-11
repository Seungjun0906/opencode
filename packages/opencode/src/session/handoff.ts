import { fn } from "@/util/fn"
import z from "zod"
import { MessageV2 } from "./message-v2"
import { LLM } from "./llm"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { iife } from "@/util/iife"
import { Identifier } from "@/id/id"
import PROMPT_HANDOFF from "./prompt/handoff.txt"
import { type Tool } from "ai"
import { SessionStatus } from "./status"
import { defer } from "@/util/defer"

export namespace SessionHandoff {
  const HandoffTool: Tool = {
    description:
      "A tool to extract relevant information from the thread and select relevant files for another agent to continue the conversation. Use this tool to identify the most important context and files needed.",
    inputSchema: z.object({
      text: z.string().describe(PROMPT_HANDOFF),
      files: z
        .string()
        .array()
        .describe(
          [
            "An array of file or directory paths (workspace-relative) that are relevant to accomplishing the goal.",
            "",
            'IMPORTANT: Return as a JSON array of strings, e.g., ["packages/core/src/session/message-v2.ts", "packages/core/src/session/prompt/handoff.txt"]',
            "",
            "Rules:",
            "- Maximum 10 files. Only include the most critical files needed for the task.",
            "- You can include directories if multiple files from that directory are needed",
            "- Prioritize by importance and relevance. PUT THE MOST IMPORTANT FILES FIRST.",
            '- Return workspace-relative paths (e.g., "packages/core/src/session/message-v2.ts")',
            "- Do not use absolute paths or invent files",
          ].join("\n"),
        ),
    }),
    async execute(_args, _ctx) {
      return {}
    },
  }

  export const handoff = fn(
    z.object({
      sessionID: z.string(),
      model: z.object({ providerID: z.string(), modelID: z.string() }),
      goal: z.string().optional(),
    }),
    async (input) => {
      SessionStatus.set(input.sessionID, { type: "busy" })
      using _ = defer(() => SessionStatus.set(input.sessionID, { type: "idle" }))
      const messages = await MessageV2.filterCompacted(MessageV2.stream(input.sessionID))
      const agent = await Agent.get("handoff")
      const model = await iife(async () => {
        if (agent.model) return Provider.getModel(agent.model.providerID, agent.model.modelID)
        const small = await Provider.getSmallModel(input.model.providerID)
        if (small) return small
        return Provider.getModel(input.model.providerID, input.model.modelID)
      })
      const user = {
        info: {
          model: {
            providerID: model.providerID,
            modelID: model.id,
          },
          agent: agent.name,
          sessionID: input.sessionID,
          id: Identifier.ascending("user"),
          role: "user",
          time: {
            created: Date.now(),
          },
        } satisfies MessageV2.User,
        parts: [
          {
            type: "text",
            text: PROMPT_HANDOFF + "\n\nMy request:\n" + (input.goal ?? "general summarization"),
            id: Identifier.ascending("part"),
            sessionID: input.sessionID,
            messageID: Identifier.ascending("message"),
          },
        ] satisfies MessageV2.TextPart[],
      } satisfies MessageV2.WithParts
      const abort = new AbortController()
      const stream = await LLM.stream({
        agent,
        messages: MessageV2.toModelMessages([...messages, user], model),
        sessionID: input.sessionID,
        abort: abort.signal,
        model,
        system: [],
        small: true,
        user: user.info,
        output: "tool",
        tools: {
          handoff: HandoffTool,
        },
      })

      const [result] = await stream.toolCalls
      if (!result) throw new Error("Handoff tool did not return a result")
      return result.input
    },
  )
}
