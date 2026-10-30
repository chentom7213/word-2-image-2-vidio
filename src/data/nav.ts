import {
  Aperture,
  Activity,
  CreditCard,
  Clapperboard,
  Scissors,
  LayoutPanelTop,
  Wand2,
  Flame,
  Download,
  ScanSearch,
  Box,
  FileText,
  Library,
  Camera,
  FolderOpen,
  Globe,
  Users,
  PenTool,
  type LucideIcon,
} from 'lucide-react';

export type NavItem = {
  path: string;
  label: string;
  icon: LucideIcon;
  group?: string;
};

export const NAV_ITEMS: NavItem[] = [
  { path: '/canvas', label: '我的画布', icon: PenTool, group: '创作' },
  { path: '/image', label: '生图工作台', icon: Aperture, group: '创作' },
  { path: '/video', label: '视频创作台', icon: Clapperboard, group: '创作' },
  { path: '/clip', label: '想法剪视频', icon: Scissors, group: '创作' },
  { path: '/scriptboard', label: '分镜生成器', icon: LayoutPanelTop, group: '视频' },
  { path: '/onestep', label: '一键成片', icon: Wand2, group: '视频' },
  { path: '/douyin', label: '抖音爆款', icon: Flame, group: '视频' },
  { path: '/douyin-parse', label: '抖音解析', icon: Download, group: '视频' },
  { path: '/lapan', label: '逐帧拉片', icon: ScanSearch, group: '视频' },
  { path: '/director', label: '3D 导演台', icon: Box, group: '视频' },
  { path: '/script-ai', label: '剧本 AI', icon: FileText, group: '文本' },
  { path: '/prompts', label: '提示词库', icon: Library, group: '文本' },
  { path: '/cinematography', label: '镜头语言', icon: Camera, group: '文本' },
  { path: '/assets', label: '资产库', icon: FolderOpen, group: '资源' },
  { path: '/team', label: '团队与 API', icon: Users, group: '资源' },
  { path: '/billing', label: '套餐与充值', icon: CreditCard, group: '资源' },
  { path: '/admin', label: '运营看板', icon: Activity, group: '资源' },
  { path: '/overseas-drama', label: '海外短剧', icon: Globe, group: '资源' },
  { path: '/creator-plan', label: '创作者计划', icon: Users, group: '资源' },
];

export const GROUPS = ['创作', '视频', '文本', '资源'];

export function titleForPath(path: string) {
  const item = NAV_ITEMS.find((n) => n.path === path);
  return item?.label ?? '无限画布';
}
