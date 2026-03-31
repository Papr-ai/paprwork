window.PaprCurlDraw = {
  render(ctx, side, t, W, H) {
    if (t <= 0) return;
    const left = side === 'left';
    const maxW = Math.max(220, W * 1.08);
    const foldW = 20 + maxW * t;
    const foldH = 18 + H * 0.96 * t;
    const edgeX = left ? Math.min(W, foldW) : Math.max(0, W - foldW);
    const edgeY = Math.min(H, foldH);
    const c1x = left ? edgeX * 0.68 : W - (W - edgeX) * 0.68;
    const c1y = edgeY * 0.16;
    const c2x = left ? edgeX * 0.24 : W - (W - edgeX) * 0.24;
    const c2y = edgeY * 0.82;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(edgeX, 0);
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, left ? 0 : W, edgeY);
    ctx.strokeStyle = `rgba(0,0,0,${0.22 + t * 0.3})`;
    ctx.lineWidth = 10 + t * 26;
    ctx.filter = `blur(${5 + t * 10}px)`;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    if (left) { ctx.moveTo(0, 0); ctx.lineTo(edgeX, 0); ctx.bezierCurveTo(c1x, c1y, c2x, c2y, 0, edgeY); }
    else { ctx.moveTo(W, 0); ctx.lineTo(edgeX, 0); ctx.bezierCurveTo(c1x, c1y, c2x, c2y, W, edgeY); }
    ctx.closePath();
    const g = left ? ctx.createLinearGradient(0, 0, edgeX, edgeY) : ctx.createLinearGradient(W, 0, edgeX, edgeY);
    g.addColorStop(0, 'rgba(0,128,255,0.22)');
    g.addColorStop(0.55, 'rgba(34,44,56,0.9)');
    g.addColorStop(1, 'rgba(10,12,16,0.98)');
    ctx.fillStyle = g;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(edgeX, 0);
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, left ? 0 : W, edgeY);
    ctx.strokeStyle = `rgba(255,255,255,${0.14 + t * 0.2})`;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }
};
