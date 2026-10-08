/** Browser side of the design export: the same Scene the editor draws with, driven frame by frame by the renderer. */
import { Scene, imagesReady } from './render';
import type { Design } from './schema';

interface InitArgs {
  design: Design;
  fonts: { family: string; weight: string; data: string }[];
  family: string;
  /** `assets/x.png` -> data: URL, read by the engine (the page itself is offline) */
  assets: Record<string, string>;
  transparent: boolean;
  scale: number;
}

let scene: Scene | null = null;
let doc: Design | null = null;

(window as any).designPage = {
  async init(a: InitArgs) {
    for (const f of a.fonts) {
      const bin = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      const face = new FontFace(f.family, bin.buffer, { weight: f.weight });
      await face.load(); // rejects on corrupt data: the export fails instead of substituting a font
      (document.fonts as unknown as { add(f: FontFace): void }).add(face);
    }
    await document.fonts.ready;
    document.documentElement.style.cssText = 'margin:0;background:transparent';
    const { width, height } = a.design.meta;
    document.body.style.cssText = `margin:0;overflow:hidden;width:${width * a.scale}px;height:${height * a.scale}px;position:relative;background:transparent`;
    const root = document.createElement('div');
    root.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;transform:scale(${a.scale});transform-origin:0 0`;
    document.body.appendChild(root);
    doc = a.design.meta.background === 'transparent' || !a.transparent ? a.design : { ...a.design, meta: { ...a.design.meta, background: 'transparent' } };
    scene = new Scene(root, { assetUrl: (src) => a.assets[src] ?? src, fontFamily: a.family });
    scene.update(doc, 0);
    const bad = await imagesReady(root);
    if (bad.length) throw new Error(`image did not load: ${bad.join(', ')}`);
    return { layers: a.design.layers.length };
  },
  render(tMs: number) {
    scene!.update(doc!, tMs);
  },
};
