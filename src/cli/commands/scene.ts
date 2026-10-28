// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { assistantScenes, validateSceneId, type Scene } from '../../services/assistantScenes.js'

export function registerScene(program: Command): void {

// ==================== scene (会话场景) ====================
const sceneCmd = program
  .command('scene')
  .description('会话场景：按会话生效的提示词预设（绑定 → 关键词 → 上次用过的）')

/** 写场景是**本机文件写**，不是 python mutation：同样两段式，措辞照 todos 那条 */
async function confirmSceneWrite(
  opts: { dryRun?: boolean; yes?: boolean; json?: boolean },
  preview: Record<string, unknown>,
  message: string,
  apply: () => { ok: boolean; reason?: string },
): Promise<void> {
  if (opts.dryRun) {
    if (opts.json) console.log(JSON.stringify({ success: true, dryRun: true, ...preview }))
    else console.log(chalk.cyan('预览：') + message)
    return
  }
  if (!opts.yes) {
    if (opts.json) {
      console.log(JSON.stringify({
        success: false,
        code: 'CONFIRMATION_REQUIRED',
        error: '先使用 --dry-run --json 预览，再由用户确认后使用 --yes --json 执行',
      }))
      process.exit(1)
    }
    const { confirmed } = await inquirer.prompt([{ type: 'confirm', name: 'confirmed', message, default: false }])
    if (!confirmed) {
      console.log(chalk.gray('已取消'))
      return
    }
  }
  const result = apply()
  if (result.ok) assistantScenes.save()
  const saved = result.ok && !assistantScenes.lastSaveError
  if (opts.json) {
    if (!result.ok) {
      console.log(JSON.stringify({ success: false, code: 'SCENE_OPERATION_FAILED', error: result.reason }))
      process.exit(1)
    }
    // 写失败要说出来：`save()` 不抛异常，代价是必须有地方把它讲出来
    console.log(JSON.stringify({
      success: saved,
      ...(saved ? {} : { code: 'SCENE_SAVE_FAILED', error: assistantScenes.lastSaveError }),
      ...preview,
    }))
    if (!saved) process.exit(1)
    return
  }
  if (!result.ok) {
    console.log(chalk.red(`✗ ${result.reason}`))
    process.exit(1)
  }
  if (!saved) console.log(chalk.red(`⚠ 已改动内存，但落盘失败：${assistantScenes.lastSaveError}`))
  else console.log(chalk.green('✓ 完成'))
}

sceneCmd
  .command('list')
  .description('列出所有场景')
  .option('--json', 'JSON 输出')
  .action((opts) => {
    const scenes = assistantScenes.list()
    if (opts.json) {
      console.log(JSON.stringify({ success: true, total: scenes.length, scenes }))
      return
    }
    if (!scenes.length) {
      console.log(chalk.gray('还没有场景。加一个：'))
      console.log(chalk.gray('  weflow-cli scene add --id 日报 --keywords 日报,推文 --instruction "按主题分组" --dry-run'))
      return
    }
    for (const s of scenes) {
      console.log(`${s.enabled ? chalk.cyan(s.id) : chalk.gray(s.id + ' [已停用]')}  ${s.name}`)
      if (s.keywords.length) console.log(chalk.gray(`    关键词：${s.keywords.join('、')}`))
      if (s.instruction) console.log(chalk.gray(`    ${s.instruction.split('\n')[0].slice(0, 80)}`))
    }
  })

sceneCmd
  .command('show')
  .argument('<id>', '场景 id')
  .description('打印一个场景的全部字段')
  .option('--json', 'JSON 输出')
  .action((id, opts) => {
    const scene = assistantScenes.get(id)
    if (!scene) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'SCENE_NOT_FOUND', error: `没有场景「${id}」` }))
      else console.log(chalk.red(`没有场景「${id}」`))
      process.exit(1)
    }
    if (opts.json) {
      console.log(JSON.stringify({ success: true, scene }))
      return
    }
    console.log(`id        ${scene.id}`)
    console.log(`名称      ${scene.name}`)
    console.log(`状态      ${scene.enabled ? '启用' : '已停用'}`)
    console.log(`关键词    ${scene.keywords.join('、') || '（无）'}`)
    console.log(`所需技能  ${scene.skills.join('、') || '（无）'}`)
    console.log(`附加指令  ${scene.instruction || '（无）'}`)
    if (scene.outputSpec) console.log(`输出规范  ${scene.outputSpec}`)
  })

