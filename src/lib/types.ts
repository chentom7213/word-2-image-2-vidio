export type AssetKind = 'image' | 'video' | 'audio';

export type Asset = {
  id: string;
  kind: AssetKind;
  name: string;
  url: string;
  size: number;
  createdAt?: number;
};

export type CanvasNode = {
  id: string;
  type: 'text' | 'image' | 'video';
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  seed?: string;
  assetId?: string | null;
};

export type CanvasViewport = { zoom: number; x: number; y: number };

export type CanvasDocument = {
  id: string;
  name: string;
  version: number;
  nodes: CanvasNode[];
  viewport: CanvasViewport;
  updatedAt: number;
};

export type GenerationStatus = 'queued' | 'running' | 'done' | 'failed';

/** A real artifact produced by the pipeline (signed URL, expires). */
export type GenerationOutput = {
  id: string;
  kind: 'image' | 'video' | 'poster' | 'sprite' | 'audio' | 'thumbnail';
  url: string;
  mime: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  bytes: number | null;
  watermarked: boolean;
};

export type Generation = {
  id: string;
  /** False when another member owns the task. */
  mine: boolean;
  /** Private by default; organization-shared work is read-only to members. */
  visibility: 'private' | 'org';
  type: 'image' | 'video';
  prompt: string;
  modelId: string;
  modelName: string;
  resolution: string;
  width: number;
  height: number;
  duration: number;
  /** number of results requested (image grid) */
  count: number;
  status: GenerationStatus;
  progress: number;
  createdAt: number;
  finishedAt: number | null;
  /** gradient seed used to render the fallback poster */
  seed: string;
  credits: number;
  error?: string;
  errorCode?: string | null;
  /** True when the task was refunded after failing. */
  refunded: boolean;
  /** Real generated files, in display order. */
  outputs: GenerationOutput[];
  posterUrl: string | null;
  refImages: Asset[];
  refVideos: Asset[];
  refAudios: Asset[];
};

export type ChatRole = 'user' | 'assistant';
export type ChatMessage = { id: string; role: ChatRole; content: string; pending?: boolean };

/** Model entry served by `GET /api/models`. */
export type ModelOption = {
  id: string;
  name: string;
  kind: 'image' | 'video';
  priceLabel: string;
  priceAmount: number;
  priceUnit: 'per_second' | 'per_call' | 'per_image';
  tag: string | null;
  refs: string[];
  durations: number[];
  provider: string;
  maxDuration: number | null;
};
