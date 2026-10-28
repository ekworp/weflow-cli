// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { join } from 'path'
import { configService } from '../../services/configService.js'

export function registerConfig(program: Command): void {

// ==================== config ====================
const configCmd = program
  .command('config')
  .description('查看或修改配置')

const configurableKeys = [
  'dbPath', 'decryptKey', 'dbPath3x', 'decryptKey3x', 'dataVersion', 'wxid',
  'ntDbPath', 'ntKey', 'ntSalt', 'contactDbPath', 'contactKey', 'contactSalt',
  'vaultRepo', 'aiEngine', 'aiBaseUrl', 'aiModel', 'deepseekApiKey', 'typesafeApiKey',
  'dashscopeApiKey', 'favPassphrase',
  'judgeProvider', 'openrouterApiKey', 'openrouterJudgeModel', 'judgeLocalUrl',
  'wereadApiKey',
  'assistantPrivacy', 'assistantWhitelist', 'assistantGroupWhitelist',
  'assistantGroupRequireMention', 'assistantFastRoute', 'assistantPanelUser', 'quickReplyContacts',
  'skillDirs', 'skillDisabled',
  'dailySources', 'dailySourceCategories',
  'dailyExcludeTopics', 'dailyAiEnabled', 'dailyMailTo',
  'wechatMediaDownload',
  'emoticonSeed',
] as const

function setConfigValue(key: string, value: string, quiet = false): void {
  if (!configurableKeys.includes(key as typeof configurableKeys[number])) {
    console.log(chalk.red(`无效的配置项: ${key}`))
    console.log(chalk.gray(`可用: ${configurableKeys.join(', ')}`))
    process.exit(1)
  }
  const configValue = key === 'dailySourceCategories' && value.startsWith('base64:')
    ? Buffer.from(value.slice('base64:'.length), 'base64').toString('utf8')
    : value
  configService.set(key as any, configValue)
  if (!quiet) console.log(chalk.green(`✓ 已设置 ${key}`))
}

function ensureConfigurableKey(key: string, json: boolean): void {
  if (configurableKeys.includes(key as typeof configurableKeys[number])) return
  if (json) console.log(JSON.stringify({ success: false, code: 'INVALID_CONFIG_KEY', error: '配置项不可写', key }))
  else {
    console.log(chalk.red(`无效的配置项: ${key}`))
    console.log(chalk.gray(`可用: ${configurableKeys.join(', ')}`))
  }
  process.exit(1)
}

configCmd
  .command('show')
  .description('显示当前配置')
  .option('--json', '输出脱敏 JSON，不返回路径、账号或密钥')
  .action((opts) => {
    const config = configService.getAll()
    if (opts.json) {
      let sourceCategoryCount = 0
      try {
        const categories = JSON.parse(String(configService.get('dailySourceCategories') || '{}'))
        sourceCategoryCount = categories && typeof categories === 'object' && !Array.isArray(categories)
          ? Object.keys(categories).length
          : 0
      } catch {}
      const dailySources = String(configService.get('dailySources') || '')
        .split(/[,;\n]+/)
        .map(value => value.trim())
        .filter(Boolean)
      console.log(JSON.stringify({
        success: true,
        schema: 'weflow-config-status/v1',
        initialized: configService.isConfigured(),
        dataVersion: config.dataVersion || null,
        databases: {
          legacyConfigured: !!config.dbPath3x && !!config.decryptKey3x,
          messageConfigured: !!config.ntDbPath && !!config.ntKey,
          contactsConfigured: !!config.contactDbPath && !!config.contactKey,
          momentsConfigured: !!configService.get('snsDbPath') && !!configService.get('snsKey'),
          favoritesConfigured: !!configService.get('favDbPath') && (!!configService.get('favKey') || !!configService.get('favPassphrase')),
        },
        ai: {
          engine: configService.get('aiEngine') || 'deepseek',
          configured: ['ollama', 'lmstudio'].includes(String(configService.get('aiEngine') || 'deepseek')) || !!configService.get('deepseekApiKey'),
          dailyEnabled: configService.get('dailyAiEnabled') !== 'false',
        },
        daily: {
          restrictedSources: dailySources.length > 0,
          sourceCount: dailySources.length,
          categorizedSourceCount: sourceCategoryCount,
        },
        assistant: {
          privacyMode: configService.get('assistantPrivacy') || 'strict',
          directWhitelistConfigured: !!String(configService.get('assistantWhitelist') || '').trim(),
          groupWhitelistConfigured: !!String(configService.get('assistantGroupWhitelist') || '').trim(),
          groupMentionRequired: configService.get('assistantGroupRequireMention') !== 'false',
        },
      }, null, 2))
      return
    }
    console.log(chalk.cyan('当前配置:\n'))
    console.log(`数据版本: ${config.dataVersion || chalk.gray('(自动检测)')}`)
    console.log(`4.x 数据目录: ${config.dbPath || chalk.gray('(未设置)')}`)
    console.log(`4.x 密钥: ${config.decryptKey ? '已设置' : chalk.gray('(未设置)')}`)
    console.log(`3.x 数据库: ${config.dbPath3x || chalk.gray('(未设置)')}`)
    console.log(`3.x 密钥: ${config.decryptKey3x ? '已设置' : chalk.gray('(未设置)')}`)
    console.log(`NT 数据库: ${config.ntDbPath || chalk.gray('(未设置)')}`)
    console.log(`NT 密钥: ${config.ntKey ? '已设置' : chalk.gray('(未设置)')}`)
    console.log(`联系人DB: ${config.contactDbPath || chalk.gray('(未设置)')}`)
    console.log(`联系人DB密钥: ${config.contactKey ? '已设置' : chalk.gray('(未设置)')}`)
    console.log(`微信账号: ${config.wxid || chalk.gray('(未设置)')}`)
    console.log(`公众号日报来源: ${configService.get('dailySources') || chalk.gray('(全部公众号)')}`)
    console.log(`公众号日报 AI: ${configService.get('dailyAiEnabled') === 'false' ? '已关闭' : '已开启'}`)
    console.log(`公众号日报排除主题: ${configService.get('dailyExcludeTopics') || chalk.gray('(不排除)')}`)
  })

configCmd
  .command('set <key> <value>')
  .description('设置配置项')
  .option('--dry-run', '仅预览，不修改配置')
  .option('--yes', '确认执行')
  .option('--json', '输出 JSON 格式，不返回配置值')
  .action((key: string, value: string, opts) => {
    ensureConfigurableKey(key, !!opts.json)
    const preview = { action: 'config.set', key, source: 'argument' }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify({ success: true, dryRun: true, ...preview }))
      else console.log(chalk.cyan(`将设置配置项 ${key}`))
      return
    }
    if (opts.json && !opts.yes) {
      console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认修改配置', ...preview }))
      process.exit(1)
    }
    setConfigValue(key, value, !!opts.json)
    if (opts.json) console.log(JSON.stringify({ success: true, changed: true, ...preview }))
  })

