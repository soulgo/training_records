export const TELEGRAM_HELP_TEXT = [
  '当前可用命令：',
  '',
  '/help、/帮助 或 help：查看这份命令说明',
  '/随想 内容：记录锻炼随想',
  '/随想 杂七杂八 内容：记录杂项随想',
  '/随想 身体反馈 内容：记录疼痛、疲劳或恢复异常',
  '/随想编 id 内容：按 id 编辑随想',
  '/随想编 id 模块 内容：编辑并移动到指定模块',
  '/随想删 id：按 id 删除随想；回复原消息时可只发 /随想删',
  '/移动 id 模块：把随想移动到 锻炼 / 杂七杂八 / 身体反馈',
  '/分析 问题：基于训练、体脂、饮食和身体反馈生成训练建议',
  '/ai 问题：调用 MCP 工具查询历史、同步状态或综合分析',
  '',
  '图片：直接发送训练/饮食/体脂截图会自动识别；图片 caption 以 /随想 开头时会归档为带图随想。',
].join('\n');

export function isTelegramHelpText(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const trimmed = text.trim();
  return /^(?:\/(?:help|start|帮助)(?:@[A-Za-z0-9_]+)?|help|帮助|命令|指令|使用说明)$/iu.test(trimmed);
}