sceneCmd
  .command('add')
  .description('新增一个场景')
  .requiredOption('--id <id>', '场景 id（字母数字开头，可用 . _ -）')
  .option('--name <name>', '显示名（默认用 id）')
  .option('--keywords <list>', '关键词，逗号分隔')
  .option('--instruction <text>', '附加指令（长文本用 --from-file）')
  .option('--from-file <path>', '从文件读附加指令（多行中文走这条）')
  .option('--output-spec <text>', '输出规范')
  .option('--skills <list>', '所需技能 id，逗号分隔')
  .option('--dry-run', '仅预览，不写入')
  .option('--yes', '确认写入')
  .option('--json', 'JSON 输出')
  .action(async (opts) => {
    const id = String(opts.id || '').trim()
    const idError = validateSceneId(id)
    if (idError) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_SCENE_ID', error: idError }))
      else console.log(chalk.red(idError))
      process.exit(1)
    }
    let instruction = String(opts.instruction || '')
    if (opts.fromFile) {
      const path = String(opts.fromFile)
      if (!existsSync(path)) {
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'FILE_NOT_FOUND', error: `读不到 ${path}` }))
        else console.log(chalk.red(`读不到 ${path}`))
        process.exit(1)
      }
      instruction = readFileSync(path, 'utf8')
    }
    const splitList = (v: unknown): string[] => String(v || '').split(/[,;]/).map(s => s.trim()).filter(Boolean)
    const scene: Scene = {
      id,
      name: String(opts.name || '').trim() || id,
      keywords: splitList(opts.keywords),
      instruction,
      outputSpec: String(opts.outputSpec || ''),
      skills: splitList(opts.skills),
      enabled: true,
    }
    await confirmSceneWrite(opts, { action: 'scene.add', scene: { ...scene, instruction: `(${instruction.length} 字)` } },
      `确认新增场景「${scene.name}」？`, () => assistantScenes.add(scene))
  })

sceneCmd
  .command('remove')
  .argument('<id>', '场景 id')
  .description('删除一个场景（连同指向它的绑定）')
  .option('--dry-run', '仅预览，不删除')
  .option('--yes', '确认删除')
  .option('--json', 'JSON 输出')
  .action(async (id, opts) => {
    const scene = assistantScenes.get(id)
    if (!scene) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'SCENE_NOT_FOUND', error: `没有场景「${id}」` }))
      else console.log(chalk.red(`没有场景「${id}」`))
      process.exit(1)
    }
    await confirmSceneWrite(opts, { action: 'scene.remove', id }, `确认删除场景「${scene.name}」？`,
      () => { assistantScenes.remove(id); return { ok: true } })
  })

const toggleScene = (on: boolean) => async (id: string, opts: { dryRun?: boolean; yes?: boolean; json?: boolean }) => {
  const scene = assistantScenes.get(id)
  if (!scene) {
    if (opts.json) console.log(JSON.stringify({ success: false, code: 'SCENE_NOT_FOUND', error: `没有场景「${id}」` }))
    else console.log(chalk.red(`没有场景「${id}」`))
    process.exit(1)
  }
  await confirmSceneWrite(opts, { action: on ? 'scene.enable' : 'scene.disable', id },
    `确认${on ? '启用' : '停用'}场景「${scene.name}」？`,
    () => ({ ok: assistantScenes.setEnabled(id, on) }))
}

sceneCmd.command('enable')
  .argument('<id>', '场景 id')
  .description('启用一个场景')
  .option('--dry-run', '仅预览').option('--yes', '确认').option('--json', 'JSON 输出')
  .action(toggleScene(true))

sceneCmd.command('disable')
  .argument('<id>', '场景 id')
  .description('停用一个场景（它不再参与匹配）')
  .option('--dry-run', '仅预览').option('--yes', '确认').option('--json', 'JSON 输出')
  .action(toggleScene(false))

sceneCmd
  .command('bind')
  .argument('<conversation>', '会话 id（微信里就是 conversationId；本机面板用它的记忆桶）')
  .requiredOption('--scene <id>', '要绑定的场景 id')
  .description('把某个场景固定绑到一个会话')
  .option('--dry-run', '仅预览').option('--yes', '确认').option('--json', 'JSON 输出')
  .action(async (conversation, opts) => {
    const id = String(opts.scene || '').trim()
    await confirmSceneWrite(opts, { action: 'scene.bind', conversation, scene: id },
      `确认把场景「${id}」绑到会话 ${conversation}？`,
      () => assistantScenes.bind(conversation, id))
  })

sceneCmd
  .command('unbind')
  .argument('<conversation>', '会话 id')
  .description('解绑：这个会话回到按关键词自动挑')
  .option('--dry-run', '仅预览').option('--yes', '确认').option('--json', 'JSON 输出')
  .action(async (conversation, opts) => {
    await confirmSceneWrite(opts, { action: 'scene.unbind', conversation },
      `确认解绑会话 ${conversation}？`,
      () => assistantScenes.bind(conversation, null))
  })
}
