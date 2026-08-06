/**
 * Public demo sandbox — a hardcoded share id that behaves like a real ?share=
 * link but is 100% client-built and never touches the real backend. Kept in
 * its own file (no fetch calls at all) so "does the demo ever hit the server"
 * is a one-glance answer, not something buried in shareSystem.ts's network code.
 */
import { v4 as uuidv4 } from 'uuid';
import { BoxConfig, BoxSide, GraphicElement } from '../types';
import { getShareId } from './shareSystem';

// Public, memorable — box.56moments.store/?share=test. Real share ids are
// always crypto.randomBytes(12).toString('base64url') (16 chars from the
// server), so "test" can never collide with a real paid one.
export const DEMO_SHARE_ID = 'test';

export function isDemoShareId(id: string | null | undefined): boolean {
  return id === DEMO_SHARE_ID;
}

export function isDemoRouteActive(): boolean {
  return isDemoShareId(getShareId());
}

export const DEMO_EDIT_DAYS = 5;

/** Pure, network-free showcase content — text styling, a photo, a sticker,
 *  a non-default color/layer/side count, and a non-default floating shape. */
export function buildDemoContent(): { config: BoxConfig; sides: BoxSide[] } {
  const config: BoxConfig = {
    numLayers: 2,
    numSides: 4,
    baseColor: '#8b5cf6',
    innerColor: '#fdf2f8',
    size: 3,
    openLevel: 0,
    floatingShape: 'rose',
  };

  const el = (partial: Partial<GraphicElement> & Pick<GraphicElement, 'type' | 'content'>): GraphicElement => ({
    id: uuidv4(),
    x: 50, y: 50, scale: 1, rotation: 0, color: '#ffffff', fontSize: 24,
    ...partial,
  });

  const side = (layer: number, index: number, elements: GraphicElement[] = []): BoxSide => ({
    id: uuidv4(), layer, index, elements,
  });

  const sides: BoxSide[] = [
    side(0, 0, [
      el({ type: 'text', content: 'Happy Birthday!', color: '#ec4899', fontSize: 30, y: 42 }),
      el({ type: 'text', content: 'try editing me', color: '#ffffff', fontSize: 14, y: 62, scale: 0.9 }),
    ]),
    side(0, 1, [
      el({
        type: 'image',
        content: 'https://images.unsplash.com/photo-1490750967868-88aa4486c946?w=500&auto=format&fit=crop&q=60',
        scale: 0.85,
      }),
    ]),
    side(0, 2, [
      el({ type: 'sticker', content: 'sparkle', scale: 1.1 }),
      el({ type: 'sticker', content: 'heart', x: 32, y: 68, scale: 0.7 }),
    ]),
    side(0, 3, [
      el({ type: 'text', content: 'From: You', color: '#fde68a', fontSize: 22 }),
    ]),
    side(0, -1),
    side(1, 0, [
      el({ type: 'text', content: 'This is a demo', color: '#a78bfa', fontSize: 18, y: 45 }),
      el({ type: 'text', content: 'nothing here is saved', color: '#ffffff', fontSize: 12, y: 60, scale: 0.85 }),
    ]),
    side(1, 1),
    side(1, 2),
    side(1, 3),
    side(1, -1),
  ];

  return { config, sides };
}

/** Fresh countdown every visit — resets along with the rest of the demo on reload. */
export function getDemoEditUntil(): string {
  return new Date(Date.now() + DEMO_EDIT_DAYS * 864e5).toISOString();
}
