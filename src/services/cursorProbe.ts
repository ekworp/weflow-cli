/**
 * 稳定增量游标的"路径可见"层（D-027）。
 *
 * `capabilities --json` 的 `stableCursor: false` 一直是一句结论；这里把它背后的
 * 判据拆开，逐条给出当前状态与差在哪，让下游（she-love-me、MCP 客户端）能看见
 * false → true 要满足什么，而不是等它某天悄悄变 true。
 *
 * 两类事实，来源不同、都必须如实标注：
 *  - **代码事实**（静态）：每个后端有没有时间窗下推、有没有覆盖报告、合并顺序键是什么。
 *    这些写在下面的表里，改读取器时要同步改。
 *  - **数据事实**（实测）：NT 库里每张消息表有没有锚点列、采样的行带不带非零
 *    `server_id`。这些只有开库才知道，由 `sync cursor-probe` 现场 probing，采样
 *    有界且结果里写明 `exhaustive: false`。
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { configService } from './configService.js'
import { NtCore } from '../core/ntCore.js'
import type { NtCursorProbeResult, NtCursorProbeShard, NtCursorProbeSample } from '../core/ntCore.js'

export type MessageBackend = 'nt' | 'raw-sqlite-4x' | 'wcdb-4x' | 'legacy-3x'

export interface CursorCriterion {
  id: string
  /** 这条判据满足没有：true/false 是已核实的结论，null 是"当前无法判定" */
  met: boolean | null
  detail: string
}

export interface CursorProbeReport {
  success: boolean
  schema: 'weflow-cursor-probe/v1'
  /** 结论不动：探针是让路径可见，不是替 D-027 翻案 */
  stableCursor: false
  backend: MessageBackend | null
  backendNote: string
  /** 数据事实那一半跑了没有（未初始化 / 非 NT 后端 = false） */
  probedLive: boolean
  criteria: CursorCriterion[]
  /** NT 实测明细；probedLive=false 时为 undefined */
  shards?: NtCursorProbeShard[]
  sample?: NtCursorProbeSample
  error?: string
}

/**
 * 静态判断"这台机器会走哪条消息后端"。**镜像 `chatService.connect4x` 的尝试顺序**
 * （先已解密 MSG0，再 NT，最后 WCDB），但只看配置与文件存在性、不开库——真正的
 * 开库判定在 connect 里，而探测命令不该为了报一个名字去连数据库。
 */
export function likelyMessageBackend(): { backend: MessageBackend | null; note: string } {
  const version = configService.get('dataVersion')
  const dbPath = configService.get('dbPath')
  const wxid = configService.get('wxid')
  const dbPath3x = configService.get('dbPath3x')
  const key3x = configService.get('decryptKey3x')
  const ntDbPath = configService.get('ntDbPath')
  const ntKey = configService.get('ntKey')
  const ntSalt = configService.get('ntSalt')

  if (version === '3.x' || (!version && dbPath3x && key3x)) {
    return { backend: 'legacy-3x', note: '按 3.x 配置判定（sqlcipher + MSG 库）' }
  }
  if (version !== '4.x' && !dbPath && !(ntDbPath && ntKey && ntSalt)) {
    return { backend: null, note: '未初始化：没有可判定的消息后端（先运行 weflow-cli init）' }
  }
  if (dbPath && wxid && existsSync(join(dbPath, wxid, 'Msg', 'Multi', 'MSG0_decrypted.db'))) {
    return { backend: 'raw-sqlite-4x', note: '发现已解密的 MSG0_decrypted.db（connect4x 的第一优先）' }
  }
  if (ntDbPath && ntKey && ntSalt && existsSync(ntDbPath)) {
    return { backend: 'nt', note: 'NT 配置完整（db_storage/message 分片）' }
  }
  if (dbPath) {
    return { backend: 'wcdb-4x', note: '无解密 MSG0、无 NT 配置，connect4x 的最后兜底是 WCDB API' }
  }
  return { backend: null, note: '4.x 配置不完整：既无 dbPath 也无 NT 三件套' }
}

/** 各后端的**代码事实**。改读取器（下推 / 报告 / 顺序键）时同步改这张表。 */
export const BACKEND_CAPS: Record<MessageBackend, {
  identity: string
  windowPushdown: boolean
  coverageReport: boolean
  liveProbe: boolean
}> = {
  'nt': {
    identity: 'server_id（缺失时退化为 localId+createTime，后者不跨分片）',
    windowPushdown: true,   // D-030: --from/--to 推进 SQL
    coverageReport: true,   // 分片报告（connect_message_shards_detailed）
    liveProbe: true,
  },
  'raw-sqlite-4x': {
    identity: 'MsgSvrID 列被读取，但覆盖率从未实测',
    windowPushdown: false,
    coverageReport: false,
    liveProbe: false,
  },
  'wcdb-4x': {
    identity: 'server_id 随原生 API 返回，未实测；另有按时间的原生游标未接入 chatService',
    windowPushdown: false,
    coverageReport: false,
    liveProbe: false,
  },
  'legacy-3x': {
    identity: 'MsgSvrID 列被读取，但覆盖率从未实测',
    windowPushdown: false,
    coverageReport: false,
    liveProbe: false,
  },
}

