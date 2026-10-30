export type ToolLongCopy = {
  subtitle: string;
  placeholder: string;
  tips: readonly string[];
};

/** English long copy for tool pages. Titles and action buttons live in the message catalog. */
export const TOOL_LONG_EN = {
  '/clip': {
    subtitle: 'Describe an idea in one sentence and it is cut into a finished video.',
    placeholder: 'For example: cut travel footage into a 30-second calming vlog with light music',
    tips: ['Match the rhythm', 'Smart subtitles', 'One-click transitions'],
  },
  '/scriptboard': {
    subtitle: 'Break a script into shots and build a storyboard step by step.',
    placeholder: 'Paste or type your script or story outline…',
    tips: ['Automatic shots', 'Shot descriptions', 'Frame previews'],
  },
  '/onestep': {
    subtitle: 'Enter a topic to finish the script, voiceover, visuals, and final video.',
    placeholder: 'For example: make a 60-second short introducing the first cup of milk tea in autumn',
    tips: ['Script writing', 'AI voiceover', 'Automatic edit'],
  },
  '/douyin': {
    subtitle: 'Study what makes a video spread, then write high-retention topics and scripts.',
    placeholder: 'Enter your channel niche, for example: restaurant visits / explainers',
    tips: ['Trending topics', 'The first 3 seconds', 'Completion-rate tuning'],
  },
  '/douyin-parse': {
    subtitle: 'Paste a Douyin share link to get the video without a watermark and its caption.',
    placeholder: 'Paste a Douyin share link, for example: https://v.douyin.com/xxxx',
    tips: ['Download without a watermark', 'Extract the caption', 'Break down the shots'],
  },
  '/lapan': {
    subtitle: 'Analyze the shot frame by frame: composition, light, and camera movement.',
    placeholder: 'Upload a file or paste a video link to start a frame-by-frame analysis',
    tips: ['Frame grabs', 'Composition notes', 'Camera-move breakdown'],
  },
  '/director': {
    subtitle: 'Preview camera placement, lighting, and blocking in 3D.',
    placeholder: 'Describe the scene and the camera blocking…',
    tips: ['3D camera setups', 'Lighting preview', 'Blocking rehearsal'],
  },
  '/script-ai': {
    subtitle: 'A script assistant from outline through scene breakdown.',
    placeholder: 'Describe the genre, characters, and style of your story…',
    tips: ['Story outline', 'Character bios', 'Scene dialogue'],
  },
  '/overseas-drama': {
    subtitle: 'A short-drama pipeline aimed at overseas markets.',
    placeholder: 'Enter the genre and target market, for example: Western / mystery / vertical video',
    tips: ['Multilingual voiceover', 'Localized adaptation', 'Vertical final cut'],
  },
  '/creator-plan': {
    subtitle: 'Join the creator program to earn credits and cash rewards.',
    placeholder: 'Submit your work or a social account…',
    tips: ['Exposure for your work', 'Credit rewards', 'A cash share'],
  },
} satisfies Record<string, ToolLongCopy>;
