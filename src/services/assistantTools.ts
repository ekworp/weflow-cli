/**
 * Agent 工具注册表 (OpenAI function-calling 格式, DeepSeek 兼容)。
 * 所有工具在本机执行; 结果经 PrivacyGate 脱敏后才进入 LLM 上下文。
 *
 * 实现按领域拆在 `./tools/` 下；这里保留原来的导出面，导入方与测试都不用改。
 */
export type { ToolDef, ToolContext, AttachedImage } from './tools/types.js'
export {
  wikiIndexPath, VAULT_LINE_LABELS, vaultLineId, vaultLineLabel,
  toolLine, lineLabelOf, safeConceptFile, pageBody,
} from './tools/paths.js'
export { conceptSubgraph, conceptBrief, conceptNeighbors } from './tools/concepts.js'
export { TRANSCRIPT_MSG_CHARS, TRANSCRIPT_MESSAGES, speakerLabel, transcriptLine } from './tools/transcript.js'
export { isSafeUrl, stripTags, extractFromChallengePage, extractText } from './tools/html.js'
export { boundedToolInteger, resolveUniqueTalker, lookupContactUsername, PAREN_SUCCESS_PREFIXES, producedContent } from './tools/runtime.js'
export {
  TOOL_DEFS, MCP_EXCLUDED, MCP_TOOL_DEFS, TOOL_REQUIREMENTS,
  unavailableToolReason, unavailableCapabilities, availableToolDefs,
} from './tools/registry.js'
export { executeTool, TOOL_HANDLERS } from './tools/dispatch.js'
