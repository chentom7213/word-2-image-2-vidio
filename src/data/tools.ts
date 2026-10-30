import type { MessageKey } from '../lib/i18n';
import { TOOL_LONG_EN } from './tools.en';

export type ToolConfig = {
  path: string;
  title: string;
  subtitle: string;
  placeholder: string;
  action: string;
  inputType?: 'text' | 'url' | 'file';
  tips?: string[];
};

export const TOOL_CONFIG = {
  '/clip': {
    path: '/clip',
    title: '想法剪视频',
    subtitle: '用一句话描述你的想法，自动剪辑成片',
    placeholder: '例如：把旅行素材剪成 30 秒的治愈系 Vlog，配轻音乐',
    action: '开始智能剪辑',
    tips: ['自动匹配节奏', '智能字幕', '一键转场'],
  },
  '/scriptboard': {
    path: '/scriptboard',
    title: '分镜生成器',
    subtitle: '把剧本拆成镜头，逐步生成故事板',
    placeholder: '粘贴或输入你的剧本 / 故事梗概…',
    action: '生成分镜',
    tips: ['自动分镜', '镜头描述', '画面预览'],
  },
  '/onestep': {
    path: '/onestep',
    title: '一键成片',
    subtitle: '输入主题，自动完成脚本、配音、画面与成片',
    placeholder: '例如：制作一条介绍「秋天的第一杯奶茶」的 60 秒短视频',
    action: '一键生成',
    tips: ['脚本创作', 'AI 配音', '自动成片'],
  },
  '/douyin': {
    path: '/douyin',
    title: '抖音爆款',
    subtitle: '分析爆款逻辑，生成高完播率选题与脚本',
    placeholder: '输入你的账号赛道，例如：美食探店 / 知识科普',
    action: '生成爆款脚本',
    tips: ['热点选题', '黄金 3 秒', '完播率优化'],
  },
  '/douyin-parse': {
    path: '/douyin-parse',
    title: '抖音解析',
    subtitle: '粘贴抖音分享链接，解析无水印视频与文案',
    placeholder: '粘贴抖音分享链接，例如：https://v.douyin.com/xxxx',
    action: '解析链接',
    inputType: 'url',
    tips: ['无水印下载', '提取文案', '拆解分镜'],
  },
  '/lapan': {
    path: '/lapan',
    title: '逐帧拉片',
    subtitle: '逐帧分析镜头语言，拆解构图、光线与运镜',
    placeholder: '上传或粘贴视频链接，开始逐帧分析',
    action: '开始拉片',
    inputType: 'file',
    tips: ['逐帧截图', '构图分析', '运镜拆解'],
  },
  '/director': {
    path: '/director',
    title: '3D 导演台',
    subtitle: '在 3D 空间中预览机位、灯光与走位',
    placeholder: '描述你的场景与机位调度…',
    action: '搭建场景',
    tips: ['3D 机位', '灯光模拟', '走位预演'],
  },
  '/script-ai': {
    path: '/script-ai',
    title: '剧本 AI',
    subtitle: '专业剧本创作助手，从大纲到分场',
    placeholder: '描述你的故事题材、人物与风格…',
    action: '生成剧本',
    tips: ['故事大纲', '人物小传', '分场对白'],
  },
  '/overseas-drama': {
    path: '/overseas-drama',
    title: '海外短剧',
    subtitle: '面向海外市场的短剧生产流水线',
    placeholder: '输入题材与目标市场，例如：欧美 / 悬疑 / 竖屏',
    action: '生成短剧方案',
    tips: ['多语言配音', '本地化改编', '竖屏成片'],
  },
  '/creator-plan': {
    path: '/creator-plan',
    title: '创作者计划',
    subtitle: '加入创作者计划，赚取积分与现金奖励',
    placeholder: '提交你的作品或自媒体账号…',
    action: '申请加入',
    tips: ['作品曝光', '积分奖励', '现金分成'],
  },
} satisfies Record<string, ToolConfig>;

export type ToolPath = keyof typeof TOOL_CONFIG;

export const TOOL_TITLE_KEY = {
  '/clip': 'tool_clip_title',
  '/scriptboard': 'tool_scriptboard_title',
  '/onestep': 'tool_onestep_title',
  '/douyin': 'tool_douyin_title',
  '/douyin-parse': 'tool_douyin_parse_title',
  '/lapan': 'tool_lapan_title',
  '/director': 'tool_director_title',
  '/script-ai': 'tool_script_ai_title',
  '/overseas-drama': 'tool_overseas_title',
  '/creator-plan': 'tool_creator_title',
} as const satisfies Record<ToolPath, MessageKey>;

export const TOOL_ACTION_KEY = {
  '/clip': 'tool_clip_action',
  '/scriptboard': 'tool_scriptboard_action',
  '/onestep': 'tool_onestep_action',
  '/douyin': 'tool_douyin_action',
  '/douyin-parse': 'tool_douyin_parse_action',
  '/lapan': 'tool_lapan_action',
  '/director': 'tool_director_action',
  '/script-ai': 'tool_script_ai_action',
  '/overseas-drama': 'tool_overseas_action',
  '/creator-plan': 'tool_creator_action',
} as const satisfies Record<ToolPath, MessageKey>;

type ToolLongCopyMatch = [
  Exclude<ToolPath, keyof typeof TOOL_LONG_EN> | Exclude<keyof typeof TOOL_LONG_EN, ToolPath>,
] extends [never]
  ? true
  : never;

const toolLongCopyMatch: ToolLongCopyMatch = true;
void toolLongCopyMatch;
