// Emit a drive.js plan that paints a cat with brush strokes. Usage:
//   bun spikes/computer-use/cat-plan.js <app> "<window geometry>" <canvasX> <canvasY> <brushX> <brushY> [<colorX> <colorY>] > plan.json
// Canvas origin is the top-left of the paint canvas in screen points; the cat spans about 460×340.
const [app, window, cx, cy, brushX, brushY, colorX, colorY] = process.argv.slice(2);
const origin = { x: Number(cx), y: Number(cy) };
const at = (x, y) => [Math.round(origin.x + x), Math.round(origin.y + y)];
const steps = [{ note: 'select the brush' }, { click: [Number(brushX), Number(brushY)], after: 300 }];
/** Consecutive drags along a polyline; each stroke starts where the last one ended. */
const polyline = (points, close = false) => {
  const list = close ? [...points, points[0]] : points;
  for (let i = 1; i < list.length; i += 1) steps.push({ drag: [at(...list[i - 1]), at(...list[i])], after: 60 });
};
const circle = (x, y, r, segments = 24, from = 0, to = Math.PI * 2) => Array.from({ length: segments + 1 }, (_, i) => { const a = from + (to - from) * i / segments; return [x + Math.cos(a) * r, y + Math.sin(a) * r]; });

const head = { x: 340, y: 200, r: 105 };
steps.push({ note: 'head' });
polyline(circle(head.x, head.y, head.r, 28), true);
steps.push({ note: 'ears' });
polyline([[head.x - 78, head.y - 70], [head.x - 95, head.y - 150], [head.x - 25, head.y - 102]]);
polyline([[head.x + 78, head.y - 70], [head.x + 95, head.y - 150], [head.x + 25, head.y - 102]]);
steps.push({ note: 'eyes' });
polyline(circle(head.x - 40, head.y - 15, 13, 12), true);
polyline(circle(head.x + 40, head.y - 15, 13, 12), true);
steps.push({ note: 'nose and mouth' });
polyline([[head.x - 12, head.y + 22], [head.x + 12, head.y + 22], [head.x, head.y + 38]], true);
polyline(circle(head.x - 22, head.y + 38, 22, 6, 0, Math.PI * 0.95));
polyline(circle(head.x + 22, head.y + 38, 22, 6, Math.PI * 0.05, Math.PI));
steps.push({ note: 'whiskers' });
for (const side of [-1, 1]) for (const dy of [-6, 8, 22]) polyline([[head.x + side * 55, head.y + 30 + dy], [head.x + side * 150, head.y + 18 + dy * 2.2]]);
if (colorX) {
  steps.push({ note: 'colour the nose' }, { click: [Number(colorX), Number(colorY)], after: 300 });
  polyline([[head.x - 6, head.y + 26], [head.x + 6, head.y + 26]]);
  polyline([[head.x - 3, head.y + 31], [head.x + 3, head.y + 31]]);
}
console.log(JSON.stringify({ app, window, steps }));
