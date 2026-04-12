import { WebGPURenderer } from './WebGPURenderer';

let rendererInstance: WebGPURenderer | null = null;

export function getRenderer(): WebGPURenderer | null {
  return rendererInstance;
}

export function initRenderer(canvas: HTMLCanvasElement): WebGPURenderer {
  rendererInstance = new WebGPURenderer(canvas);
  return rendererInstance;
}
