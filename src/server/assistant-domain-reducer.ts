import type { AssistantBlock, ChatStreamState } from "./routes/types.js";

export type DomainTextKind = "text" | "thinking";
export type DomainTextInput = {
  contentIndex?: number;
  messageSeq?: number;
  phase?: "start" | "delta" | "end";
};

export interface AssistantDomainReducerDeps {
  markBlockDone: (blockId: string) => void;
  closeActiveInput: (kind: DomainTextKind) => string | null;
  resolveIndexedBlockInput: (
    kind: DomainTextKind,
    key: string,
    eventType: string,
    startSuffix: string,
    deltaSuffix: string,
  ) => { blockId: string; closed?: string } | null;
  nextBlockSeq: () => number;
  emitBlock: (block: AssistantBlock, persist: boolean) => void;
  log?: (message: string, ...args: unknown[]) => void;
}

/**
 * Stateful reducer for assistant text/thought nodes. It owns node identity,
 * generation boundaries and close-before-open semantics; the server bridge
 * only supplies runtime events and turns the resulting blocks into SSE.
 */
export class AssistantDomainReducer {
  readonly #chatStream: ChatStreamState;
  readonly #deps: AssistantDomainReducerDeps;
  readonly #thinkingGenStarts = new Map<string, number>();
  readonly #structuredNodeBuffers = new Map<string, string>();

  constructor(chatStream: ChatStreamState, deps: AssistantDomainReducerDeps) {
    this.#chatStream = chatStream;
    this.#deps = deps;
  }

  reset(): void {
    this.#thinkingGenStarts.clear();
    this.#structuredNodeBuffers.clear();
  }

  closeThinkingAtToolBoundary(): void {
    for (const block of this.#chatStream.blocks) {
      if (block.type === "thinking" && block.status === "streaming") {
        this.#deps.markBlockDone(block.blockId);
        this.#deps.log?.("tool-boundary", "thinking", { blockId: block.blockId });
      }
    }
  }

  upsertTextBlock(kind: DomainTextKind, text: string, turnId: string, input?: DomainTextInput): void {
    if (input?.phase && Number.isSafeInteger(input.messageSeq) && (input.messageSeq as number) > 0) {
      const contentIndex = Number.isSafeInteger(input.contentIndex) && (input.contentIndex as number) >= 0
        ? input.contentIndex as number
        : 0;
      const key = `m${input.messageSeq}:${kind}-${contentIndex}`;
      const opposite: DomainTextKind = kind === "text" ? "thinking" : "text";
      const closedOpposite = this.#deps.closeActiveInput(opposite);
      if (closedOpposite !== null) this.#deps.markBlockDone(closedOpposite);
      const resolved = this.#deps.resolveIndexedBlockInput(kind, key, `${kind}_${input.phase}`, kind, kind);
      if (resolved === null) return;
      const previous = this.#structuredNodeBuffers.get(resolved.blockId) || "";
      const nodeText = input.phase === "start" ? text : previous + text;
      this.#structuredNodeBuffers.set(resolved.blockId, nodeText);
      this.#deps.log?.("structured-upsert", kind, {
        turnId, key, blockId: resolved.blockId, phase: input.phase,
        textLen: text.length, nodeTextLen: nodeText.length,
      });
      const existing = this.#chatStream.blocks.find((block): block is Extract<AssistantBlock, { type: typeof kind }> =>
        block.type === kind && block.blockId === resolved.blockId);
      this.#deps.emitBlock({
        type: kind,
        text: nodeText,
        ...(kind === "thinking" ? { status: input.phase === "end" ? "done" : "streaming" } : {}),
        turnId,
        blockId: resolved.blockId,
        seq: existing?.seq ?? this.#deps.nextBlockSeq(),
      } as AssistantBlock, false);
      if (resolved.closed !== undefined) this.#deps.markBlockDone(resolved.closed);
      if (input.phase === "end") this.#deps.markBlockDone(resolved.blockId);
      return;
    }

    const opposite: DomainTextKind = kind === "text" ? "thinking" : "text";
    if (kind === "text") {
      const openThinking = this.#chatStream.blocks.find(
        (block): block is Extract<AssistantBlock, { type: "thinking" }> =>
          block.type === "thinking" && block.status === "streaming",
      );
      if (openThinking !== undefined) {
        this.#deps.markBlockDone(openThinking.blockId);
        this.#deps.log?.("engine-cutoff", "text", { thinkingBlock: openThinking.blockId });
      }
    } else {
      const existingText = this.#chatStream.blocks.find((block) => block.type === opposite);
      if (existingText !== undefined) this.#deps.log?.("engine-cutoff", "thinking", { textBlock: existingText.blockId });
    }

    this.#chatStream.thinkingBlockGenerations ??= {};
    const baseId = `${kind}-${turnId}`;
    let blockId = baseId;
    if (kind === "thinking") {
      const latestThinking = [...this.#chatStream.blocks]
        .filter((block): block is Extract<AssistantBlock, { type: "thinking" }> =>
          block.type === "thinking" && block.blockId.startsWith(baseId))
        .sort((a, b) => b.seq - a.seq)[0];
      if (latestThinking !== undefined) {
        if (latestThinking.status === "done") {
          const previousStart = this.#thinkingGenStarts.get(latestThinking.blockId) ?? 0;
          const nextStart = previousStart + latestThinking.text.length;
          const currentGeneration = this.#chatStream.thinkingBlockGenerations[baseId] || 0;
          const nextGeneration = currentGeneration + 1;
          this.#chatStream.thinkingBlockGenerations[baseId] = nextGeneration;
          blockId = nextGeneration === 1 ? `${baseId}#2` : `${baseId}#${nextGeneration + 1}`;
          this.#thinkingGenStarts.set(blockId, nextStart);
          this.#deps.log?.("engine-newgen", "thinking", {
            from: latestThinking.blockId, to: blockId, gen: nextGeneration, start: nextStart,
          });
        } else {
          blockId = latestThinking.blockId;
        }
      } else {
        this.#chatStream.thinkingBlockGenerations[baseId] = 0;
        this.#thinkingGenStarts.set(baseId, 0);
      }
    }
    const generationStart = kind === "thinking" ? (this.#thinkingGenStarts.get(blockId) ?? 0) : 0;
    const nodeText = kind === "thinking" && generationStart > 0 && text.length >= generationStart
      ? text.slice(generationStart)
      : text;
    this.#deps.log?.("upsert", kind, { turnId, textLen: text.length, blockId, nodeTextLen: nodeText.length });
    const existing = this.#chatStream.blocks.find((block): block is Extract<AssistantBlock, { type: typeof kind }> =>
      block.type === kind && block.blockId === blockId);
    this.#deps.emitBlock({
      type: kind,
      text: nodeText,
      ...(kind === "thinking" ? { status: "streaming" as const } : {}),
      turnId,
      blockId,
      seq: existing?.seq ?? this.#deps.nextBlockSeq(),
    } as AssistantBlock, false);
  }
}

