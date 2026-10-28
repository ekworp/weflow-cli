#!/usr/bin/env node
import chalk from 'chalk'
import { buildProgram } from '../src/cli/program.js'
import { showInteractiveMenu } from '../src/cli/menu.js'

const program = buildProgram()

// 检测是否无参数启动（显示交互式菜单）
const cliArgs = process.argv.slice(2)
if (cliArgs.length === 0) {
  showInteractiveMenu(program).catch((e) => {
    console.error(chalk.red(`\n错误: ${e.message}`))
    process.exit(1)
  })
} else {
  program.parse()
}
