export interface GraphicElement {
  id: string;
  type: 'text' | 'image' | 'sticker';
  content: string; // text string or image URL
  x: number; // percentage 0-100
  y: number; // percentage 0-100
  scale: number;
  rotation: number;
  color?: string;
  fontSize?: number;
  /** Actual editor canvas size (px) when element was placed — used for consistent
   *  texture scaling across devices with different screen sizes. */
  designCanvasSize?: number;
  /** Stored byte size of a server-uploaded image/video, for accurate mediaBytes
   *  accounting on delete. Absent for text/sticker elements and external URLs
   *  (e.g. GIPHY GIFs) that were never uploaded to our own storage. */
  bytes?: number;
  /** True only for actual video content. Needed because blob: URLs (local
   *  fallback for photos/videos) carry no file-extension info to sniff type
   *  from — without this flag, a photo stored as a blob: URL would otherwise
   *  be indistinguishable from a video one and get rendered as one. */
  isVideo?: boolean;
}

export interface BoxSide {
  id: string;
  layer: number;
  index: number; // 0 to numSides-1
  elements: GraphicElement[];
}

export type FloatingShape = 'heart' | 'cake' | 'rose';

export interface BoxConfig {
  numLayers: number;
  numSides: number;
  baseColor: string;  // all outer surfaces (sides, lid top, base bottom)
  innerColor: string; // all inner surfaces (canvas bg, lid underside, base floor)
  size: number;
  openLevel: number;
  /** Decorative shape that floats up once the box is fully exploded. Defaults
   *  to 'heart' when absent so existing saved boxes render unchanged. */
  floatingShape?: FloatingShape;
}

export type AppMode = 'BOX_EDIT' | 'SIDE_EDIT';