export async function probeCursorReadiness(opts: {
  tablesPerShard?: number
  rowsPerTable?: number
} = {}): Promise<CursorProbeReport> {
  const { backend, note } = likelyMessageBackend()

  const criteria: CursorCriterion[] = []
  let live: NtCursorProbeResult | null = null
  let shards: NtCursorProbeShard[] | undefined
  let sample: NtCursorProbeSample | undefined

  if (backend === 'nt') {
    const ntDbPath = configService.get('ntDbPath')!
    const ntKey = configService.get('ntKey')!
    const ntSalt = configService.get('ntSalt')!
    live = await new NtCore(ntDbPath, ntKey, ntSalt).cursorProbe(opts)
    if (live.success) {
      shards = live.shards
      sample = live.sample
    }
  }

  const caps = backend ? BACKEND_CAPS[backend] : null

  // 1. stable-identity
  if (backend === null) {
    criteria.push({
      id: 'stable-identity',
      met: null,
      detail: '没有可判定的后端',
    })
  } else if (backend === 'nt') {
    if (!live?.success || !sample) {
      criteria.push({
        id: 'stable-identity',
        met: null,
        detail: `NT 实测没有跑成：${live?.error ?? '无结果'}`,
      })
    } else {
      const failed = (live.shards ?? []).filter(s => !s.opened)
      const anchorBad = live.schemaAnchorMissingTables ?? 0
      const parts: string[] = []
      if (failed.length) parts.push(`${failed.length} 个分片没打开`)
      if (anchorBad > 0) parts.push(`${anchorBad} 组消息表缺锚点列`)
      if (sample.serverIdMissing > 0) parts.push(`采样 ${sample.rowsSampled} 行里 ${sample.serverIdMissing} 行没有非零 server_id（这些行的身份退化为按分片的 localId+createTime）`)
      if (sample.duplicateServerIds > 0) parts.push(`采样里 ${sample.duplicateServerIds} 个 server_id 出现在多个位置`)
      criteria.push({
        id: 'stable-identity',
        met: parts.length === 0,
        detail: parts.length
          ? parts.join('；')
          : `采样 ${sample.rowsSampled} 行（${sample.tablesSampled}/${sample.tablesTotal} 张表）全部带非零 server_id 且无重复；schema 全量检查 ${anchorBad} 组缺列。注意 exhaustive=false，这是采样结论`,
      })
    }
  } else {
    criteria.push({
      id: 'stable-identity',
      met: null,
      detail: `${backend}：${caps!.identity}；该后端没有实测探针`,
    })
  }

  // 2. globally-comparable-order（代码事实，对所有后端同为 false）
  criteria.push({
    id: 'globally-comparable-order',
    met: false,
    detail: '读取器跨分片合并的顺序键是 (createTime, localId)，localId 是分片内编号、不可跨分片比较；换成 (createTime, serverId) 是稳定游标在读取器侧的前提',
  })

  // 3. window-pushdown
  criteria.push({
    id: 'window-pushdown',
    met: caps ? caps.windowPushdown : null,
    detail: caps
      ? (caps.windowPushdown
          ? `${backend}：--from/--to 已下推进 SQL（D-030）`
          : `${backend}：没有时间窗下推，窗口过滤全靠调用方拉全量后自筛`)
      : '没有可判定的后端',
  })

  // 4. coverage-report
  criteria.push({
    id: 'coverage-report',
    met: caps ? caps.coverageReport : null,
    detail: caps
      ? (caps.coverageReport
          ? `${backend}：每分片读取结果都带覆盖报告（complete/unverified/partial）`
          : `${backend}：无法报告读取是否完整，sync 在它上面永远是 unverified`)
      : '没有可判定的后端',
  })

  // 5. every-backend（D-027 的总门）
  const others = (Object.keys(BACKEND_CAPS) as MessageBackend[]).filter(b => b !== backend)
  criteria.push({
    id: 'every-backend',
    met: false,
    detail: `D-027：稳定游标要所有消息后端同时满足上述判据。当前后端 ${backend ?? '（未配置）'}；其余后端（${others.join('、')}）各自缺下推与覆盖报告`,
  })

  return {
    success: true,
    schema: 'weflow-cursor-probe/v1',
    stableCursor: false,
    backend,
    backendNote: note,
    probedLive: !!(backend === 'nt' && live?.success),
    criteria,
    ...(shards ? { shards } : {}),
    ...(sample ? { sample } : {}),
  }
}
