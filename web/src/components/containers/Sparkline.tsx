import { Component, onMount, createEffect } from "solid-js";

// ponytail: tiny canvas line chart instead of a chart lib; upgrade to a real
// charting dep only if multi-series/axes are needed.
export const Sparkline: Component<{ data: number[]; max?: number; color?: string }> = (props) => {
  let canvas!: HTMLCanvasElement;
  const draw = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const data = props.data;
    if (data.length < 2) return;
    const max = props.max ?? Math.max(...data, 1);
    ctx.strokeStyle = props.color ?? "#60a5fa";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - (v / max) * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  onMount(draw);
  createEffect(() => { props.data; draw(); });
  return <canvas ref={canvas} width="240" height="60" class="rounded bg-zinc-950" />;
};
