/**
 * 会话标题生成——共享标题清洗、评分与截断逻辑。
 *
 * 中性模块：不依赖路由层或数据索引层。
 * usage-index（数据索引层）与 routes/session-message-parser（解析层）各自保留
 * textFromBlocks 与薄层 deriveReplySummary（两者 textFromBlocks 对非法 surrogate
 * 的处理有差异：parser 经 fixSurrogates 清洗、usage-index 不清，保持各自行为不变）。
 */

function summarizeText(text: string, max = 36): string {
  const clean = text
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\-•·\d.、)\s]+/, "")
    .trim();
  if (!clean) return "";
  return clean.length > max ? clean.slice(0, max).trimEnd() + "…" : clean;
}

function normalizeTitleLine(line: string): string {
  return line
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^>\s*/, "")
    .replace(/^[\-•·]\s*/, "")
    .replace(/^\d+[.)、]\s*/, "")
    .replace(/^[A-Z]\d+[.)、]?\s*/i, "")
    .trim();
}

function isGenericReplyIntro(line: string): boolean {
  return /^(好[，,、\s]*)?(全部代码|我已经|我已|下面|以下|先说|总体|整体|结论是|可以|已完成|收到)/.test(line)
    || /^(位置|代码|示例|说明|注意)[:：]/.test(line);
}

function scoreTitleLine(line: string): number {
  if (!line || line.length < 4 || isGenericReplyIntro(line)) return -10;
  let score = 0;
  if (/[：:]/.test(line)) score += 5;
  if (/[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?/.test(line)) score += 3;
  if (/(问题|根因|风险|缺陷|竞争|并发|失败|错误|修复|优化|清理|支付|订单|订阅|回调)/.test(line)) score += 3;
  if (line.length >= 8 && line.length <= 42) score += 2;
  if (line.length > 90) score -= 3;
  return score;
}

export function extractReplyTitle(text: string): string {
  const lines = text
    .replace(/```[\s\S]*?```/g, "\n")
    .split(/\r?\n+/)
    .map(normalizeTitleLine)
    .filter(Boolean);
  let best = "";
  let bestScore = -Infinity;
  for (const line of lines.slice(0, 24)) {
    const score = scoreTitleLine(line);
    if (score > bestScore) {
      best = line;
      bestScore = score;
    }
  }
  return summarizeText(bestScore > -10 ? best : text);
}