configCmd
  .command('set-env <key> <environment>')
  .description('从环境变量读取值并保存，避免秘密出现在命令参数中')
  .option('--dry-run', '仅预览，不修改配置')
  .option('--yes', '确认执行')
  .option('--json', '输出 JSON 格式，不返回环境变量值')
  .action((key: string, environment: string, opts) => {
    ensureConfigurableKey(key, !!opts.json)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environment)) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_ENVIRONMENT_NAME', error: '环境变量名称无效' }))
      else console.log(chalk.red('环境变量名称无效'))
      process.exit(1)
    }
    const value = process.env[environment]
    if (!value) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'ENVIRONMENT_VALUE_MISSING', error: `环境变量 ${environment} 未设置或为空` }))
      else console.log(chalk.red(`环境变量 ${environment} 未设置或为空`))
      process.exit(1)
    }
    const preview = { action: 'config.set-env', key, environment }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify({ success: true, dryRun: true, ...preview }))
      else console.log(chalk.cyan(`将从环境变量 ${environment} 设置配置项 ${key}`))
      return
    }
    if (opts.json && !opts.yes) {
      console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认修改配置', ...preview }))
      process.exit(1)
    }
    setConfigValue(key, value, !!opts.json)
    if (opts.json) console.log(JSON.stringify({ success: true, changed: true, ...preview }))
  })

configCmd
  .command('clear')
  .description('清除所有配置')
  .option('--dry-run', '仅预览，不清除配置')
  .option('--yes', '确认清除全部配置')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    if (opts.dryRun) {
      const preview = { success: true, dryRun: true, action: 'config.clear', hasConfiguration: Object.keys(configService.getAll()).length > 0 }
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan('配置清除预览：将删除数据库访问、AI、日报、访问控制和助手设置。'))
      return
    }
    if (!opts.yes) {
      if (opts.json) {
        console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认清除全部配置' }))
        process.exit(1)
      }
      const { confirmed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: '将清除数据库访问、AI、日报、白名单和机器人等全部配置。继续吗？',
        default: false,
      }])
      if (!confirmed) {
        console.log(chalk.gray('已取消，未修改配置。'))
        return
      }
    }
    configService.clear()
    if (opts.json) {
      console.log(JSON.stringify({ success: true, action: 'config.clear' }))
      return
    }
    console.log(chalk.green('✓ 配置已清除'))
  })

configCmd
  .command('forget-keys')
  .description('仅清除本机数据库访问密钥，用于重新初始化测试')
  .option('--dry-run', '仅预览，不清除数据库访问密钥')
  .option('--yes', '跳过确认')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    if (opts.dryRun) {
      const preview = { success: true, dryRun: true, action: 'config.forget-keys', preservesNonDatabaseSettings: true }
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan('数据库密钥清除预览：保留数据目录、AI、日报、访问控制和助手设置。'))
      return
    }
    if (!opts.yes) {
      if (opts.json) {
        console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认清除数据库访问密钥' }))
        process.exit(1)
      }
      const { confirmed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: '清除数据库访问密钥后，聊天读取会暂时不可用。继续吗？',
        default: false,
      }])
      if (!confirmed) {
        console.log(chalk.gray('已取消，未修改配置。'))
        return
      }
    }

    configService.clearDatabaseKeys()
    if (opts.json) {
      console.log(JSON.stringify({ success: true, action: 'config.forget-keys' }))
      return
    }
    console.log(chalk.green('✓ 已清除数据库访问密钥。'))
    console.log(chalk.gray('  数据目录、AI、日报、白名单和机器人设置均已保留。'))
    console.log(chalk.gray('  现在可运行 weflow-cli init 测试首次初始化流程。'))
  })
}
