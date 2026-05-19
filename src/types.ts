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
}

export interface BoxSide {
  id: string;
  layer: number;
  index: number; // 0 to numSides-1
  elements: GraphicElement[];
}

export interface BoxConfig {
  numLayers: number;
  numSides: number;
  baseColor: string;  // all outer surfaces (sides, lid top, base bottom)
  innerColor: string; // all inner surfaces (canvas bg, lid underside, base floor)
  size: number;
  openLevel: number;
}

export type AppMode = 'BOX_EDIT' | 'SIDE_EDIT';
